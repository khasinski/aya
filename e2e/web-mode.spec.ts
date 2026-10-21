// Aya Web (experimental), the BROWSER leg.
//
// tests/web-server.test.mjs already drives the server side - login, cookie,
// static serving, and the raw WebSocket frame protocol. What had no coverage at
// all was the leg the README actually promises: "Serve the same UI over a local
// HTTP + WebSocket bridge and reconnect to the same live sessions from a
// browser". src/web/main.tsx, src/web/bridge.ts and src/web/transport.ts were
// exercised only as pure functions (shortcutForKey, parseServerFrame,
// encodeInvokeFrame), so a transport that never delivered would still pass.
//
// This spec runs a REAL chromium against the REAL built dist/ served by the real
// web server, and asserts on a value that can only have arrived through the
// bridge.
//
// Anti-facade guard: the project name is a per-run UUID. It exists in no bundle,
// no fixture and no stylesheet - grep the whole dist/ and you will not find it.
// If the WebSocket never connected, or the invoke frame never round-tripped, the
// name cannot be on screen. "The page rendered" is NOT the assertion.
//
// Scope boundary, stated so nobody reads more into a green run than it proves:
// the IPC registry here is stubbed the way tests/web-git-worktree.test.mjs does
// it, so this covers browser -> websocket -> invoke -> render. It does NOT cover
// a live Electron main process or real PTY sessions.

import { test, expect, chromium, type Browser } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ProjectCollectionState, WorkingTab } from "../src/types";

const PASSWORD = "web-mode-e2e-password";
const USER = "webtester";
const REPO_ROOT = join(__dirname, "..");

/** Unique per run: the anti-facade anchor. Only the bridge can put it on screen. */
const PROJECT_NAME = `aya-web-probe-${randomUUID().slice(0, 8)}`;

type ServerHandle = {
  port: number;
  broadcast: (channel: string, payload: unknown) => void;
  close: () => Promise<void>;
};

// A project that no longer exists and an empty recent list: the page's save drops the one and fills the other, so the
// file shows a save happened.
const STATE: ProjectCollectionState = {
  version: 1,
  order: ["web-probe", "gone-project"],
  open: ["web-probe", "gone-project"],
  recent: [],
  activeProject: "web-probe",
};

async function startServedApp(options: { tabs?: WorkingTab[] } = {}): Promise<{
  base: string;
  stateFile: string;
  invocations: Array<{ channel: string; args: unknown[] }>;
  broadcast: (channel: string, payload: unknown) => void;
  stop: () => Promise<void>;
}> {
  // The web server answers projects:state and projects:save-state from the projects-state.json of the AYA_HOME this
  // process loaded paths.ts with, not from the stubs below: playwright.config.ts gives the runner a throwaway one.
  const { PROJECTS_STATE_FILE } = await import("../dist-electron/paths.js");
  expect(PROJECTS_STATE_FILE.startsWith(`${process.env.AYA_HOME}/`), `state file outside the runner's AYA_HOME: ${PROJECTS_STATE_FILE}`).toBe(true);
  mkdirSync(dirname(PROJECTS_STATE_FILE), { recursive: true });
  writeFileSync(PROJECTS_STATE_FILE, JSON.stringify(STATE));
  const { startWebServer } = await import("../dist-electron/web-server.js");
  const { webCredentials } = await import("../dist-electron/web-config.js");
  const { captureIpcHandlers } = await import("../dist-electron/ipc/web-capture.js");

  // No Electron here, so ipcMain is a stub - the same seam tests/web-git-worktree
  // uses. The bridge reads whatever was captured.
  const stubIpcMain = { handle: () => {} } as unknown as Parameters<
    typeof captureIpcHandlers
  >[0];
  captureIpcHandlers(stubIpcMain);

  const projectDir = mkdtempSync(join(tmpdir(), "aya-web-proj-"));
  const project = {
    slug: "web-probe",
    name: PROJECT_NAME,
    directory: projectDir,
    tabs: options.tabs ?? [],
  };

  // App's boot awaits SEVEN channels in one Promise.all (App.tsx:1537-1544); a
  // single missing one rejects the whole thing and the app never leaves
  // "Opening Aya...". Found the hard way - the first run of this spec stubbed
  // four and hung on the loading screen.
  const handlers: Record<string, unknown> = {
    "env:cwd": projectDir,
    "env:home": projectDir,
    "env:git": { branch: "main", dirty: 0 },
    "projects:list": [project],
    "presets:list": [{ id: "shell", name: "Shell", icon: "$", color: "", command: "$SHELL" }],
    "themes:list": { themes: [], activeId: null },
    "snippets:list": [],
    // The boot validates every open project's directory before hydrating it;
    // an unstubbed check leaves the app on "No projects yet" even though the
    // bridge already delivered the project. Second thing found by running it.
    "env:dir-exists": true,
    // Boot seeds a shell tab into a tabless project and persists it; without
    // this the write path rejects after render.
    "projects:update": undefined,
  };
  const invocations: Array<{ channel: string; args: unknown[] }> = [];
  for (const [channel, value] of Object.entries(handlers)) {
    (stubIpcMain as unknown as { handle: (c: string, f: unknown) => void }).handle(
      channel,
      async (_event: unknown, ...args: unknown[]) => {
        invocations.push({ channel, args });
        return value;
      },
    );
  }
  for (const channel of ["pty:spawn", "pty:buffer", "pty:resize", "pty:write"]) {
    (stubIpcMain as unknown as { handle: (c: string, f: unknown) => void }).handle(
      channel,
      async (_event: unknown, ...args: unknown[]) => {
        invocations.push({ channel, args });
        return channel === "pty:buffer" ? { data: "", offset: 0, generation: "web-test" } : true;
      },
    );
  }

  const config = {
    enabled: true,
    port: 0,
    host: "127.0.0.1",
    user: USER,
    ...webCredentials(PASSWORD, false),
  };
  const handle: ServerHandle = await startWebServer({
    appVersion: "0.0.0-web-e2e",
    isDev: false,
    // The REAL built renderer, not a stub html - this is what makes it a
    // browser test rather than a protocol test.
    distDir: join(REPO_ROOT, "dist"),
    getConfig: () => config,
  });

  return {
    base: `http://127.0.0.1:${handle.port}`,
    stateFile: PROJECTS_STATE_FILE,
    invocations,
    broadcast: (channel, payload) => handle.broadcast(channel, payload),
    stop: async () => {
      await handle.close();
      rmSync(projectDir, { recursive: true, force: true });
    },
  };
}

