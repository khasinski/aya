import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { join } from "node:path";
import { rmSync } from "node:fs";
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
