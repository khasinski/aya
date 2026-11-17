import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { fireShortcut } from "./helpers/shortcut";

// Backlog (Settings > Kanban, off by default) is one Backlog column. Off, it is an
// ordinary column on the board. On, the board shows it in the shelf as a Backlog tab,
// and Move to backlog in a card's menu puts the card there, adding the column the first time.
const at = "2026-11-12T10:00:00.000Z";
const card = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id, title, columnId: "todo", createdAt: at, updatedAt: at, ...extra,
});
const columns = [{ id: "todo", title: "Todo" }, { id: "done", title: "Done" }];
const withBacklogColumn = [{ id: "todo", title: "Todo" }, { id: "done", title: "Done" }, { id: "backlog", title: "Backlog" }];
const archived = [card("t-3", "Old", { columnId: "done", archivedAt: at })];
const board = { version: 1, columns, cards: [card("t-1", "Later idea", { labels: ["idea"] }), card("t-2", "Now")], archivedCards: archived };
const seed = (b: unknown) => ({ rightTab: { presetId: "board", name: "Board" }, ayaHomeFiles: { "boards/e2e-proj.json": JSON.stringify(b) } });
const boardFile = (ayaHome: string) => JSON.parse(readFileSync(join(ayaHome, "boards", "e2e-proj.json"), "utf8"));

async function openCardMenu(window: Page, id: string) {
  await window.getByTestId(`kanban-card-${id}`).getByRole("button", { name: /Terminal/ }).click();
  await expect(window.getByRole("menuitem", { name: /Archive card/ })).toBeVisible();
}

async function setBacklog(window: Page, app: ElectronApplication, on: boolean) {
  await fireShortcut(app, "open-settings");
  const settings = window.locator(".aya-modal--settings");
  await settings.getByTestId("settings-tab").filter({ hasText: "General" }).click();
  await settings.getByLabel("Kanban board").getByRole("button", { name: "On", exact: true }).click();
  await settings.getByTestId("settings-tab").filter({ hasText: "Kanban" }).click();
  await settings.getByLabel("Backlog", { exact: true }).getByRole("button", { name: on ? "On" : "Off", exact: true }).click();
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(settings).toHaveCount(0);
}

async function openBacklogTab(window: Page) {
  await window.getByTestId("kanban-archive-toggle").click();
  const drawer = window.getByTestId("kanban-archive-drawer");
  await drawer.getByRole("tab", { name: /Backlog/ }).click();
  return drawer;
}

test.describe("off, no Backlog column (default)", () => {
  test.use({ seedOptions: seed(board) });

  test("no Move to backlog, no Backlog tab, no setting file", async ({ window, seeded }) => {
    expect(existsSync(join(seeded.ayaHome, "kanban.json"))).toBe(false);
    await openCardMenu(window, "t-1");
    await expect(window.getByRole("menuitem", { name: /Move to backlog/ })).toHaveCount(0);
    await window.keyboard.press("Escape");
    const toggle = window.getByTestId("kanban-archive-toggle");
    await expect(toggle).toHaveText("Archive (1)");
    await toggle.click();
    await expect(window.getByTestId("kanban-archive-drawer").getByRole("tab")).toHaveCount(1);
  });
});

test.describe("off, board with a Backlog column", () => {
  test.use({ seedOptions: seed({ ...board, columns: withBacklogColumn, cards: [...board.cards, card("t-4", "Parked", { columnId: "backlog" })] }) });

  test("the Backlog column is an ordinary column on the board", async ({ window }) => {
    await expect(window.getByTestId("kanban-column-backlog").getByTestId("kanban-card-t-4")).toBeVisible();
    await openCardMenu(window, "t-1");
    await expect(window.getByRole("menuitem", { name: /Move to backlog/ })).toHaveCount(0);
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("kanban-archive-toggle")).toHaveText("Archive (1)");
  });
});

