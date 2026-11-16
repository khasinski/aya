import { test, expect } from "./fixtures";
import { KANBAN_STORAGE_KEY, LAYOUT_MODE_STORAGE_KEY } from "../src/storage-keys";

// The board drawer is a shelf: an Archive tab (Backlog comes later, opt-in)
// and a search of its own in the board filter's query language. The toolbar
// button that opens it keeps its "Archive (n)" label.
const at = "2026-11-12T10:00:00.000Z";
const card = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id, title, columnId: "done", createdAt: at, updatedAt: at, ...extra,
});
const board = {
  version: 1,
  columns: [{ id: "todo", title: "Todo" }, { id: "done", title: "Done" }],
  cards: [card("t-1", "Live login task")],
  archivedCards: [
    card("t-2", "Fix login bug", { labels: ["auth"], archivedAt: at }),
    card("t-3", "Write release notes", { archivedAt: at }),
  ],
};
test.use({ seedOptions: {
  rightTab: { presetId: "board", name: "Board" },
  ayaHomeFiles: { "boards/e2e-proj.json": JSON.stringify(board) },
} });

test("the drawer is a shelf with an Archive tab and its own search", async ({ window }, testInfo) => {
  const toggle = window.getByTestId("kanban-archive-toggle");
  await expect(toggle).toHaveText("Archive (2)");
  await toggle.click();
  const drawer = window.getByTestId("kanban-archive-drawer");
  await expect(drawer.locator(".aya-kanban-archive-title")).toHaveText("Shelf");
  const tab = drawer.getByRole("tab", { name: /Archive/ });
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
  await window.getByTestId("kanban-archive-toggle").click();
  const drawer = window.getByTestId("kanban-archive-drawer");
  await expect(drawer).toBeVisible();
  await window.getByRole("searchbox", { name: "Filter cards" }).fill("is:archived");
  await expect(drawer.getByTestId("kanban-archived-card-t-2")).toBeVisible();
  await expect(drawer.getByTestId("kanban-archived-card-t-3")).toBeVisible();
  await drawer.getByRole("searchbox", { name: "Search the archive" }).fill("release");
  await expect(drawer.getByTestId("kanban-archived-card-t-2")).toHaveCount(0);
  await expect(drawer.getByTestId("kanban-archived-card-t-3")).toBeVisible();
  await expect(drawer.getByRole("tab", { name: /Archive/ })).toHaveText("Archive1/2");
});

// The shelf in every window layout (all experimental), with the board as half
// of a split and as the only pane. Stacked puts the board toolbar in the title
// bar, and the tab layouts keep the board behind its Kanban tab.
const boardTab = { presetId: "board", name: "Board" };
for (const layout of ["classic", "projects-left", "stacked"] as const) {
  for (const pane of [
    { name: "split", seed: { rightTab: boardTab } },
    { name: "single", seed: { singleTab: boardTab, split: false } },
  ] as const) {
    test.describe(`${layout} ${pane.name}`, () => {
      test.use({ seedOptions: { ...pane.seed, ayaHomeFiles: { "boards/e2e-proj.json": JSON.stringify(board) } } });

      test("the shelf opens and searches its archive", async ({ window }, testInfo) => {
        await window.evaluate((keys) => {
          localStorage.setItem(keys.layout, keys.value);
          localStorage.setItem(keys.kanban, "1");
        }, { layout: LAYOUT_MODE_STORAGE_KEY, value: layout, kanban: KANBAN_STORAGE_KEY });
        await window.reload();
        const toggle = window.getByTestId("kanban-archive-toggle");
        const launcher = window.getByRole("button", { name: "Kanban", exact: true });
        await expect(launcher).toBeVisible();
        if (!(await toggle.isVisible())) await launcher.click();
        await toggle.click();
        const drawer = window.getByTestId("kanban-archive-drawer");
        await expect(drawer.locator(".aya-kanban-archive-title")).toHaveText("Shelf");
        await expect(drawer.getByRole("tab", { name: /Archive/ })).toHaveText("Archive2");
        await drawer.getByRole("searchbox", { name: "Search the archive" }).fill("login");
        await expect(drawer.getByTestId("kanban-archived-card-t-2")).toBeVisible();
        await expect(drawer.getByTestId("kanban-archived-card-t-3")).toHaveCount(0);
        await expect(drawer.getByRole("tab", { name: /Archive/ })).toHaveText("Archive1/2");
        await window.screenshot({ path: testInfo.outputPath(`shelf-${layout}-${pane.name}.png`) });
      });
    });
  }
}