test("a browser logs in, the bridge connects, and bridge-only data reaches the screen", async () => {
  const { base, stateFile, stop } = await startServedApp();
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();

    // 1. The real web entry point is served.
    await page.goto(base);

    // 2. Before auth the bridge cannot have delivered anything.
    await expect(page.locator("body")).not.toContainText(PROJECT_NAME);

    // 3. Authenticate the way the client does, then reload so the transport
    //    connects with the session cookie.
    const login = await page.request.post(`${base}/api/login`, {
      data: { user: USER, password: PASSWORD },
    });
    expect(login.ok()).toBeTruthy();
    await page.reload();

    // 4. The anti-facade assertion: this string exists in no bundled asset, so
    //    it can only be on screen if browser -> websocket -> invoke -> render
    //    completed end to end.
    await expect(page.locator("body")).toContainText(PROJECT_NAME, { timeout: 20_000 });

    // 5. The page saves the state it booted with into the runner's own AYA_HOME (never the real ~/.aya).
    await expect
      .poll(() => {
        const saved = JSON.parse(readFileSync(stateFile, "utf8")) as ProjectCollectionState;
        return { order: saved.order, open: saved.open, recent: saved.recent };
      })
      .toEqual({ order: ["web-probe"], open: ["web-probe"], recent: ["web-probe"] });
  } finally {
    await browser?.close();
    await stop();
  }
});

