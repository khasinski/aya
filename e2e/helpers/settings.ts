import { expect, type ElectronApplication, type Page } from "@playwright/test";
import { fireShortcut } from "./shortcut";

/** Opens Settings on its Presets tab; returns the Settings modal. */
export async function openPresetsTab(window: Page, app: ElectronApplication) {
  await fireShortcut(app, "open-settings");
  const settings = window.locator(".aya-modal--settings");
  await expect(settings).toBeVisible();
  await settings.getByTestId("settings-tab").filter({ hasText: "Presets" }).click();
  return settings;
}
