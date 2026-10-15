import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { defineConfig } from "@playwright/test";
import {
  EXPECT_TIMEOUT_MS,
  PER_TEST_TIMEOUT_MS,
  globalTimeout,
} from "./e2e/timeouts";

// Some specs run Aya's own modules in this process, not only in the app they launch (e2e/web-mode.spec.ts serves
// dist-electron's web server), and paths.ts reads AYA_HOME when it loads: with none set, those runs read and rewrote
// the real ~/.aya/projects-state.json. CI's run_e2e sets a throwaway AYA_HOME; every run here gets its own too.
// Workers inherit it (they load this file again and keep it), the process that made it removes it on exit, and each
// app a spec launches still gets the seeded AYA_HOME of its test (appEnv).
const RUNNER_HOME = "aya-e2e-runner-";
if (!basename(process.env.AYA_HOME ?? "").startsWith(RUNNER_HOME)) {
  const own = mkdtempSync(join(tmpdir(), RUNNER_HOME));
  process.env.AYA_HOME = own;
  process.on("exit", () => rmSync(own, { recursive: true, force: true }));
}

// These specs touch the OS clipboard or temporarily rebuild the shared PTY
// host script. They run one at a time after every isolated app has closed.
const sharedResources = /(?:^|[/\\])(?:diagnostics|machines-copy|terminal-polish|team-relaunch-stale-host)\.spec\.ts$/;

// Electron end-to-end tests. Each test launches the built app (dist-electron +
// dist) through Playwright's Electron driver against an isolated, seeded
// AYA_HOME and a throwaway Electron user-data-dir, so runs are deterministic
// and never touch the real ~/.aya or collide with a running Aya instance.
export default defineConfig({
  testDir: "./e2e",
  // The isolated project can split large files across workers (each case has its own HOME);
  // explicit serial groups keep their order, the shared-resource project keeps file-level scheduling.
  fullyParallel: false,
  workers: process.env.CI ? 2 : 8,
  projects: [
    { name: "isolated", testIgnore: sharedResources, fullyParallel: true },
    {
      name: "shared-resources",
      testMatch: sharedResources,
      workers: 1,
      dependencies: ["isolated"],
    },
  ],
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  globalTimeout: globalTimeout(process.env),
  timeout: PER_TEST_TIMEOUT_MS,
  expect: { timeout: EXPECT_TIMEOUT_MS },
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
});
