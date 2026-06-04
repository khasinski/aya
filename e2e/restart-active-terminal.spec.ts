import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import { seedEnv } from "./helpers/seed";

// Reproduces: after restart the FIRST terminal is selected, not the one that
// was active last. Two launches against the same AYA_HOME — switch to the
// second terminal, quit, relaunch, and check which terminal is shown.

const APP_ROOT = join(__dirname, "..");

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
    // Let the async state save (IPC -> atomic write) flush before we kill it,
    // otherwise the SIGKILL can interrupt the write and nothing was persisted.
    await win.waitForTimeout(800);
    app.process().kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 1500)); // let the pty-host / state settle

    // Relaunch the same home. The terminal that was active should still be
    // active — not reset to the first one.
    app = await launch(s.ayaHome, s.userDataDir, s.root);
    win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");
    await expect(win.locator(".aya-sidebar-row--active")).toHaveText(/shell 2/);
    app.process().kill("SIGKILL");
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
    writeFileSync(
      join(s.ayaHome, "projects-state.json"),
      JSON.stringify({
        version: 1,
        order: ["e2e-proj"],
        open: ["e2e-proj"],
        recent: ["e2e-proj"],
        activeProject: "e2e-proj",
        activeTab: { "e2e-proj": "tab-deleted" },
        singleView: { "e2e-proj": "tab-deleted" },
      }),
    );
    const app = await launch(s.ayaHome, s.userDataDir, s.root);
    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");
    // Falls back to the first tab (shell 1) and actually renders a terminal
    // (a dangling pointer would leave the active pane blank).
    await expect(win.locator(".aya-sidebar-row--active")).toHaveText(/shell 1/);
    await expect(win.locator(".xterm").first()).toBeVisible();
    app.process().kill("SIGKILL");
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});
