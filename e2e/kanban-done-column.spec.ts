import { test, expect } from "./fixtures";

// The board treats a column as finished work when its id is "done" or its title
// reads "Done": only there can cards be archived, one by one or all at once.
// Column ids and titles stay literal here: they are what board files store.
const card = (id: string, columnId: string) => ({
  id, title: `Card ${id}`, columnId,
  createdAt: "2026-11-12T10:00:00.000Z", updatedAt: "2026-11-12T10:00:00.000Z",
});
const board = {
  version: 1,
  columns: [{ id: "todo", title: "Todo" }, { id: "done", title: "Done" }, { id: "shipped", title: "Done" }],
  cards: [card("t-1", "todo"), card("t-2", "done"), card("t-3", "shipped")],
};
test.use({ seedOptions: {
  rightTab: { presetId: "board", name: "Board" },
  ayaHomeFiles: { "boards/e2e-proj.json": JSON.stringify(board) },
} });

test("only a Done column offers to archive its cards, by id or by title", async ({ window }) => {
  for (const [columnId, cardId] of [["done", "t-2"], ["shipped", "t-3"]] as const) {
    const column = window.getByTestId(`kanban-column-${columnId}`);
    await expect(column.locator(".aya-kanban-col-clear-btn")).toHaveCount(1);
    await expect(column.getByRole("button", { name: `Archive card ${cardId}`, exact: true })).toHaveCount(1);
  }
  const todo = window.getByTestId("kanban-column-todo");
  await expect(todo.getByTestId("kanban-card-t-1")).toBeVisible();
  await expect(todo.locator(".aya-kanban-col-clear-btn")).toHaveCount(0);
  await expect(todo.getByRole("button", { name: "Archive card t-1", exact: true })).toHaveCount(0);
});
