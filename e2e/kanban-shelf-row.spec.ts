import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ElectronApplication, Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { fireShortcut } from "./helpers/shortcut";

// A shelf row on each tab: its meta line (column and the date it went onto the
// shelf), the Restore and delete buttons' titles and labels, the delete confirm
// step (cancelled by leaving the row) and Shift, held or pressed with the click,
// which deletes without asking.
const created = "2026-11-01T10:00:00.000Z";
const updated = "2026-11-07T10:00:00.000Z";
const archivedOn = "2026-11-03T10:00:00.000Z";
const card = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id, title, columnId: "todo", createdAt: created, updatedAt: updated, ...extra,
});
const columns = [{ id: "todo", title: "Todo" }, { id: "done", title: "Done" }, { id: "backlog", title: "Backlog" }];
const archived = [
  card("t-3", "Old", { columnId: "done", archivedAt: archivedOn }),
  card("t-5", "Older", { columnId: "done", archivedAt: archivedOn }),
];
const cards = [card("t-1", "Now"), card("t-4", "Parked", { columnId: "backlog" })];
test.use({ seedOptions: {
  rightTab: { presetId: "board", name: "Board" },
  ayaHomeFiles: { "boards/e2e-proj.json": JSON.stringify({ version: 1, columns, cards, archivedCards: archived }) },
} });

type BoardFile = { cards: Array<{ id: string }>; archivedCards: Array<{ id: string }> };
const boardFile = (ayaHome: string): BoardFile => JSON.parse(readFileSync(join(ayaHome, "boards", "e2e-proj.json"), "utf8"));
const ids = (list: Array<{ id: string }>) => list.map((c) => c.id);
// The row shows the date in the app's locale; ask the page rather than assume one.
const shownDate = (window: Page, iso: string) =>
  window.evaluate((d) => new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" }), iso);

async function shelfOn(window: Page, app: ElectronApplication) {
  await fireShortcut(app, "open-settings");
  const settings = window.locator(".aya-modal--settings");
  await settings.getByTestId("settings-tab").filter({ hasText: "General" }).click();
  await settings.getByLabel("Kanban board").getByRole("button", { name: "On", exact: true }).click();
  await settings.getByTestId("settings-tab").filter({ hasText: "Kanban" }).click();
  await settings.getByLabel("Move backlog to shelf", { exact: true }).getByRole("button", { name: "On", exact: true }).click();
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(settings).toHaveCount(0);
}

async function openShelf(window: Page, tab: "Archive" | "Backlog") {
  await window.getByTestId("kanban-archive-toggle").click();
  const drawer = window.getByTestId("kanban-archive-drawer");
  await drawer.getByRole("tab", { name: new RegExp(tab) }).click();
  return drawer;
}

async function confirmThenDelete(window: Page, drawer: Locator, row: Locator, deleteButton: Locator) {
  await deleteButton.click();
  const confirm = row.getByRole("button", { name: "Delete?", exact: true });
  await expect(confirm).toHaveAttribute("title", "Confirm permanent deletion");
  await expect(deleteButton).toHaveCount(0);
  // Leaving the row cancels the confirm step.
  await drawer.locator(".aya-kanban-archive-title").hover();
  await expect(confirm).toHaveCount(0);
  await expect(deleteButton).toBeVisible();
  await deleteButton.click();
  await row.getByRole("button", { name: "Delete?", exact: true }).click();
  await expect(row).toHaveCount(0);
}

test("an Archive row: meta, button titles and labels, confirm then delete", async ({ window, app, seeded }) => {
  await shelfOn(window, app);
  const drawer = await openShelf(window, "Archive");
  const row = drawer.getByTestId("kanban-archived-card-t-3");
  await expect(row.locator(".aya-kanban-archive-meta")).toHaveText(`Done · ${await shownDate(window, archivedOn)}`);
  await expect(row.getByRole("button", { name: /Restore/ })).toHaveAttribute("title", "Restore t-3 to Done");
  const del = row.getByRole("button", { name: "Delete archived card t-3", exact: true });
  await expect(del).toHaveAttribute("title", "Permanently delete from archive (hold Shift to skip confirmation)");
  await expect(del).toHaveText("×");

  await confirmThenDelete(window, drawer, row, del);
  await expect.poll(() => ids(boardFile(seeded.ayaHome).archivedCards)).toEqual(["t-5"]);
});

test("a Backlog row: meta, button titles and labels, confirm then delete", async ({ window, app, seeded }) => {
  await shelfOn(window, app);
  const drawer = await openShelf(window, "Backlog");
  const row = drawer.getByTestId("kanban-backlog-card-t-4");
  await expect(row.locator(".aya-kanban-archive-meta")).toHaveText(`Backlog · ${await shownDate(window, updated)}`);
  await expect(row.getByRole("button", { name: /Restore/ })).toHaveAttribute("title", "Restore t-4 to Todo");
  const del = row.getByRole("button", { name: "Delete backlog card t-4", exact: true });
  await expect(del).toHaveAttribute("title", "Permanently delete from backlog (hold Shift to skip confirmation)");

  await confirmThenDelete(window, drawer, row, del);
  await expect.poll(() => ids(boardFile(seeded.ayaHome).cards)).toEqual(["t-1"]);
});

test("Shift held marks the delete buttons, and Shift+click deletes without the confirm step", async ({ window, app, seeded }) => {
  await shelfOn(window, app);
  const drawer = await openShelf(window, "Archive");
  const del = drawer.getByRole("button", { name: "Delete archived card t-3", exact: true });
  await expect(del).not.toHaveClass(/aya-kanban-iconbtn--shift-ready/);

  await window.keyboard.down("Shift");
  await expect(del).toHaveAttribute("title", "Permanently delete card (Shift held)");
  await expect(del).toHaveText("⌫");
  await expect(del).toHaveClass(/aya-kanban-iconbtn--shift-ready/);
  await window.keyboard.up("Shift");
  await expect(del).toHaveAttribute("title", "Permanently delete from archive (hold Shift to skip confirmation)");
  await expect(del).toHaveText("×");

  await del.click({ modifiers: ["Shift"] });
  await expect(drawer.getByTestId("kanban-archived-card-t-3")).toHaveCount(0);
  await expect(drawer.getByRole("button", { name: "Delete?", exact: true })).toHaveCount(0);
  await expect.poll(() => ids(boardFile(seeded.ayaHome).archivedCards)).toEqual(["t-5"]);
});
