import {
  test as base,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { seedEnv, type SeededEnv } from "./helpers/seed";

const APP_ROOT = join(__dirname, "..");

/** Fixtures that launch the built Aya app once per test against an isolated,
 *  seeded environment and tear it down afterward. */
export const test = base.extend<{
  seeded: SeededEnv;
  app: ElectronApplication;
  window: Page;
}>({
  seeded: async ({}, use) => {
    const s = seedEnv();
    await use(s);
    rmSync(s.root, { recursive: true, force: true });
  },

  app: async ({ seeded }, use) => {
    // Production-like launch: no AYA_DEV, so the app loads the built
    // dist/index.html. ELECTRON_RUN_AS_NODE must be stripped or Electron starts
    // as plain Node (no `app`). AYA_HOME + --user-data-dir isolate all state.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string" && k !== "ELECTRON_RUN_AS_NODE" && k !== "AYA_DEV") {
        env[k] = v;
      }
    }
    env.AYA_HOME = seeded.ayaHome;

    // Point Electron at the built main entry, NOT the app root: a bare
    // directory arg is interpreted by main.ts as "open this project", which
    // would open the aya repo itself as a spurious project. main.ts skips argv
    // entries ending in "main.js", so this avoids that.
    const launchArgs = [
      join(APP_ROOT, "dist-electron", "main.js"),
      `--user-data-dir=${seeded.userDataDir}`,
    ];
    // CI runners can't use the Chromium SUID sandbox; disable it there only.
    if (process.env.CI) launchArgs.push("--no-sandbox");

    const app = await electron.launch({ args: launchArgs, cwd: APP_ROOT, env });
    await use(app);
    // Aya spawns a detached pty-host (its "PTYs survive restart" design), so
    // app.close() can hang under CI/xvfb and a dangling close() promise keeps
    // Playwright's worker from exiting. SIGKILL the Electron process directly.
    try {
      app.process().kill("SIGKILL");
    } catch {
      /* already gone */
    }
  },

  window: async ({ app }, use) => {
    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");
    await use(win);
  },
});

export const expect = test.expect;
