import { test, expect } from "./fixtures";
import { boardCard, BOARD_SEED_TIME, openShelf, reloadWithKanban, seedBoard, shelfTab, showBoard } from "./helpers/board";

// The board drawer is a shelf: an Archive tab (Backlog comes later, opt-in)
// and a search of its own in the board filter's query language. The toolbar
// button that opens it keeps its "Archive (n)" label.
const board = {
  version: 1,
  columns: [{ id: "todo", title: "Todo" }, { id: "done", title: "Done" }],
  cards: [boardCard("t-1", "Live login task", { columnId: "done" })],
  archivedCards: [
    boardCard("t-2", "Fix login bug", { columnId: "done", labels: ["auth"], archivedAt: BOARD_SEED_TIME }),
    boardCard("t-3", "Write release notes", { columnId: "done", archivedAt: BOARD_SEED_TIME }),
  ],
};
test.use({ seedOptions: seedBoard(board) });

test("the drawer is a shelf with an Archive tab and its own search", async ({ window }, testInfo) => {
  await expect(window.getByTestId("kanban-archive-toggle")).toHaveText("Archive (2)");
  const drawer = await openShelf(window);
  await expect(drawer.locator(".aya-kanban-archive-title")).toHaveText("Shelf");
  const tab = shelfTab(drawer, "Archive");
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(tab).toHaveText("Archive2");

  const search = drawer.getByRole("searchbox", { name: "Search the archive" });
  await search.fill("login");
  await expect(drawer.getByTestId("kanban-archived-card-t-2")).toBeVisible();
  await expect(drawer.getByTestId("kanban-archived-card-t-3")).toHaveCount(0);
  await expect(tab).toHaveText("Archive1/2");
  await expect(window.getByTestId("kanban-card-t-1")).toBeVisible(); // the board itself is not filtered
  await window.screenshot({ path: testInfo.outputPath("shelf-search.png") });

  await search.fill("#auth"); // the board filter's tokens work here too
  await expect(drawer.getByTestId("kanban-archived-card-t-2")).toBeVisible();
  await expect(drawer.getByTestId("kanban-archived-card-t-3")).toHaveCount(0);

  await search.fill("nothing-like-this");
  await expect(drawer).toContainText("No matching archived cards");

  await search.fill("");
  await expect(drawer.getByTestId("kanban-archived-card-t-3")).toBeVisible();
  await expect(tab).toHaveText("Archive2");
});

test("the board filter still narrows the shelf, and the shelf search narrows further", async ({ window }) => {
  // Open first: while the filter box has focus it is wider, and the blur on
  // mousedown re-wraps the toolbar so the Archive button moves (also on main).
  const drawer = await openShelf(window);
  await expect(drawer).toBeVisible();
  await window.getByRole("searchbox", { name: "Filter cards" }).fill("is:archived");
  await expect(drawer.getByTestId("kanban-archived-card-t-2")).toBeVisible();
  await expect(drawer.getByTestId("kanban-archived-card-t-3")).toBeVisible();
  await drawer.getByRole("searchbox", { name: "Search the archive" }).fill("release");
  await expect(drawer.getByTestId("kanban-archived-card-t-2")).toHaveCount(0);
  await expect(drawer.getByTestId("kanban-archived-card-t-3")).toBeVisible();
  await expect(shelfTab(drawer, "Archive")).toHaveText("Archive1/2");
});

// The shelf in every window layout (all experimental), with the board as half
// of a split and as the only pane. Stacked puts the board toolbar in the title
// bar, and the tab layouts keep the board behind its Kanban tab.
for (const layout of ["classic", "projects-left", "stacked"] as const) {
  for (const pane of [
    { name: "split", seed: { pane: "right" } },
    { name: "single", seed: { pane: "single", split: false } },
  ] as const) {
    test.describe(`${layout} ${pane.name}`, () => {
      test.use({ seedOptions: seedBoard(board, pane.seed) });

      test("the shelf opens and searches its archive", async ({ window }, testInfo) => {
        await reloadWithKanban(window, layout);
        await showBoard(window);
        const drawer = await openShelf(window);
        await expect(drawer.locator(".aya-kanban-archive-title")).toHaveText("Shelf");
        await expect(shelfTab(drawer, "Archive")).toHaveText("Archive2");
        await drawer.getByRole("searchbox", { name: "Search the archive" }).fill("login");
        await expect(drawer.getByTestId("kanban-archived-card-t-2")).toBeVisible();
        await expect(drawer.getByTestId("kanban-archived-card-t-3")).toHaveCount(0);
        await expect(shelfTab(drawer, "Archive")).toHaveText("Archive1/2");
        await window.screenshot({ path: testInfo.outputPath(`shelf-${layout}-${pane.name}.png`) });
      });
    });
  }
}
