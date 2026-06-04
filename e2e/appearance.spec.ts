import { test, expect } from "./fixtures";
import { fireShortcut } from "./helpers/shortcut";

test("Settings can pin the app appearance or return to system mode", async ({
  window,
  app,
}) => {
  await fireShortcut(app, "open-settings");
  const settings = window.locator(".aya-modal--settings");
  await expect(settings).toBeVisible();

  await settings.getByTestId("appearance-segment").filter({ hasText: "Dark" }).click();
  await expect
    .poll(() => window.evaluate(() => document.documentElement.dataset.theme))
    .toBe("dark");

  await settings.getByTestId("appearance-segment").filter({ hasText: "Light" }).click();
  await expect
    .poll(() => window.evaluate(() => document.documentElement.dataset.theme))
    .toBe("light");

  await settings.getByTestId("appearance-segment").filter({ hasText: "System" }).click();
  await expect
    .poll(() => window.evaluate(() => document.documentElement.dataset.theme))
    .toBe(undefined);
});

test("Settings can switch the macOS Option key mode", async ({ window, app }) => {
  await fireShortcut(app, "open-settings");
  const settings = window.locator(".aya-modal--settings");
  await expect(settings).toBeVisible();

  await expect(
    settings.getByTestId("mac-option-segment").filter({ hasText: "Right Option composes" }),
  ).toHaveClass(/aya-settings-segment--active/);

  await settings
    .getByTestId("mac-option-segment")
    .filter({ hasText: "All Option = Meta" })
    .click();
  await expect
    .poll(() => window.evaluate(() => localStorage.getItem("aya:mac-option-key")))
    .toBe("option-as-meta");

  await settings
    .getByTestId("mac-option-segment")
    .filter({ hasText: "Right Option composes" })
    .click();
  await expect
    .poll(() => window.evaluate(() => localStorage.getItem("aya:mac-option-key")))
    .toBe("right-option-compose");
});
