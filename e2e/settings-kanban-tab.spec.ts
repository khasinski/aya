import type { ElectronApplication, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { fireShortcut } from "./helpers/shortcut";

// The Kanban switch stays in General. Turning it on adds a Kanban tab to Settings
// that shows the board's defaults; turning it off removes the tab again.

async function openSettings(window: Page, app: ElectronApplication) {
  await fireShortcut(app, "open-settings");
  const settings = window.locator(".aya-modal--settings");
  await expect(settings).toBeVisible();
  return settings;
}

const settingsTab = (settings: ReturnType<Page["locator"]>, name: string) =>
  settings.getByTestId("settings-tab").filter({ hasText: name });

async function setKanban(settings: ReturnType<Page["locator"]>, on: boolean) {
  await settingsTab(settings, "General").click();
  await settings.getByLabel("Kanban board").getByRole("button", { name: on ? "On" : "Off", exact: true }).click();
}

test("Kanban is off by default and Settings has no Kanban tab", async ({ window, app }) => {
  const settings = await openSettings(window, app);
  await expect(settingsTab(settings, "General")).toBeVisible();
  await expect(settingsTab(settings, "Kanban")).toHaveCount(0);
  await expect(window.getByRole("button", { name: "Kanban", exact: true })).toHaveCount(0);
});

test("the Kanban switch in General shows and hides the Kanban launcher", async ({ window, app }, testInfo) => {
  const settings = await openSettings(window, app);
  const launcher = window.getByRole("button", { name: "Kanban", exact: true });
  await setKanban(settings, true);
  await expect(launcher).toHaveCount(1);
  await window.screenshot({ path: testInfo.outputPath("settings-general-kanban-on.png") });
  await setKanban(settings, false);
  await expect(launcher).toHaveCount(0);
});

test("turning Kanban on adds a Kanban tab with the board defaults, turning it off removes it", async ({ window, app }, testInfo) => {
  const settings = await openSettings(window, app);
  await setKanban(settings, true);
  await settingsTab(settings, "Kanban").click();
  const pane = settings.getByTestId("settings-kanban");
  await expect(pane).toContainText("Todo, In Progress, Review, Done");
  await expect(pane).toContainText("First column");
  await expect(pane).toContainText("Urgent (P0), High (P1), Medium (P2), Low (P3)");
  await expect(pane).toContainText("16,000 characters");
  await expect(pane.getByRole("button")).toHaveCount(0);
  await window.screenshot({ path: testInfo.outputPath("settings-kanban-tab.png") });

  await setKanban(settings, false);
  await expect(settingsTab(settings, "Kanban")).toHaveCount(0);
  await expect(settingsTab(settings, "General")).toBeVisible();
});