test.describe("on, no Backlog column yet", () => {
  test.use({ seedOptions: seed(board) });

  test("Move to backlog adds the column at the end, the board hides it, and Restore puts the card back", async ({ window, app, seeded }, testInfo) => {
    await setBacklog(window, app, true);
    await expect.poll(() => existsSync(join(seeded.ayaHome, "kanban.json"))).toBe(true);
    await openCardMenu(window, "t-1");
    await window.getByRole("menuitem", { name: /Move to backlog/ }).click();
    await expect(window.getByTestId("kanban-card-t-1")).toHaveCount(0);
    await expect(window.getByTestId("kanban-column-backlog")).toHaveCount(0);
    const file = boardFile(seeded.ayaHome);
    expect(file.columns.map((c: { id: string }) => c.id)).toEqual(["todo", "done", "backlog"]);
    expect(Object.fromEntries(file.cards.map((c: { id: string; columnId: string }) => [c.id, c.columnId]))).toEqual({ "t-1": "backlog", "t-2": "todo" });

    await expect(window.getByTestId("kanban-archive-toggle")).toHaveText("Shelf (2)");
    const drawer = await openBacklogTab(window);
    await expect(drawer.getByRole("tab", { name: /Backlog/ })).toHaveText("Backlog1");
    await expect(drawer.getByTestId("kanban-backlog-card-t-1")).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Empty", exact: true })).toHaveCount(0);
    const search = drawer.getByRole("searchbox", { name: "Search the backlog" });
    await search.fill("#nothing");
    await expect(drawer).toContainText("No matching backlog cards");
    await search.fill("#idea");
    await expect(drawer.getByTestId("kanban-backlog-card-t-1")).toBeVisible();
    await window.screenshot({ path: testInfo.outputPath("backlog-tab.png") });
    await search.fill("");
    await drawer.getByTestId("kanban-backlog-card-t-1").getByRole("button", { name: /Restore/ }).click();
    await expect(window.getByTestId("kanban-column-todo").getByTestId("kanban-card-t-1")).toBeVisible();
    await expect(drawer).toContainText("Backlog is empty.");
  });
});

test.describe("on, board with a Backlog column holding a card", () => {
  test.use({ seedOptions: seed({ ...board, columns: withBacklogColumn, cards: [...board.cards, card("t-4", "Parked", { columnId: "backlog" })] }) });

  test("the column moves to the shelf and Move to backlog adds to it", async ({ window, app, seeded }) => {
    await setBacklog(window, app, true);
    await expect(window.getByTestId("kanban-column-backlog")).toHaveCount(0);
    await openCardMenu(window, "t-2");
    await window.getByRole("menuitem", { name: /Move to backlog/ }).click();
    await expect(window.getByTestId("kanban-card-t-2")).toHaveCount(0);
    expect(boardFile(seeded.ayaHome).columns.map((c: { id: string }) => c.id)).toEqual(["todo", "done", "backlog"]);
    const drawer = await openBacklogTab(window);
    await expect(drawer.getByRole("tab", { name: /Backlog/ })).toHaveText("Backlog2");
    await expect(drawer.getByTestId("kanban-backlog-card-t-4")).toBeVisible();
    await expect(drawer.getByTestId("kanban-backlog-card-t-2")).toBeVisible();
  });
});

test.describe("turned off again", () => {
  test.use({ seedOptions: seed(board) });

  test("the Backlog column comes back on the board with its cards", async ({ window, app, seeded }) => {
    await setBacklog(window, app, true);
    await openCardMenu(window, "t-1");
    await window.getByRole("menuitem", { name: /Move to backlog/ }).click();
    await expect(window.getByTestId("kanban-card-t-1")).toHaveCount(0);
    await setBacklog(window, app, false);
    await expect.poll(() => existsSync(join(seeded.ayaHome, "kanban.json"))).toBe(false);
    await expect(window.getByTestId("kanban-column-backlog").getByTestId("kanban-card-t-1")).toBeVisible();
    await openCardMenu(window, "t-2");
    await expect(window.getByRole("menuitem", { name: /Move to backlog/ })).toHaveCount(0);
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("kanban-archive-toggle")).toHaveText("Archive (1)");
  });
});

test.describe("a card saved with the first version's shelf mark", () => {
  test.use({ seedOptions: seed({ ...board, cards: [card("t-1", "Later idea", { shelf: "backlog" }), card("t-2", "Now")] }) });

  test("loads into the Backlog column: on the board while off, in the shelf while on", async ({ window, app }) => {
    await expect(window.getByTestId("kanban-column-backlog").getByTestId("kanban-card-t-1")).toBeVisible();
    await setBacklog(window, app, true);
    await expect(window.getByTestId("kanban-column-backlog")).toHaveCount(0);
    const drawer = await openBacklogTab(window);
    await expect(drawer.getByTestId("kanban-backlog-card-t-1")).toBeVisible();
  });
});
