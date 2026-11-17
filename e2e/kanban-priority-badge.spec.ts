import { test, expect } from "./fixtures";

// Pins how a card shows its priority: the short name on the badge and the full
// name in its tooltip, for each of the four priorities. Settings > Kanban pins
// the same names in its Priority row.
const at = "2026-11-12T10:00:00.000Z";
const card = (id: string, priority: string) => ({
  id, title: `Card ${id}`, columnId: "todo", priority, createdAt: at, updatedAt: at,
});
const BADGES = [
  { id: "t-1", priority: "urgent", text: "P0", title: "Priority: Urgent (click to filter)" },
  { id: "t-2", priority: "high", text: "P1", title: "Priority: High (click to filter)" },
  { id: "t-3", priority: "medium", text: "P2", title: "Priority: Medium (click to filter)" },
  { id: "t-4", priority: "low", text: "P3", title: "Priority: Low (click to filter)" },
];
const board = {
  version: 1,
  columns: [{ id: "todo", title: "Todo" }],
  cards: BADGES.map(({ id, priority }) => card(id, priority)),
};
test.use({ seedOptions: {
  rightTab: { presetId: "board", name: "Board" },
  ayaHomeFiles: { "boards/e2e-proj.json": JSON.stringify(board) },
} });

test("each card's priority badge shows the short name and the full name", async ({ window }) => {
  for (const { id, text, title } of BADGES) {
    const badge = window.getByTestId(`kanban-card-${id}`).locator(".aya-kanban-priority-badge");
    await expect(badge).toHaveText(text);
    await expect(badge).toHaveAttribute("title", title);
  }
});
