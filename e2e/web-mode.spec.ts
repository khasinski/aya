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
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const PASSWORD = "web-mode-e2e-password";
const USER = "webtester";
const REPO_ROOT = join(__dirname, "..");

/** Unique per run: the anti-facade anchor. Only the bridge can put it on screen. */
const PROJECT_NAME = `aya-web-probe-${randomUUID().slice(0, 8)}`;

type ServerHandle = { port: number; close: () => Promise<void> };

async function startServedApp(): Promise<{ base: string; stop: () => Promise<void> }> {
  const { startWebServer } = await import("../dist-electron/web-server.js");
  const { webCredentials } = await import("../dist-electron/web-config.js");
  const { captureIpcHandlers } = await import("../dist-electron/web-ipc.js");

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
    tabs: [],
  };

  // App's boot awaits SEVEN channels in one Promise.all (App.tsx:1537-1544); a
  // single missing one rejects the whole thing and the app never leaves
  // "Opening Aya...". Found the hard way - the first run of this spec stubbed
  // four and hung on the loading screen.
  const handlers: Record<string, unknown> = {
    "env:cwd": projectDir,
    "env:home": projectDir,
    "projects:list": [project],
    "projects:state": { version: 1, openSlugs: ["web-probe"], activeSlug: "web-probe" },
    "presets:list": [{ id: "shell", name: "Shell", icon: "$", color: "", command: "$SHELL" }],
    "themes:list": { themes: [], activeId: null },
    "snippets:list": [],
    // The boot validates every open project's directory before hydrating it;
    // an unstubbed check leaves the app on "No projects yet" even though the
    // bridge already delivered the project. Second thing found by running it.
    "env:dir-exists": true,
    // Boot seeds a shell tab into a tabless project and persists it; without
    // these the write path rejects after render.
    "projects:update": undefined,
    "projects:save-state": undefined,
  };
  for (const [channel, value] of Object.entries(handlers)) {
    (stubIpcMain as unknown as { handle: (c: string, f: unknown) => void }).handle(
      channel,
      async () => value,
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
    stop: async () => {
      await handle.close();
      rmSync(projectDir, { recursive: true, force: true });
    },
  };
}

test("a browser logs in, the bridge connects, and bridge-only data reaches the screen", async () => {
  const { base, stop } = await startServedApp();
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
    await page.waitForTimeout(2_000);
    await expect(page.locator("body")).not.toContainText(PROJECT_NAME);
  } finally {
    await browser?.close();
    await stop();
  }
});
