import {
  test as base,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { seedEnv, type SeededEnv, type SeedOptions } from "./helpers/seed";

const APP_ROOT = join(__dirname, "..");

/** Fixtures that launch the built Aya app once per test against an isolated,
 *  seeded environment and tear it down afterward. */
export const test = base.extend<{
  /** Per-test seed options. Override with `test.use({ seedOptions: {...} })`. */
  seedOptions: SeedOptions;
  seeded: SeededEnv;
  app: ElectronApplication;
  window: Page;
}>({
  seedOptions: [{}, { option: true }],

  seeded: async ({ seedOptions }, use) => {
    const s = seedEnv(seedOptions);
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
    // CI runners can't use the Chromium SUID sandbox, and the GPU process under
    // xvfb keeps app.close() from ever resolving (leaving the worker hung). Both
    // flags are CI-only.
    if (process.env.CI) {
      launchArgs.push("--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage");
    }

    const app = await electron.launch({ args: launchArgs, cwd: APP_ROOT, env });
    await use(app);
    try {
      app.process().kill("SIGKILL");
    } catch {
      /* already gone */
    }
    if (process.env.CI) {
      // Aya spawns a detached pty-host (its "PTYs survive restart" design) that
      // outlives the window; on the isolated CI runner that leftover process
      // keeps Playwright's worker from exiting (45s teardown timeout). Reap it.
      // CI-only: locally this would also kill a developer's running Aya.
      try {
        execSync("pkill -9 -f pty-host.js", { stdio: "ignore" });
      } catch {
        /* nothing to kill */
      }
    } else {
      await app.close().catch(() => {});
    }
  },

  window: async ({ app }, use) => {
    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");
    await use(win);
  },
});

export const expect = test.expect;