test("waiting panes show a selectable banner and update the web tab title", async () => {
  const { base, broadcast, stop } = await startServedApp({
    tabs: [
      { id: "web-first", presetId: "shell", name: "First pane" },
      { id: "web-waiting", presetId: "shell", name: "Review pane" },
    ],
  });
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.addInitScript(() => {
      type NotificationProbe = Window & {
        __permissionRequests?: number;
        __notificationConstructions?: number;
        __notificationPermission?: NotificationPermission;
        __showWaitingNotificationCalls?: number;
      };
      const probe = window as NotificationProbe;
      const NativeNotification = window.Notification;
      if (!NativeNotification) return;
      const fakeNotification = new Proxy(NativeNotification, {
        construct: () => {
          probe.__notificationConstructions = (probe.__notificationConstructions ?? 0) + 1;
          return { close: () => {}, onclick: null } as unknown as Notification;
        },
        get: (target, property) => {
          if (property === "permission") return probe.__notificationPermission ?? "default";
          if (property === "requestPermission") {
            return () => {
              probe.__permissionRequests = (probe.__permissionRequests ?? 0) + 1;
              return Promise.resolve("default");
            };
          }
          return Reflect.get(target, property, target);
        },
      });
      Object.defineProperty(window, "Notification", { configurable: true, value: fakeNotification });
    });
    await page.goto(base);
    const login = await page.request.post(`${base}/api/login`, {
      data: { user: USER, password: PASSWORD },
    });
    expect(login.ok()).toBeTruthy();
    await page.reload();
    await expect(page.getByTestId("sidebar-terminal")).toHaveCount(2, { timeout: 20_000 });
    await expect(page.locator("[data-testid='sidebar-terminal'].aya-sidebar-row--active")).toHaveAttribute(
      "data-terminal-id",
      "web-first",
    );
    await expect(page).toHaveTitle("Aya");
    expect(await page.evaluate(() => (window as Window & { __permissionRequests?: number }).__permissionRequests ?? 0)).toBe(0);

    // The browser adapter is called directly to pin the secure-context and
    // existing-grant checks, without opening a native permission prompt.
    await page.evaluate(() => window.aya.showWaitingNotification({
      projectSlug: "web-probe",
      terminalId: "web-waiting",
      body: "Review pane in Aya Web probe",
    }));
    expect(await page.evaluate(() => (window as Window & { __notificationConstructions?: number }).__notificationConstructions ?? 0)).toBe(0);
    await page.evaluate(() => {
      (window as Window & { __notificationPermission?: NotificationPermission }).__notificationPermission = "granted";
      Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
    });
    await page.evaluate(() => window.aya.showWaitingNotification({
      projectSlug: "web-probe",
      terminalId: "web-waiting",
      body: "Review pane in Aya Web probe",
    }));
    expect(await page.evaluate(() => (window as Window & { __notificationConstructions?: number }).__notificationConstructions ?? 0)).toBe(0);
    await page.evaluate(() => Object.defineProperty(window, "isSecureContext", { configurable: true, value: true }));
    await page.evaluate(() => window.aya.showWaitingNotification({
      projectSlug: "web-probe",
      terminalId: "web-waiting",
      body: "Review pane in Aya Web probe",
    }));
    expect(await page.evaluate(() => (window as Window & { __notificationConstructions?: number }).__notificationConstructions ?? 0)).toBe(1);
    expect(await page.evaluate(() => (window as Window & { __permissionRequests?: number }).__permissionRequests ?? 0)).toBe(0);
    await page.evaluate(() => {
      (window as Window & { __notificationPermission?: NotificationPermission }).__notificationPermission = "default";
      Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
      const target = window.aya;
      const original = target.showWaitingNotification.bind(target);
      const probe = window as Window & { __showWaitingNotificationCalls?: number };
      Object.defineProperty(target, "showWaitingNotification", {
        configurable: true,
        value: async (request: Parameters<typeof target.showWaitingNotification>[0]) => {
          probe.__showWaitingNotificationCalls = (probe.__showWaitingNotificationCalls ?? 0) + 1;
          return original(request);
        },
      });
    });
    await page.evaluate(() => {
      (window as Window & { __showWaitingNotificationCalls?: number }).__showWaitingNotificationCalls = 0;
    });

    const wait = {
      terminalId: "web-waiting",
      projectSlug: "web-probe",
      level: "waiting",
      text: "Approve access?",
      updatedAt: Date.now(),
    };
    broadcast("control:status", wait);
    broadcast("control:status", {
      terminalId: "web-first",
      projectSlug: "web-probe",
      level: "waiting",
      text: "First pane needs attention",
      updatedAt: Date.now(),
    });
    const banner = page.getByRole("button", { name: /Review pane is waiting in .* View pane/ });
    await expect(banner).toBeVisible();
    await expect(page).toHaveTitle("(2) Aya");
    await expect.poll(() => page.evaluate(() => (window as Window & { __showWaitingNotificationCalls?: number }).__showWaitingNotificationCalls ?? 0)).toBe(2);
    expect(await page.evaluate(() => (window as Window & { __notificationConstructions?: number }).__notificationConstructions ?? 0)).toBe(1);
    expect(await page.evaluate(() => (window as Window & { __permissionRequests?: number }).__permissionRequests ?? 0)).toBe(0);
    broadcast("control:status", { ...wait, text: "Approve access? again", updatedAt: wait.updatedAt + 1 });
    await expect(page.locator("body")).toContainText("Approve access? again");
    await expect(page.locator(".aya-web-waiting-banner")).toHaveCount(1);
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(banner).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    const bannerBounds = await banner.boundingBox();
    const paneStripBounds = await page.locator(".aya-sidebar").boundingBox();
    expect(bannerBounds && bannerBounds.height >= 44).toBeTruthy();
    expect(bannerBounds && paneStripBounds && bannerBounds.y >= paneStripBounds.y + paneStripBounds.height).toBeTruthy();
    await page.screenshot({
      path: "/tmp/aya-web-notifications-390x844.png",
      fullPage: false,
      style: ".aya-statusbar { visibility: hidden !important; }",
    });

    await banner.click();
    await expect(page.locator("[data-testid='sidebar-terminal'].aya-sidebar-row--active")).toHaveAttribute(
      "data-terminal-id",
      "web-waiting",
    );
    await expect(page.getByRole("button", { name: /First pane is waiting in .* View pane/ })).toBeVisible();
    await expect(page).toHaveTitle("(1) Aya");
    expect(await page.evaluate(() => (window as Window & { __permissionRequests?: number }).__permissionRequests ?? 0)).toBe(0);
    broadcast("control:status", {
      terminalId: "web-first",
      projectSlug: "web-probe",
      level: "clear",
      updatedAt: Date.now() + 2,
    });
    await expect(page.locator(".aya-web-waiting-banner")).toHaveCount(0);
    await expect(page).toHaveTitle("Aya");
  } finally {
    await browser?.close();
    await stop();
  }
});

