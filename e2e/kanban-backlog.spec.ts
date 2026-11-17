import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { fireShortcut } from "./helpers/shortcut";

// The backlog is a board's Backlog column. Move to backlog in a card's menu is offered
// when the board has that column. Settings > Kanban > Move backlog to shelf (off by
// default) only changes where the column shows: in the shelf, as a Backlog tab.
const at = "2026-11-12T10:00:00.000Z";
const card = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id, title, columnId: "todo", createdAt: at, updatedAt: at, ...extra,
});
const columns = [{ id: "todo", title: "Todo" }, { id: "done", title: "Done" }];
const withBacklog = [...columns, { id: "backlog", title: "Backlog" }];
// Backlog as the first column: Restore and the n/c shortcut must pick the first
// column the board shows, not the board's first column.
const backlogFirst = [{ id: "backlog", title: "Backlog" }, ...columns];
const archived = [card("t-3", "Old", { columnId: "done", archivedAt: at })];
const cards = [card("t-1", "Later idea", { labels: ["idea"] }), card("t-2", "Now")];
const parked = card("t-4", "Parked", { columnId: "backlog" });
const seed = (b: unknown) => ({ rightTab: { presetId: "board", name: "Board" }, ayaHomeFiles: { "boards/e2e-proj.json": JSON.stringify(b) } });
const boardFile = (ayaHome: string) => JSON.parse(readFileSync(join(ayaHome, "boards", "e2e-proj.json"), "utf8"));

async function openCardMenu(window: Page, id: string) {
  await window.getByTestId(`kanban-card-${id}`).getByRole("button", { name: /Terminal/ }).click();
  await expect(window.getByRole("menuitem", { name: /Archive card/ })).toBeVisible();
}

async function setShelf(window: Page, app: ElectronApplication, on: boolean) {
  await fireShortcut(app, "open-settings");
  const settings = window.locator(".aya-modal--settings");
  await settings.getByTestId("settings-tab").filter({ hasText: "General" }).click();
  await settings.getByLabel("Kanban board").getByRole("button", { name: "On", exact: true }).click();
  await settings.getByTestId("settings-tab").filter({ hasText: "Kanban" }).click();
  await settings.getByLabel("Move backlog to shelf", { exact: true }).getByRole("button", { name: on ? "On" : "Off", exact: true }).click();
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(settings).toHaveCount(0);
}

async function openBacklogTab(window: Page) {
  await window.getByTestId("kanban-archive-toggle").click();
  const drawer = window.getByTestId("kanban-archive-drawer");
  await drawer.getByRole("tab", { name: /Backlog/ }).click();
  return drawer;
}

test.describe("no Backlog column", () => {
  test.use({ seedOptions: seed({ version: 1, columns, cards, archivedCards: archived }) });

  test("no Move to backlog; Settings offers Create backlog column and keeps the switch off until it exists", async ({ window, app, seeded }, testInfo) => {
    await openCardMenu(window, "t-1");
    await expect(window.getByRole("menuitem", { name: /Move to backlog/ })).toHaveCount(0);
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("kanban-archive-toggle")).toHaveText("Archive (1)");

    await fireShortcut(app, "open-settings");
    const settings = window.locator(".aya-modal--settings");
    await settings.getByTestId("settings-tab").filter({ hasText: "General" }).click();
    await settings.getByLabel("Kanban board").getByRole("button", { name: "On", exact: true }).click();
    await settings.getByTestId("settings-tab").filter({ hasText: "Kanban" }).click();
    const create = settings.getByRole("button", { name: "Create backlog column", exact: true });
    const on = settings.getByLabel("Move backlog to shelf", { exact: true }).getByRole("button", { name: "On", exact: true });
    await expect(create).toBeEnabled();
    await expect(settings.getByText("Creates the Backlog column in e2e")).toBeVisible();
    await expect(on).toBeDisabled();
    await settings.locator(".aya-settings-general-row").filter({ hasText: "Move backlog to shelf" }).screenshot({ path: testInfo.outputPath("settings-no-column.png") });
    await create.click();
    await expect(create).toBeDisabled();
    await expect(on).toBeEnabled();
    await expect(settings.getByText("The board already has a Backlog column")).toBeVisible();
    expect(boardFile(seeded.ayaHome).columns.map((c: { id: string }) => c.id)).toEqual(["backlog", "todo", "done"]);
    await settings.locator(".aya-settings-general-row").filter({ hasText: "Move backlog to shelf" }).screenshot({ path: testInfo.outputPath("settings-with-column.png") });
    await settings.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(window.getByTestId("kanban-column-backlog")).toBeVisible();
  });
});

test.describe("Backlog column, setting off (default)", () => {
  test.use({ seedOptions: seed({ version: 1, columns: withBacklog, cards: [...cards, parked], archivedCards: archived }) });

  test("the column is on the board and Move to backlog moves a card into it", async ({ window, seeded }) => {
    await expect(window.getByTestId("kanban-column-backlog").getByTestId("kanban-card-t-4")).toBeVisible();
    // A card already in the Backlog column gets no Move to backlog item (a no-op move).
    await openCardMenu(window, "t-4");
    await expect(window.getByRole("menuitem", { name: /Move to backlog/ })).toHaveCount(0);
    await window.keyboard.press("Escape");
    await openCardMenu(window, "t-1");
    await window.getByRole("menuitem", { name: /Move to backlog/ }).click();
    await expect(window.getByTestId("kanban-column-backlog").getByTestId("kanban-card-t-1")).toBeVisible();
    expect(boardFile(seeded.ayaHome).cards.find((c: { id: string }) => c.id === "t-1").columnId).toBe("backlog");
    await expect(window.getByTestId("kanban-archive-toggle")).toHaveText("Archive (1)");
  });
});

