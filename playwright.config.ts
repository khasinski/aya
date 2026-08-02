import { defineConfig } from "@playwright/test";

// Electron end-to-end tests. Each test launches the built app (dist-electron +
// dist) through Playwright's Electron driver against an isolated, seeded
// AYA_HOME and a throwaway Electron user-data-dir, so runs are deterministic
// and never touch the real ~/.aya or collide with a running Aya instance.
export default defineConfig({
  testDir: "./e2e",
  // App launches are heavy and share node_modules/electron + the window server;
  // run serially for stability.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Hard ceiling for the WHOLE suite on CI. Size it with real headroom: the
  // suite already ran ~4.6m before the respawn/boot-reuse specs (real PTY
  // flows) joined, and a single genuine failure adds a retried app launch on
  // top. At 5m the overrun killed whichever tests were in flight around the
  // deadline - alphabetical-tail specs (search, snippet-*) "failed" with
  // assertion timeouts that had nothing to do with their content.
  globalTimeout: process.env.CI ? 10 * 60_000 : undefined,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
});