for (const viewport of [
  { width: 390, height: 844 },
  { width: 360, height: 740 },
]) {
test(`mobile web layout fits ${viewport.width}x${viewport.height}`, async () => {
  const { base, invocations, stop } = await startServedApp({
    tabs: [
      { id: "mobile-one", presetId: "shell", name: "First pane" },
      { id: "mobile-two", presetId: "shell", name: "Second pane" },
    ],
  });
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport });
    await page.goto(base);
    const login = await page.request.post(`${base}/api/login`, {
      data: { user: USER, password: PASSWORD },
    });
    expect(login.ok()).toBeTruthy();
    await page.reload();
    await expect(page.getByTestId("sidebar-terminal").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".xterm-helper-textarea").first()).toBeAttached();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await expect.poll(() => page.evaluate(() => document.body.scrollWidth <= document.body.clientWidth)).toBe(true);
    await expect.poll(() => page.locator(".aya-pane").first().evaluate((pane) => Math.round(pane.getBoundingClientRect().width))).toBe(viewport.width);
    const rows = page.getByTestId("sidebar-terminal");
    await expect(rows).toHaveCount(2);
    await expect.poll(() => rows.first().evaluate((row) => Math.round(row.getBoundingClientRect().height))).toBeGreaterThanOrEqual(44);
    await expect.poll(() => page.locator(".aya-topbar .aya-iconbtn").first().evaluate((button) => {
      const rect = button.getBoundingClientRect();
      return rect.width >= 44 && rect.height >= 44;
    })).toBe(true);
    if (viewport.width === 390) {
      const more = page.getByRole("button", { name: "More actions" });
      await expect(more).toBeVisible();
      for (const action of ["Saved snippets", "Teams", "Activity"]) {
        await more.click();
        await page.getByRole("menu", { name: "More actions" }).getByRole("menuitem", { name: action }).click();
        if (action === "Saved snippets") {
          await expect(page.locator(".aya-snippetbar--open")).toBeVisible();
          await more.click();
          await page.getByRole("menu", { name: "More actions" }).getByRole("menuitem", { name: action }).click();
          await expect(page.locator(".aya-snippetbar--open")).toHaveCount(0);
        } else {
          const dialogName = action === "Teams" ? "Teams" : "Attention center";
          const dialog = page.getByRole("dialog", { name: dialogName });
          await expect(dialog).toBeVisible();
          await dialog.getByRole("button", { name: "Close" }).click();
          await expect(dialog).toBeHidden();
        }
      }
      const addPane = page.getByRole("button", { name: "New terminal" });
      await expect(addPane).toBeVisible();
      await addPane.click();
      const launcher = page.getByRole("menu", { name: "New terminal" });
      await expect(launcher).toBeVisible();
      await launcher.getByRole("menuitem", { name: "Shell" }).click();
      await expect(rows).toHaveCount(3);
    }
    await rows.nth(1).click();
    await expect(rows.nth(1)).toHaveClass(/aya-sidebar-row--active/);
    await page.locator(".xterm-helper-textarea").first().evaluate((element) => {
      (element as HTMLTextAreaElement).focus();
    });
    await page.keyboard.type("phone-input");
    await expect.poll(() => invocations
      .filter((call) => call.channel === "pty:write" && call.args[0] === "mobile-two")
      .map((call) => call.args[1])
      .join("")).toContain("phone-input");
    await expect(page.locator('[data-testid="terminal-pane"][data-terminal-id="mobile-two"] .aya-terminal-restoring')).toBeHidden({ timeout: 5_000 });
    await page.screenshot({ path: `/tmp/aya-web-mobile-after-${viewport.width}x${viewport.height}.png` });

    await page.getByRole("button", { name: "Settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    await expect.poll(() => settings.evaluate((dialog) => {
      const rect = dialog.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight;
    })).toBe(true);
    await page.keyboard.press("Escape");

    await page.locator('button[title="Show changes and publishing actions"]').click();
    const changes = page.getByRole("dialog", { name: "Changed files" });
    await expect(changes).toBeVisible();
    await expect.poll(() => changes.evaluate((dialog) => {
      const rect = dialog.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight;
    })).toBe(true);
    await page.keyboard.press("Escape");

    // Model a mobile keyboard: the layout viewport stays the same while the
    // visual viewport shrinks and pans below browser chrome/the keyboard.
    await page.evaluate(() => {
      const visible = window.visualViewport!;
      Object.defineProperty(visible, "height", { configurable: true, value: 320 });
      Object.defineProperty(visible, "offsetTop", { configurable: true, value: 32 });
      visible.dispatchEvent(new Event("resize"));
      visible.dispatchEvent(new Event("scroll"));
    });
    await expect.poll(() => page.locator(".aya-app").evaluate((app) => {
      const visible = window.visualViewport;
      return Math.round(app.getBoundingClientRect().height) === Math.round(visible?.height ?? window.innerHeight)
        && Math.round(app.getBoundingClientRect().top) === Math.round(visible?.offsetTop ?? 0)
        && getComputedStyle(document.documentElement).getPropertyValue("--aya-visual-top").trim() === "32px";
    })).toBe(true);
    await expect.poll(() => page.locator(".aya-pane").first().evaluate((pane) => {
      const visibleBottom = (window.visualViewport?.offsetTop ?? 0) + (window.visualViewport?.height ?? window.innerHeight);
      return pane.getBoundingClientRect().bottom <= visibleBottom;
    })).toBe(true);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  } finally {
    await browser?.close();
    await stop();
  }
});
}

