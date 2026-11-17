import { test, expect } from "./fixtures";
import { HARNESS_SEARCH_STORAGE_KEY, KANBAN_STORAGE_KEY, LAYOUT_MODE_STORAGE_KEY } from "../src/storage-keys";

// The board toolbar must not move when the filter box gains or loses focus:
// a click on a toolbar button while the filter has focus blurs it on mousedown,
// and a toolbar that re-wraps then moves the button from under the pointer.
// Checked in every window layout (all experimental) with the board both as the
// right half of a split and as the only pane, with Kanban and harness search on.
const at = "2026-11-12T10:00:00.000Z";
const card = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id, title, columnId: "done", createdAt: at, updatedAt: at, ...extra,
});
const board = {
  version: 1,
  columns: [{ id: "todo", title: "Todo" }, { id: "done", title: "Done" }],
  cards: [card("t-1", "Live task")],
  archivedCards: [card("t-2", "Old task", { archivedAt: at })],
};
const boardTab = { presetId: "board", name: "Board" };
/** How long a board already on screen may take to render after a reload. */
const BOARD_SHOWS_WITHIN_MS = 3_000;
const LAYOUTS = ["classic", "projects-left", "stacked"] as const;
const PANES = [
  { name: "split", seed: { rightTab: boardTab } },
  { name: "single", seed: { singleTab: boardTab, split: false } },
] as const;

for (const layout of LAYOUTS) {
  for (const pane of PANES) {
    test.describe(`${layout} ${pane.name}`, () => {
      test.use({ seedOptions: { ...pane.seed, ayaHomeFiles: { "boards/e2e-proj.json": JSON.stringify(board) } } });

      test("the toolbar stays put while the filter has focus, so Archive opens on the first click", async ({ window }, testInfo) => {
        await window.evaluate((keys) => {
          localStorage.setItem(keys.layout, keys.value);
          localStorage.setItem(keys.kanban, "1");
          localStorage.setItem(keys.harnessSearch, "1");
        }, { layout: LAYOUT_MODE_STORAGE_KEY, value: layout, kanban: KANBAN_STORAGE_KEY, harnessSearch: HARNESS_SEARCH_STORAGE_KEY });
        await window.reload();
        // The Stacked layout puts the board toolbar in the window's title bar,
        // outside the board pane, so look in the whole window.
        const toggle = window.getByTestId("kanban-archive-toggle");
        const filter = window.getByRole("searchbox", { name: "Filter cards" });
        // Layouts that show panes as tabs keep the board behind its Kanban tab.
        const launcher = window.getByRole("button", { name: "Kanban", exact: true });
        await expect(launcher).toBeVisible();
        // Give the board time to show before opening its tab: a check at one instant raced
        // its first render, and the launcher click then hid an active board.
        const shown = await toggle.waitFor({ state: "visible", timeout: BOARD_SHOWS_WITHIN_MS }).then(() => true, () => false);
        if (!shown) await launcher.click();
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
