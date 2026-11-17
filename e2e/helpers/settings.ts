import { expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { fireShortcut } from "./shortcut";

/** Opens Settings; returns the Settings modal. */
export async function openSettings(window: Page, app: ElectronApplication) {
  await fireShortcut(app, "open-settings");
  const settings = window.locator(".aya-modal--settings");
  await expect(settings).toBeVisible();
  return settings;
}

/** The Settings tab button named `name`. */
export function settingsTab(settings: Locator, name: string) {
  return settings.getByTestId("settings-tab").filter({ hasText: name });
}

/** Opens Settings on its Presets tab; returns the Settings modal. */
export async function openPresetsTab(window: Page, app: ElectronApplication) {
  const settings = await openSettings(window, app);
  await settingsTab(settings, "Presets").click();
  return settings;
}