test("desktop web layout keeps its sidebar columns", async () => {
  const { base, stop } = await startServedApp({
    tabs: [{ id: "desktop-one", presetId: "shell", name: "Desktop pane" }],
  });
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
    await page.goto(base);
    const login = await page.request.post(`${base}/api/login`, {
      data: { user: USER, password: PASSWORD },
    });
    expect(login.ok()).toBeTruthy();
    await page.reload();
    await expect(page.getByTestId("sidebar-terminal")).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => page.locator(".aya-sidebar").evaluate((sidebar) => Math.round(sidebar.getBoundingClientRect().width))).toBe(240);
    await expect.poll(() => page.locator(".aya-main").evaluate((main) => getComputedStyle(main).gridTemplateColumns)).toBe("240px 784px");
  } finally {
    await browser?.close();
    await stop();
  }
});

test("wrong credentials leave the bridge closed and the data off screen", async () => {
  const { base, stop } = await startServedApp();
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(base);

    const login = await page.request.post(`${base}/api/login`, {
      data: { user: USER, password: "definitely-not-the-password" },
    });
    expect(login.ok()).toBeFalsy();
    await page.reload();

    // The refusal branch: no session, so no bridge, so no bridge-only data.
    // This is the control that keeps the test above honest - if the assertion
    // there passed for some reason OTHER than the bridge, this one would fail.
    // Boot settled on the login screen: it only leaves that phase on a submit.
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expect(page.locator("body")).not.toContainText(PROJECT_NAME);
  } finally {
    await browser?.close();
    await stop();
  }
});
