import { test, expect } from "./fixtures";
import { boardCard, BOARD_SEED_TIME, reloadWithKanban, seedBoard, showBoard } from "./helpers/board";
import { HARNESS_SEARCH_STORAGE_KEY } from "../src/storage-keys";

// The board toolbar must not move when the filter box gains or loses focus:
// a click on a toolbar button while the filter has focus blurs it on mousedown,
// and a toolbar that re-wraps then moves the button from under the pointer.
// Checked in every window layout (all experimental) with the board both as the
// right half of a split and as the only pane, with Kanban and harness search on.
const board = {
  version: 1,
  columns: [{ id: "todo", title: "Todo" }, { id: "done", title: "Done" }],
  cards: [boardCard("t-1", "Live task", { columnId: "done" })],
  archivedCards: [boardCard("t-2", "Old task", { columnId: "done", archivedAt: BOARD_SEED_TIME })],
};
const LAYOUTS = ["classic", "projects-left", "stacked"] as const;
const PANES = [
  { name: "split", seed: { pane: "right" } },
  { name: "single", seed: { pane: "single", split: false } },
] as const;

for (const layout of LAYOUTS) {
  for (const pane of PANES) {
    test.describe(`${layout} ${pane.name}`, () => {
      test.use({ seedOptions: seedBoard(board, pane.seed) });

      test("the toolbar stays put while the filter has focus, so Archive opens on the first click", async ({ window }, testInfo) => {
        await reloadWithKanban(window, layout, { [HARNESS_SEARCH_STORAGE_KEY]: "1" });
        // The Stacked layout puts the board toolbar in the window's title bar,
        // outside the board pane, so look in the whole window.
        const toggle = window.getByTestId("kanban-archive-toggle");
        const filter = window.getByRole("searchbox", { name: "Filter cards" });
        await showBoard(window);
        await expect(toggle).toBeVisible();

        // Typed text adds a match count and changes the button label, so compare
        // the same text with and without focus.
        await filter.fill("old");
        await expect(toggle).toHaveText("Archive (1/1)");
        await filter.evaluate((el) => (el as HTMLElement).blur());
        await expect(filter).not.toBeFocused();
        const blurred = await toggle.boundingBox();
        await window.screenshot({ path: testInfo.outputPath(`${layout}-${pane.name}-1-filter-blurred.png`) });
        await filter.focus();
        await expect(filter).toBeFocused();
        await expect.poll(async () => toggle.boundingBox()).toEqual(blurred);
        await window.screenshot({ path: testInfo.outputPath(`${layout}-${pane.name}-2-filter-focused.png`) });

        await toggle.click();
        await expect(window.getByTestId("kanban-archive-drawer")).toBeVisible();
        await expect(window.getByTestId("kanban-archived-card-t-2")).toBeVisible();
        await window.screenshot({ path: testInfo.outputPath(`${layout}-${pane.name}-3-archive-open.png`) });
      });
    });
  }
}
