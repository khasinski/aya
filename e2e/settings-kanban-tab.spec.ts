import type { ElectronApplication, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { fireShortcut } from "./helpers/shortcut";
import { COLUMN_TITLES, DEFAULT_BOARD_COLUMNS, PENDING_COLUMN_IDS, STARTED_COLUMN_ID } from "../shared/board-columns.cjs";
import {
  MAX_ASSIGNEE_CHARS, MAX_BOARD_CARDS, MAX_BOARD_COLUMNS, MAX_BOARD_IMAGE_BYTES,
  MAX_CARD_DESCRIPTION_CHARS, MAX_CARD_LABEL_CHARS, MAX_CARD_LABELS, MAX_CARD_TITLE_CHARS, MAX_COLUMN_TITLE_CHARS,
} from "../src/main-mirrors";
import { mib } from "../src/units";

const count = (n: number) => n.toLocaleString("en-US");
const pendingTitles = PENDING_COLUMN_IDS.map((id) => COLUMN_TITLES[id]).join(" or ");

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
  await expect(pane).toContainText(DEFAULT_BOARD_COLUMNS.map((column) => column.title).join(", "));
  const rules = pane.getByLabel("Kanban fixed rules");
  await expect(rules).toContainText(`Moving a claimed card back to ${pendingTitles} removes its claim and asks its pane to stop work on it.`);
  await expect(rules).toContainText(`Starting a card from ${pendingTitles} moves it to ${COLUMN_TITLES[STARTED_COLUMN_ID]}, when the board has that column.`);
  for (const rule of [
    "A card another pane holds is taken over only by Send to pane on the board or aya board claim with --replace.",
    "From a pane, aya board releases only that pane's cards unless --force is given.",
    "Taking over, releasing, deleting or archiving a claimed card asks the pane that held it to stop work on it, unless that pane made the change.",
    "Closing a terminal tab releases every card it held.",
  ]) await expect(rules).toContainText(rule);
  await expect(pane).toContainText("First column");
  await expect(pane).toContainText("Urgent (P0), High (P1), Medium (P2), Low (P3)");
  const limits = pane.getByLabel("Kanban limits");
  for (const line of [
    `A board holds up to ${count(MAX_BOARD_COLUMNS)} columns and ${count(MAX_BOARD_CARDS)} cards.`,
    `Card title: up to ${count(MAX_CARD_TITLE_CHARS)} characters. Column title: up to ${count(MAX_COLUMN_TITLE_CHARS)} characters.`,
    `Card description: up to ${count(MAX_CARD_DESCRIPTION_CHARS)} characters.`,
    `Labels: up to ${count(MAX_CARD_LABELS)} per card, ${count(MAX_CARD_LABEL_CHARS)} characters each.`,
    `Assignee: up to ${count(MAX_ASSIGNEE_CHARS)} characters.`,
    `Images in a card: up to ${mib(MAX_BOARD_IMAGE_BYTES)} MiB each.`,
  ]) await expect(limits).toContainText(line);
  // The only control is the Backlog switch, off by default; everything else is read only.
  await expect(pane.getByRole("button")).toHaveCount(2);
  await expect(pane.getByLabel("Backlog", { exact: true }).getByRole("button", { name: "Off", exact: true })).toHaveClass(/aya-settings-segment--active/);
  await window.screenshot({ path: testInfo.outputPath("settings-kanban-tab.png") });

  await setKanban(settings, false);
  await expect(settingsTab(settings, "Kanban")).toHaveCount(0);
  await expect(settingsTab(settings, "General")).toBeVisible();
});
