import { test, expect } from "./fixtures";
import { fireShortcut } from "./helpers/shortcut";

test("Settings can pin the app appearance or return to system mode", async ({
  window,
  app,
}) => {
  await fireShortcut(app, "open-settings");
  const settings = window.locator(".aya-modal--settings");
  await expect(settings).toBeVisible();

  await settings.locator(".aya-settings-segment", { hasText: "Dark" }).click();
  await expect
    .poll(() => window.evaluate(() => document.documentElement.dataset.theme))
    .toBe("dark");

  await settings.locator(".aya-settings-segment", { hasText: "Light" }).click();
  await expect
    .poll(() => window.evaluate(() => document.documentElement.dataset.theme))
    .toBe("light");

  await settings.locator(".aya-settings-segment", { hasText: "System" }).click();
  await expect
    .poll(() => window.evaluate(() => document.documentElement.dataset.theme))
    .toBe(undefined);
});
