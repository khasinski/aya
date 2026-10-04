import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { test, expect } from "./fixtures";
import { EXPECT_TIMEOUT_MS } from "./timeouts";

// Cmd+Q with a second-instance open or a Dock click in the same moment: a window made in the dying process
// is lost with it. before-quit is emitted without quitting, so the process stays to be looked at.

const windowCount = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
const refusal = (app: ElectronApplication, said: RegExp) =>
  app.waitForEvent("console", { predicate: (m) => said.test(m.text()) && /quitting/.test(m.text()), timeout: EXPECT_TIMEOUT_MS });

const OPENS = {
  "Aya DIR from a terminal": {
    windows: ["a window open", "every window closed"],
    said: /could not open .*late-open/,
    run: (app: ElectronApplication, dir: string) =>
      app.evaluate(({ app: a }, d) => void a.emit("second-instance", {}, ["Aya", d], d), dir),
  },
  "a Dock click": {
    windows: ["every window closed"],
    said: /could not create a window/,
    run: (app: ElectronApplication) => app.evaluate(({ app: a }) => void a.emit("activate", {}, false)),
  },
} as const;

for (const [open, { windows, said, run }] of Object.entries(OPENS)) {
  for (const state of windows) {
    test(`${state}, Aya quitting, ${open}: refused, no window made, no project added`, async ({ app, window, seeded }) => {
      // Off macOS the last window closing quits Aya (main.ts window-all-closed), so that state only exists on macOS.
      test.skip(state === "every window closed" && process.platform !== "darwin", "macOS only: Aya outlives its last window there");
      const tabs = window.locator(".aya-topbar .aya-tab .aya-tab-name");
      await expect(tabs).toHaveText(["e2e"]);
      if (state === "every window closed") {
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy()));
        await expect.poll(() => windowCount(app)).toBe(0);
      }
      const before = await windowCount(app);
      const dir = join(seeded.root, "late-open");
      mkdirSync(dir);
      await app.evaluate(({ app: a }) => void a.emit("before-quit", { preventDefault: () => {} }));
      const refused = refusal(app, said);
      await run(app, dir);
      await refused;
      expect(await windowCount(app)).toBe(before);
      if (state === "a window open") await expect(tabs).toHaveText(["e2e"]);
    });
  }
}
