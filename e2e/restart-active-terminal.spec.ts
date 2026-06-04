import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { join } from "node:path";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { seedEnv } from "./helpers/seed";

// Reproduces: after restart the FIRST terminal is selected, not the one that
// was active last. Two launches against the same AYA_HOME — switch to the
// second terminal, quit, relaunch, and check which terminal is shown.

const APP_ROOT = join(__dirname, "..");
const ACTIVE_TAB_PERSISTENCE_TIMEOUT_MS = 5_000;

function projectStatePath(ayaHome: string): string {
  return join(ayaHome, "projects-state.json");
}

function writeProjectState(ayaHome: string, state: unknown): void {
  writeFileSync(projectStatePath(ayaHome), JSON.stringify(state));
}

function launch(
  ayaHome: string,
  userDataDir: string,
  root: string,
): Promise<ElectronApplication> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string" && k !== "ELECTRON_RUN_AS_NODE" && k !== "AYA_DEV") {
      env[k] = v;
    }
  }
  env.AYA_HOME = ayaHome;
  env.AYA_E2E_HEADLESS = process.env.AYA_E2E_HEADLESS ?? "1";
  env.CODEX_HOME = join(root, "codex-home");
  const args = [
    join(APP_ROOT, "dist-electron", "main.js"),
    `--user-data-dir=${userDataDir}`,
  ];
  if (process.env.CI) {
    args.push("--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage");
  }
  return electron.launch({ args, cwd: APP_ROOT, env });
}

/** Poll projects-state.json until the persisted active terminal for a project
 *  matches the expected id — deterministic replacement for a fixed sleep, so we
 *  kill the app only once the debounced IPC write has actually landed on disk. */
async function waitForPersistedActiveTab(
  ayaHome: string,
  slug: string,
  tabId: string,
): Promise<void> {
  const file = projectStatePath(ayaHome);
  await expect
    .poll(
      () => {
        try {
          return JSON.parse(readFileSync(file, "utf8")).activeTab?.[slug] ?? null;
        } catch {
          return null;
        }
      },
      { timeout: ACTIVE_TAB_PERSISTENCE_TIMEOUT_MS },
    )
    .toBe(tabId);
}

/** SIGKILL the app and wait for the OS to actually reap it before relaunching
 *  the same AYA_HOME — deterministic replacement for a fixed settle sleep. */
async function killAndWait(app: ElectronApplication): Promise<void> {
  const proc = app.process();
  proc.kill("SIGKILL");
  await new Promise<void>((resolve) => proc.once("exit", () => resolve()));
}

// Regression guard for #18: the active terminal per project is now persisted
// (ProjectCollectionState.activeTab), so it survives a restart instead of
// resetting to the first one.
test("the last-active terminal stays active across a restart (#18)", async () => {
  const s = seedEnv({ split: false }); // sidebar switching, one terminal shown
  try {
    // First launch: the project opens on its first tab ("shell 1"). Switch to
    // the second terminal via the sidebar.
    let app = await launch(s.ayaHome, s.userDataDir, s.root);
    let win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");
    await win.locator(".aya-sidebar-row", { hasText: "shell 2" }).click();
    await expect(win.locator(".aya-sidebar-row--active")).toHaveText(/shell 2/);
    // Wait for the debounced IPC write to actually land on disk before killing —
    // a fixed sleep here would race the write under load and persist nothing.
    await waitForPersistedActiveTab(s.ayaHome, "e2e-proj", "tab-right");
    await killAndWait(app);

    // Relaunch the same home. The terminal that was active should still be
    // active — not reset to the first one.
    app = await launch(s.ayaHome, s.userDataDir, s.root);
    win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");
    await expect(win.locator(".aya-sidebar-row--active")).toHaveText(/shell 2/);
    await killAndWait(app);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

// A persisted activeTab can point at a terminal that no longer exists (the user
// deleted that tab between sessions). The restore must drop the dangling pointer
// and fall back to the first tab — not select a ghost id and render a blank
// pane. Guards the bootstrap validation branch (tabIds.has(saved)) + hydration's
// stillValid check (#18).
test("a dangling persisted activeTab falls back to the first terminal", async () => {
  const s = seedEnv({ split: false });
  try {
    // Overwrite the seeded state so the active terminal points at an id that is
    // not one of the project's tabs (tab-left / tab-right).
    writeProjectState(s.ayaHome, {
      version: 1,
      order: ["e2e-proj"],
      open: ["e2e-proj"],
      recent: ["e2e-proj"],
      activeProject: "e2e-proj",
      activeTab: { "e2e-proj": "tab-deleted" },
      singleView: { "e2e-proj": "tab-deleted" },
    });
    const app = await launch(s.ayaHome, s.userDataDir, s.root);
    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");
    // Falls back to the first tab (shell 1) and actually renders THAT terminal:
    // the visible pane header reads "shell 1". A dangling pointer would instead
    // leave the active pane showing the "Empty pane" placeholder (no terminal
    // for the ghost id), so this pins which terminal renders, not just that one
    // does.
    await expect(win.locator(".aya-sidebar-row--active")).toHaveText(/shell 1/);
    await expect(
      win.locator(".aya-pane-header-title").filter({ hasText: /shell 1/ }),
    ).toBeVisible();
    await killAndWait(app);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

// The persisted activeProject (which project tab is selected) must also be
// restored — not just the active terminal within a project. With two open
// projects, the saved active one (here the SECOND, non-default) has to win over
// "fall back to the first open project". Guards the bootstrap branch at
// App.tsx setActiveProjectId(savedActiveProject) (#18).
test("the last-active project is restored across a restart (#18)", async () => {
  const s = seedEnv({ split: false }); // gives project "e2e" (slug e2e-proj)
  try {
    // Add a SECOND project ("Bravo") sharing the same (existing) directory, then
    // mark it as the active project. e2e-proj is first in `order`, so without
    // restore the app would default to it — the test only passes if the saved
    // activeProject (proj-b) is honoured.
    writeFileSync(
      join(s.ayaHome, "projects", "proj-b.json"),
      JSON.stringify({
        name: "Bravo",
        directory: s.projectDir,
        tabs: [{ id: "tab-bravo", presetId: "shell", name: "bravo 1" }],
      }),
    );
    writeProjectState(s.ayaHome, {
      version: 1,
      order: ["e2e-proj", "proj-b"],
      open: ["e2e-proj", "proj-b"],
      recent: ["proj-b", "e2e-proj"],
      activeProject: "proj-b",
    });
    const app = await launch(s.ayaHome, s.userDataDir, s.root);
    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");
    // The active project tab is Bravo (the saved one), not the first/default e2e.
    await expect(
      win.locator(".aya-tab--active .aya-tab-name"),
    ).toHaveText(/Bravo/);
    // And its terminal is the one shown in the sidebar (proves we switched the
    // whole active context, not just the tab label).
    await expect(win.locator(".aya-sidebar-row--active")).toHaveText(/bravo 1/);
    await killAndWait(app);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});
