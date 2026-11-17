import { test, expect } from "./fixtures";
import {
  backlogShelfButton, boardCard, BOARD_SEED_TIME, openCardMenu, openShelf, openShelfTab, readBoardFile, seedBoard,
  setBacklogOnShelf, setKanbanBoard, shelfTab,
} from "./helpers/board";
import { openSettings, settingsTab } from "./helpers/settings";
import { KANBAN_BACKLOG_SHELF_STORAGE_KEY } from "../src/storage-keys";

// The backlog is a board's Backlog column. Move to backlog in a card's menu is offered
// when the board has that column. Settings > Kanban > Move backlog to shelf (off by
// default) only changes where the column shows: in the shelf, as a Backlog tab.
const columns = [{ id: "todo", title: "Todo" }, { id: "done", title: "Done" }];
const withBacklog = [...columns, { id: "backlog", title: "Backlog" }];
// Backlog as the first column: Restore and the n/c shortcut must pick the first
// column the board shows, not the board's first column.
const backlogFirst = [{ id: "backlog", title: "Backlog" }, ...columns];
const archived = [boardCard("t-3", "Old", { columnId: "done", archivedAt: BOARD_SEED_TIME })];
const cards = [boardCard("t-1", "Later idea", { labels: ["idea"] }), boardCard("t-2", "Now")];
const parked = boardCard("t-4", "Parked", { columnId: "backlog" });

test.describe("no Backlog column", () => {
  test.use({ seedOptions: seedBoard({ version: 1, columns, cards, archivedCards: archived }) });

  test("no Move to backlog; Settings offers Create backlog column and keeps the switch off until it exists", async ({ window, app, seeded }, testInfo) => {
    await openCardMenu(window, "t-1");
    await expect(window.getByRole("menuitem", { name: /Move to backlog/ })).toHaveCount(0);
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("kanban-archive-toggle")).toHaveText("Archive (1)");

    const settings = await openSettings(window, app);
    await setKanbanBoard(settings, true);
    await settingsTab(settings, "Kanban").click();
    const create = settings.getByRole("button", { name: "Create backlog column", exact: true });
    const on = backlogShelfButton(settings, true);
    await expect(create).toBeEnabled();
    await expect(settings.getByText("Creates the Backlog column in e2e")).toBeVisible();
    await expect(on).toBeDisabled();
    await settings.locator(".aya-settings-general-row").filter({ hasText: "Move backlog to shelf" }).screenshot({ path: testInfo.outputPath("settings-no-column.png") });
    await create.click();
    await expect(create).toBeDisabled();
    await expect(on).toBeEnabled();
    await expect(settings.getByText("The board already has a Backlog column")).toBeVisible();
    expect(readBoardFile(seeded.ayaHome).columns.map((c: { id: string }) => c.id)).toEqual(["backlog", "todo", "done"]);
    await settings.locator(".aya-settings-general-row").filter({ hasText: "Move backlog to shelf" }).screenshot({ path: testInfo.outputPath("settings-with-column.png") });
    await settings.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(window.getByTestId("kanban-column-backlog")).toBeVisible();
  });
});

test.describe("Backlog column, setting off (default)", () => {
  test.use({ seedOptions: seedBoard({ version: 1, columns: withBacklog, cards: [...cards, parked], archivedCards: archived }) });

  test("the column is on the board and Move to backlog moves a card into it", async ({ window, seeded }) => {
    await expect(window.getByTestId("kanban-column-backlog").getByTestId("kanban-card-t-4")).toBeVisible();
    // A card already in the Backlog column gets no Move to backlog item (a no-op move).
    await openCardMenu(window, "t-4");
    await expect(window.getByRole("menuitem", { name: /Move to backlog/ })).toHaveCount(0);
    await window.keyboard.press("Escape");
    await openCardMenu(window, "t-1");
    await window.getByRole("menuitem", { name: /Move to backlog/ }).click();
    await expect(window.getByTestId("kanban-column-backlog").getByTestId("kanban-card-t-1")).toBeVisible();
    expect(readBoardFile(seeded.ayaHome).cards.find((c: { id: string }) => c.id === "t-1").columnId).toBe("backlog");
    await expect(window.getByTestId("kanban-archive-toggle")).toHaveText("Archive (1)");
  });
});

test.describe("Backlog column, setting on", () => {
  test.use({ seedOptions: seedBoard({ version: 1, columns: backlogFirst, cards: [...cards, parked], archivedCards: archived }) });

  test("the column is in the shelf; Move to backlog, search and Restore work there", async ({ window, app }, testInfo) => {
    await setBacklogOnShelf(window, app, true);
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
    const drawer = await openShelfTab(window, "Backlog");
    await expect(shelfTab(drawer, "Backlog")).toHaveText("Backlog2");
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
    await setBacklogOnShelf(window, app, false);
    await expect(window.getByTestId("kanban-column-backlog").getByTestId("kanban-card-t-4")).toBeVisible();
    await expect(window.getByTestId("kanban-archive-toggle")).toHaveText("Archive (1)");
  });
});

test.describe("a card saved with the first version's shelf mark", () => {
  test.use({ seedOptions: seedBoard({ version: 1, columns, cards: [boardCard("t-1", "Later idea", { shelf: "backlog" }), boardCard("t-2", "Now")], archivedCards: archived }) });

  test("loads into a Backlog column: on the board while off, in the shelf while on", async ({ window, app }) => {
    await expect(window.getByTestId("kanban-column-backlog").getByTestId("kanban-card-t-1")).toBeVisible();
    await setBacklogOnShelf(window, app, true);
    await expect(window.getByTestId("kanban-column-backlog")).toHaveCount(0);
    const drawer = await openShelfTab(window, "Backlog");
    await expect(drawer.getByTestId("kanban-backlog-card-t-1")).toBeVisible();
  });
});

test.describe("the shelf preference on, board without a Backlog column", () => {
  test.use({ seedOptions: seedBoard({ version: 1, columns, cards, archivedCards: archived }) });

  test("no Backlog tab shows, and the switch can be turned off from that project", async ({ window, app }) => {
    await window.evaluate((key) => localStorage.setItem(key, "1"), KANBAN_BACKLOG_SHELF_STORAGE_KEY);
    await window.reload();
    await expect(window.getByTestId("kanban-column-todo")).toBeVisible();
    await expect(window.getByTestId("kanban-column-backlog")).toHaveCount(0);
    const drawer = await openShelf(window);
    await expect(shelfTab(drawer, "Backlog")).toHaveCount(0);
    await drawer.getByRole("button", { name: "Close archive" }).click();

    // The switch is a global preference: On still waits for the column, Off is turnable here.
    const settings = await openSettings(window, app);
    await setKanbanBoard(settings, true);
    await settingsTab(settings, "Kanban").click();
    const on = backlogShelfButton(settings, true);
    const off = backlogShelfButton(settings, false);
    await expect(on).toBeDisabled();
    await expect(on).toHaveClass(/aya-settings-segment--active/);
    await expect(off).toBeEnabled();
    await off.click();
    await expect(off).toHaveClass(/aya-settings-segment--active/);
    await settings.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(settings).toHaveCount(0);
    await expect.poll(() => window.evaluate((key) => localStorage.getItem(key), KANBAN_BACKLOG_SHELF_STORAGE_KEY)).toBe("0");
  });
});
