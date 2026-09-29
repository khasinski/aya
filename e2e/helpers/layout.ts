import { expect, type ElectronApplication, type Page } from "@playwright/test";
import { fireShortcut } from "./shortcut";
import { LAYOUT_MODE_STORAGE_KEY } from "../../src/storage-keys";

/** Switch to the experimental "Projects on left" layout at runtime via Settings
 *  (the layout preference lives in localStorage, so the app always boots in the
 *  classic layout). Confirms the alt top-bar rendered. */
export async function enableProjectsLeftLayout(window: Page, app: ElectronApplication) {
  await fireShortcut(app, "open-settings");
  const settings = window.locator(".aya-modal--settings");
  await expect(settings).toBeVisible();
  await settings
    .locator('.aya-settings-segmented[aria-label="Window layout"] button', {
      hasText: "Projects on left",
    })
    .click();
  await window.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await expect(window.locator(".aya-topbar--alt")).toBeVisible();
}

/** Stores the "Projects on left" preference and reloads, so the app renders in it. */
export async function reloadInProjectsLeftLayout(window: Page) {
  await window.evaluate((k) => localStorage.setItem(k, "projects-left"), LAYOUT_MODE_STORAGE_KEY);
  await window.reload();
}
