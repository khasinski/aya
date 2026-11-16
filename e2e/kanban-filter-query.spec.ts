import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

// Pins the board filter's query language as it works today (#label, label:,
// @owner, p0-p3, col:, is:archived, free text). The archive shelf reuses it.
// Card ids, labels and the query tokens are the external contract users type.
const at = "2026-11-12T10:00:00.000Z";
const card = (id: string, title: string, columnId: string, extra: Record<string, unknown> = {}) => ({
  id, title, columnId, createdAt: at, updatedAt: at, ...extra,
});
const board = {
  version: 1,
  columns: [{ id: "todo", title: "Todo" }, { id: "done", title: "Done" }],
  cards: [
    card("t-1", "Fix auth timeout", "todo", { labels: ["auth"], priority: "high", assignee: "alice" }),
    card("t-2", "Write docs", "done", { labels: ["docs"], priority: "low" }),
    card("t-3", "Refactor parser", "todo", { priority: "urgent", assignee: "bob" }),
  ],
  archivedCards: [
    card("t-4", "Old auth fix", "done", { labels: ["auth"], archivedAt: at }),
    card("t-5", "Old release", "done", { archivedAt: at }),
  ],
};
const BOARD_IDS = ["t-1", "t-2", "t-3"];
const ARCHIVED_IDS = ["t-4", "t-5"];
test.use({ seedOptions: {
  rightTab: { presetId: "board", name: "Board" },
  ayaHomeFiles: { "boards/e2e-proj.json": JSON.stringify(board) },
} });

async function expectShown(window: Page, testIdPrefix: string, all: string[], shown: string[]) {
  for (const id of all) {
    await expect(window.getByTestId(`${testIdPrefix}${id}`)).toHaveCount(shown.includes(id) ? 1 : 0);
  }
}

const CASES: { query: string; board: string[]; archive: string[] }[] = [
  { query: "#auth", board: ["t-1"], archive: ["t-4"] },
  { query: "label:docs", board: ["t-2"], archive: [] },
  { query: "@alice", board: ["t-1"], archive: [] },
  { query: "p0", board: ["t-3"], archive: [] },
  { query: "p1", board: ["t-1"], archive: [] },
  { query: "col:done", board: ["t-2"], archive: ["t-4", "t-5"] },
  { query: "is:archived", board: [], archive: ["t-4", "t-5"] },
  { query: "parser", board: ["t-3"], archive: [] },
  { query: "auth p1", board: ["t-1"], archive: [] },
  { query: "old", board: [], archive: ["t-4", "t-5"] },
];

test("the board filter narrows board and archived cards by its query language", async ({ window }) => {
  const filter = window.getByRole("searchbox", { name: "Filter cards" });
  await window.getByTestId("kanban-archive-toggle").click();
  await expect(window.getByTestId("kanban-archive-drawer")).toBeVisible();
  for (const { query, board: onBoard, archive } of CASES) {
    await test.step(query, async () => {
      await filter.fill(query);
      await expectShown(window, "kanban-card-", BOARD_IDS, onBoard);
      await expectShown(window, "kanban-archived-card-", ARCHIVED_IDS, archive);
    });
  }
  await filter.fill("");
  await expectShown(window, "kanban-card-", BOARD_IDS, BOARD_IDS);
  await expectShown(window, "kanban-archived-card-", ARCHIVED_IDS, ARCHIVED_IDS);
});
