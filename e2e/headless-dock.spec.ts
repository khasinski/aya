// A hidden test run must not put an icon in the Dock or the menu bar of whoever is at the machine (2026-11-08: Electron
// registers as a foreground app even with every window hidden, and Electron puts the policy back to regular while
// it starts and when a window is created).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";

test("a headless run keeps the app out of the Dock, also after more windows open", async ({ app }) => {
  test.skip(process.platform !== "darwin", "the Dock is macOS only");
  await (await app.firstWindow()).waitForLoadState("domcontentloaded");
  const dockVisible = () => app.evaluate(({ app: electronApp }) => electronApp.dock?.isVisible());
  await expect.poll(dockVisible).toBe(false);
  await app.evaluate(({ BrowserWindow }) => { new BrowserWindow({ show: false }).destroy(); });
  await expect.poll(dockVisible).toBe(false);
});

test("a headless run is not a foreground app from the first instant, so the Dock never gets a tile", async ({ app }) => {
  test.skip(process.platform !== "darwin", "the Dock is macOS only");
  const executable = await app.evaluate(({ app: electronApp }) => electronApp.getPath("exe"));
  expect(executable).toContain("aya-e2e-electron");
  const plist = readFileSync(join(executable, "..", "..", "Info.plist"), "utf8");
  expect(plist).toMatch(/<key>LSUIElement<\/key>\s*<true\/>/);
});
