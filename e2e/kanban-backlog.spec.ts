import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { fireShortcut } from "./helpers/shortcut";

// Backlog (Settings > Kanban, off by default): Move to backlog in a card's menu
// takes the card off the board into a Backlog tab on the shelf; Restore puts it
// back. On disk the card stays in `cards` with "shelf": "backlog".
const at = "2026-11-12T10:00:00.000Z";
const card = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id, title, columnId: "todo", createdAt: at, updatedAt: at, ...extra,
});
const columns = [{ id: "todo", title: "Todo" }, { id: "done", title: "Done" }];
const board = {
  version: 1,
  columns,
  cards: [card("t-1", "Later idea", { labels: ["idea"] }), card("t-2", "Now")],
  archivedCards: [card("t-3", "Old", { columnId: "done", archivedAt: at })],
};
const seed = (b: unknown) => ({ rightTab: { presetId: "board", name: "Board" }, ayaHomeFiles: { "boards/e2e-proj.json": JSON.stringify(b) } });

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
  const backlog = settings.getByLabel("Backlog", { exact: true });
  await expect(backlog.getByRole("button", { name: "Off", exact: true })).toHaveClass(/aya-settings-segment--active/);
  if (on) await backlog.getByRole("button", { name: "On", exact: true }).click();
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(settings).toHaveCount(0);
}

test.describe("backlog off (default)", () => {
  test.use({ seedOptions: seed(board) });

  test("the card menu has no Move to backlog and the shelf has only Archive", async ({ window }) => {
    await openCardMenu(window, "t-1");
    await expect(window.getByRole("menuitem", { name: /Move to backlog/ })).toHaveCount(0);
    await window.keyboard.press("Escape");
    const toggle = window.getByTestId("kanban-archive-toggle");
    await expect(toggle).toHaveText("Archive (1)");
    await toggle.click();
    const drawer = window.getByTestId("kanban-archive-drawer");
    await expect(drawer.getByRole("tab")).toHaveCount(1);
    await expect(drawer.getByRole("tab", { name: /Backlog/ })).toHaveCount(0);
  });
});

test.describe("backlog on", () => {
  test.use({ seedOptions: seed(board) });

  test("Move to backlog takes a card off the board, and Restore puts it back", async ({ window, app, seeded }, testInfo) => {
    await setBacklog(window, app, true);
    await openCardMenu(window, "t-1");
    await window.getByRole("menuitem", { name: /Move to backlog/ }).click();
    await expect(window.getByTestId("kanban-card-t-1")).toHaveCount(0);
    await expect(window.getByTestId("kanban-card-t-2")).toBeVisible();
    const toggle = window.getByTestId("kanban-archive-toggle");
    await expect(toggle).toHaveText("Shelf (2)");
    const file = JSON.parse(readFileSync(join(seeded.ayaHome, "boards", "e2e-proj.json"), "utf8"));
    expect(file.cards.map((c: { id: string; shelf?: string }) => [c.id, c.shelf ?? null])).toEqual([["t-2", null], ["t-1", "backlog"]]);

    await toggle.click();
    const drawer = window.getByTestId("kanban-archive-drawer");
    const backlogTab = drawer.getByRole("tab", { name: /Backlog/ });
    await expect(backlogTab).toHaveText("Backlog1");
    await backlogTab.click();
    await expect(backlogTab).toHaveAttribute("aria-selected", "true");
    await expect(drawer.getByTestId("kanban-backlog-card-t-1")).toBeVisible();
    await expect(drawer.getByTestId("kanban-archived-card-t-3")).toHaveCount(0);
    await expect(drawer.getByRole("button", { name: "Empty", exact: true })).toHaveCount(0);
    const search = drawer.getByRole("searchbox", { name: "Search the backlog" });
    await search.fill("#nothing");
    await expect(drawer).toContainText("No matching backlog cards");
    await search.fill("#idea");
    await expect(drawer.getByTestId("kanban-backlog-card-t-1")).toBeVisible();
    await window.screenshot({ path: testInfo.outputPath("backlog-tab.png") });

    await drawer.getByTestId("kanban-backlog-card-t-1").getByRole("button", { name: /Restore/ }).click();
    await expect(window.getByTestId("kanban-column-todo").getByTestId("kanban-card-t-1")).toBeVisible();
    await expect(backlogTab).toHaveText("Backlog0/0");
    await search.fill("");
    await expect(drawer).toContainText("Backlog is empty.");
  });
});

test.describe("backlog off with cards already in it", () => {
  test.use({ seedOptions: seed({ ...board, cards: [card("t-1", "Later idea", { shelf: "backlog" }), card("t-2", "Now")] }) });

  test("the Backlog tab still shows them, but cards cannot be moved there", async ({ window }) => {
    await expect(window.getByTestId("kanban-card-t-1")).toHaveCount(0);
    const toggle = window.getByTestId("kanban-archive-toggle");
    await expect(toggle).toHaveText("Shelf (2)");
    await toggle.click();
    const drawer = window.getByTestId("kanban-archive-drawer");
    await drawer.getByRole("tab", { name: /Backlog/ }).click();
    await expect(drawer.getByTestId("kanban-backlog-card-t-1")).toBeVisible();
    await openCardMenu(window, "t-2");
    await expect(window.getByRole("menuitem", { name: /Move to backlog/ })).toHaveCount(0);
  });
});
