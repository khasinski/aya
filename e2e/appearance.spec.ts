import { test, expect } from "./fixtures";
import { fireShortcut } from "./helpers/shortcut";
import { MAC_OPTION_KEY_STORAGE_KEY } from "../src/storage-keys";

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
    .poll(() => window.evaluate((k) => localStorage.getItem(k), MAC_OPTION_KEY_STORAGE_KEY))
    .toBe("option-as-meta");

  await settings
    .getByTestId("mac-option-segment")
    .filter({ hasText: "Right Option composes" })
    .click();
  await expect
    .poll(() => window.evaluate((k) => localStorage.getItem(k), MAC_OPTION_KEY_STORAGE_KEY))
    .toBe("right-option-compose");
});

test("Settings uses icon tabs and focused panes", async ({ window, app }) => {
  await fireShortcut(app, "open-settings");
  const settings = window.locator(".aya-modal--settings");
  await expect(settings).toBeVisible();

  const tabs = settings.getByTestId("settings-tab");
  await expect(tabs).toHaveCount(8);
  for (const label of [
    "General",
    "Intelligence",
    "Updates",
    "Diagnostics",
    "Themes",
    "Presets",
    "Snippets",
    "Machines",
  ]) {
    await expect(tabs.filter({ hasText: label })).toBeVisible();
  }
  await expect(settings.locator(".aya-settings-header", { hasText: "General" })).toBeVisible();

  await settings.getByTestId("settings-tab").filter({ hasText: "Snippets" }).click();
  await expect(settings.locator(".aya-settings-header", { hasText: "Snippets" })).toBeVisible();

  await settings.getByTestId("settings-tab").filter({ hasText: "Presets" }).click();
  await expect(settings.locator(".aya-settings-header", { hasText: "Presets" })).toBeVisible();
});

test("Violet is selectable outside dev mode, persists on reload and restores standard appearance when deselected", async ({ window, app }) => {
  await fireShortcut(app, "open-settings");
  let settings = window.locator(".aya-modal--settings");
  await settings.getByTestId("appearance-segment").filter({ hasText: "Violet" }).click();
  await expect.poll(() => window.evaluate(() => ({ preference: localStorage.getItem("aya:app-theme"), background: document.documentElement.style.getPropertyValue("--bg"), mode: document.documentElement.dataset.theme }))).toEqual({ preference: "violet", background: "#0c1018", mode: "dark" });
  await window.reload();
  await expect.poll(() => window.evaluate(() => document.documentElement.style.getPropertyValue("--bg"))).toBe("#0c1018");
  await fireShortcut(app, "open-settings");
  settings = window.locator(".aya-modal--settings");
  await expect(settings.getByTestId("appearance-segment").filter({ hasText: "Violet" })).toHaveClass(/aya-settings-segment--active/);
  await window.screenshot({ path: "test-results/violet-appearance.png", animations: "disabled" });
  await settings.getByTestId("appearance-segment").filter({ hasText: "Light" }).click();
  await expect.poll(() => window.evaluate(() => ({ background: document.documentElement.style.getPropertyValue("--bg"), mode: document.documentElement.dataset.theme }))).toEqual({ background: "", mode: "light" });
  await settings.getByTestId("appearance-segment").filter({ hasText: "System" }).click();
  await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme)).toBe(undefined);
});
