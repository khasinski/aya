import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import type { SeedOptions } from "./seed";
import { openSettings, settingsTab } from "./settings";
import { PRESET_ID_BOARD } from "../../src/preset-ids";
import { KANBAN_STORAGE_KEY, LAYOUT_MODE_STORAGE_KEY } from "../../src/storage-keys";

// Seeds and steps the Kanban specs share. Card ids, column ids and the text a user
// reads stay literal in the specs: they are what board files store and what users see.

/** When every seeded card was created and last updated: a fixed instant keeps board files the same on every run. */
export const BOARD_SEED_TIME = "2026-11-12T10:00:00.000Z";

/** The tab that shows the seeded project's board. */
export const BOARD_TAB = { presetId: PRESET_ID_BOARD, name: "Board" };

/** The seeded project's own board file, relative to AYA_HOME (seed.ts names the project e2e-proj). */
export const BOARD_FILE = "boards/e2e-proj.json";

/** How long a board already on screen may take to render after a reload. */
const BOARD_SHOWS_WITHIN_MS = 3_000;

/** A card in the Todo column; `extra` adds fields or overrides any of them (columnId, say). */
export function boardCard<Extra extends Record<string, unknown>>(id: string, title: string, extra: Extra = {} as Extra) {
  return { id, title, columnId: "todo", createdAt: BOARD_SEED_TIME, updatedAt: BOARD_SEED_TIME, ...extra };
}

/** Dense boards are the normal GUI contract: every column scrolls and carries metadata. */
export function populatedBoard(cardsPerColumn = 8, extraColumns = false) {
  const columns = [
    { id: "todo", title: "Todo" }, { id: "in-progress", title: "In Progress" },
    { id: "review", title: "Review" }, { id: "done", title: "Done" },
    ...(extraColumns ? [{ id: "backlog", title: "Backlog" }, { id: "on-hold", title: "On Hold" }, { id: "blocked", title: "Blocked" }] : []),
  ];
  const cards = columns.flatMap((column, columnIndex) => Array.from({ length: cardsPerColumn }, (_, index) => boardCard(
    `t-${columnIndex * cardsPerColumn + index + 1}`,
    `${column.title}: task ${index + 1} with a realistic descriptive title`,
    {
      description: "A detailed task with enough context to fill the card.\nKeep the existing implementation and test its state transitions.\nAcceptance: preserve all other cards, descriptions, assignments and dates.",
      columnId: column.id,
      ...(index % 3 === 1 ? { assignee: `Planned owner ${index + 1}` } : {}),
      ...(index % 4 === 2 ? { claim: { paneId: `existing-owner-${columnIndex}-${index}`, paneName: `Owner ${index + 1}`, since: "2026-11-12T10:10:00.000Z" } } : {}),
    },
  )));
  return { version: 1 as const, columns, cards };
}

/** ayaHomeFiles that save `board` as the seeded project's board. */
export function boardFiles(board: unknown): Record<string, string> {
  return { [BOARD_FILE]: JSON.stringify(board) };
}

/** The seeded project's board as it is saved now. */
export function readBoardFile(ayaHome: string) {
  return JSON.parse(readFileSync(join(ayaHome, BOARD_FILE), "utf8"));
}

/** Seed options for a project whose board shows `board`: in the right half of the split (the default), or as
 *  the only tab (`pane: "single"`). Other options pass through. */
export function seedBoard(board: unknown, { pane = "right", ...opts }: SeedOptions & { pane?: "right" | "single" } = {}): SeedOptions {
  return {
    ...(pane === "single" ? { singleTab: BOARD_TAB } : { rightTab: BOARD_TAB }),
    ...opts,
    ayaHomeFiles: { ...opts.ayaHomeFiles, ...boardFiles(board) },
  };
}

/** Turns Kanban on in `layout` (and sets any `extra` storage keys), then reloads so the app renders with them. */
export async function reloadWithKanban(window: Page, layout: string, extra: Record<string, string> = {}) {
  await window.evaluate((items) => {
    for (const [key, value] of Object.entries(items)) localStorage.setItem(key, value);
  }, { [LAYOUT_MODE_STORAGE_KEY]: layout, [KANBAN_STORAGE_KEY]: "1", ...extra });
  await window.reload();
}

/** Shows the board after a reload. Layouts that show panes as tabs keep the board behind its Kanban tab. */
export async function showBoard(window: Page) {
  const toggle = window.getByTestId("kanban-archive-toggle");
  const launcher = window.getByRole("button", { name: "Kanban", exact: true });
  await expect(launcher).toBeVisible();
  // Give the board time to show before opening its tab: a check at one instant raced
  // its first render, and the launcher click then hid an active board.
  const shown = await toggle.waitFor({ state: "visible", timeout: BOARD_SHOWS_WITHIN_MS }).then(() => true, () => false);
  if (!shown) await launcher.click();
}

/** Opens the menu of card `id` (its Terminal button) and waits for it. */
export async function openCardMenu(window: Page, id: string) {
  await window.getByTestId(`kanban-card-${id}`).getByRole("button", { name: /Terminal/ }).click();
  await expect(window.getByRole("menuitem", { name: /Archive card/ })).toBeVisible();
}

/** The shelf drawer's tab whose name contains `name` (its label also carries a count). */
export function shelfTab(drawer: Locator, name: string) {
  return drawer.getByRole("tab", { name: new RegExp(name) });
}

/** Clicks the toolbar button that opens the shelf; returns the drawer. */
export async function openShelf(window: Page) {
  await window.getByTestId("kanban-archive-toggle").click();
  return window.getByTestId("kanban-archive-drawer");
}

/** Opens the shelf on its `name` tab; returns the drawer. */
export async function openShelfTab(window: Page, name: string) {
  const drawer = await openShelf(window);
  await shelfTab(drawer, name).click();
  return drawer;
}

/** Sets General > Kanban board in an open Settings modal. */
export async function setKanbanBoard(settings: Locator, on: boolean) {
  await settingsTab(settings, "General").click();
  await settings.getByLabel("Kanban board").getByRole("button", { name: on ? "On" : "Off", exact: true }).click();
}

/** The Move backlog to shelf switch's `On` or `Off` button in Settings > Kanban. */
export function backlogShelfButton(settings: Locator, on: boolean) {
  return settings.getByLabel("Move backlog to shelf", { exact: true }).getByRole("button", { name: on ? "On" : "Off", exact: true });
}

/** Turns Kanban on and sets Settings > Kanban > Move backlog to shelf, then closes Settings. */
export async function setBacklogOnShelf(window: Page, app: ElectronApplication, on: boolean) {
  const settings = await openSettings(window, app);
  await setKanbanBoard(settings, true);
  await settingsTab(settings, "Kanban").click();
  await backlogShelfButton(settings, on).click();
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(settings).toHaveCount(0);
}
