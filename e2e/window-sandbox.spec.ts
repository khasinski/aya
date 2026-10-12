import { test, expect } from "./fixtures";

// The main window runs sandboxed (main.ts), so its preload is the one-file bundle from
// vite.preload.config.mts: a preload that still required its own modules would not load,
// and window.aya, the only way the window reaches Aya, would be missing.
test("the main window is sandboxed and its bundled preload still gives the window Aya", async ({ app, window }) => {
  const sandboxed = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => w.webContents.getLastWebPreferences()?.sandbox === true),
  );
  expect(sandboxed.length).toBeGreaterThan(0);
  expect(sandboxed.every(Boolean), "every window is sandboxed").toBe(true);

  const mainPlatform = await app.evaluate(() => process.platform);
  const bridge = await window.evaluate(() => {
    const aya = (window as unknown as { aya?: { platform?: string; isDev?: boolean } }).aya;
    return { platform: aya?.platform, isDev: aya?.isDev, require: typeof (window as unknown as { require?: unknown }).require };
  });
  expect(bridge).toEqual({ platform: mainPlatform, isDev: false, require: "undefined" });
  // The bridge's IPC works end to end: both terminals of the seeded project started and render.
  await expect(window.getByTestId("terminal-pane")).toHaveCount(2);
});
