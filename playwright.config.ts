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
  globalTimeout: process.env.CI ? 5 * 60_000 : undefined,
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
