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

  test("no Move to backlog and no Backlog tab, with the setting off or on", async ({ window, app }) => {
    for (const on of [false, true]) {
      if (on) await setShelf(window, app, true);
      await openCardMenu(window, "t-1");
      await expect(window.getByRole("menuitem", { name: /Move to backlog/ })).toHaveCount(0);
      await window.keyboard.press("Escape");
      await expect(window.getByTestId("kanban-archive-toggle")).toHaveText("Archive (1)");
    }
    await window.getByTestId("kanban-archive-toggle").click();
    await expect(window.getByTestId("kanban-archive-drawer").getByRole("tab")).toHaveCount(1);
  });
});

test.describe("Backlog column, setting off (default)", () => {
  test.use({ seedOptions: seed({ version: 1, columns: withBacklog, cards: [...cards, parked], archivedCards: archived }) });

  test("the column is on the board and Move to backlog moves a card into it", async ({ window, seeded }) => {
    await expect(window.getByTestId("kanban-column-backlog").getByTestId("kanban-card-t-4")).toBeVisible();
    await openCardMenu(window, "t-1");
    await window.getByRole("menuitem", { name: /Move to backlog/ }).click();
    await expect(window.getByTestId("kanban-column-backlog").getByTestId("kanban-card-t-1")).toBeVisible();
    expect(boardFile(seeded.ayaHome).cards.find((c: { id: string }) => c.id === "t-1").columnId).toBe("backlog");
    await expect(window.getByTestId("kanban-archive-toggle")).toHaveText("Archive (1)");
  });
});

test.describe("Backlog column, setting on", () => {
  test.use({ seedOptions: seed({ version: 1, columns: withBacklog, cards: [...cards, parked], archivedCards: archived }) });

  test("the column is in the shelf; Move to backlog, search and Restore work there", async ({ window, app }, testInfo) => {
    await setShelf(window, app, true);
    await expect(window.getByTestId("kanban-column-backlog")).toHaveCount(0);
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