test.describe("Backlog column, setting on", () => {
  test.use({ seedOptions: seed({ version: 1, columns: backlogFirst, cards: [...cards, parked], archivedCards: archived }) });

  test("the column is in the shelf; Move to backlog, search and Restore work there", async ({ window, app }, testInfo) => {
    await setShelf(window, app, true);
    await expect(window.getByTestId("kanban-column-backlog")).toHaveCount(0);
    // n opens the add form in the first column the board shows, not the hidden Backlog one.
    // A click on the column title first moves focus out of the terminal input,
    // which otherwise swallows the shortcut.
    await window.locator(".aya-kanban-column-title").first().click();
    await window.keyboard.press("n");
    await expect(window.getByTestId("kanban-column-todo").getByLabel("Card title")).toBeVisible();
    await window.keyboard.press("Escape");
    await openCardMenu(window, "t-1");
    await window.getByRole("menuitem", { name: /Move to backlog/ }).click();
    await expect(window.getByTestId("kanban-card-t-1")).toHaveCount(0);
    await expect(window.getByTestId("kanban-archive-toggle")).toHaveText("Shelf (3)");
    const drawer = await openBacklogTab(window);
    await expect(drawer.getByRole("tab", { name: /Backlog/ })).toHaveText("Backlog2");
    await expect(drawer.getByRole("button", { name: "Empty", exact: true })).toHaveCount(0);
    const search = drawer.getByRole("searchbox", { name: "Search the backlog" });
    await search.fill("#nothing");
    await expect(drawer).toContainText("No matching backlog cards");
    await search.fill("#idea");
    await expect(drawer.getByTestId("kanban-backlog-card-t-1")).toBeVisible();
    await expect(drawer.getByTestId("kanban-backlog-card-t-4")).toHaveCount(0);
    await window.screenshot({ path: testInfo.outputPath("backlog-tab.png") });
    await search.fill("");
    await drawer.getByTestId("kanban-backlog-card-t-1").getByRole("button", { name: /Restore/ }).click();
    await expect(window.getByTestId("kanban-column-todo").getByTestId("kanban-card-t-1")).toBeVisible();

    // Turning it off puts the column, cards and all, back on the board.
    await setShelf(window, app, false);
    await expect(window.getByTestId("kanban-column-backlog").getByTestId("kanban-card-t-4")).toBeVisible();
    await expect(window.getByTestId("kanban-archive-toggle")).toHaveText("Archive (1)");
  });
});

test.describe("a card saved with the first version's shelf mark", () => {
  test.use({ seedOptions: seed({ version: 1, columns, cards: [card("t-1", "Later idea", { shelf: "backlog" }), card("t-2", "Now")], archivedCards: archived }) });

  test("loads into a Backlog column: on the board while off, in the shelf while on", async ({ window, app }) => {
    await expect(window.getByTestId("kanban-column-backlog").getByTestId("kanban-card-t-1")).toBeVisible();
    await setShelf(window, app, true);
    await expect(window.getByTestId("kanban-column-backlog")).toHaveCount(0);
    const drawer = await openBacklogTab(window);
    await expect(drawer.getByTestId("kanban-backlog-card-t-1")).toBeVisible();
  });
});

test.describe("the shelf preference on, board without a Backlog column", () => {
  test.use({ seedOptions: seed({ version: 1, columns, cards, archivedCards: archived }) });

  test("no Backlog tab shows, and the switch can be turned off from that project", async ({ window, app }) => {
    await window.evaluate(() => localStorage.setItem("aya:kanban-backlog-shelf", "1"));
    await window.reload();
    await expect(window.getByTestId("kanban-column-todo")).toBeVisible();
    await expect(window.getByTestId("kanban-column-backlog")).toHaveCount(0);
    await window.getByTestId("kanban-archive-toggle").click();
    const drawer = window.getByTestId("kanban-archive-drawer");
    await expect(drawer.getByRole("tab", { name: /Backlog/ })).toHaveCount(0);
    await drawer.getByRole("button", { name: "Close archive" }).click();

    // The switch is a global preference: On still waits for the column, Off is turnable here.
    await fireShortcut(app, "open-settings");
    const settings = window.locator(".aya-modal--settings");
    await settings.getByTestId("settings-tab").filter({ hasText: "General" }).click();
    await settings.getByLabel("Kanban board").getByRole("button", { name: "On", exact: true }).click();
    await settings.getByTestId("settings-tab").filter({ hasText: "Kanban" }).click();
    const row = settings.getByLabel("Move backlog to shelf", { exact: true });
    const on = row.getByRole("button", { name: "On", exact: true });
    const off = row.getByRole("button", { name: "Off", exact: true });
    await expect(on).toBeDisabled();
    await expect(on).toHaveClass(/aya-settings-segment--active/);
    await expect(off).toBeEnabled();
    await off.click();
    await expect(off).toHaveClass(/aya-settings-segment--active/);
    await settings.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(settings).toHaveCount(0);
    await expect.poll(() => window.evaluate(() => localStorage.getItem("aya:kanban-backlog-shelf"))).toBe("0");
  });
});
