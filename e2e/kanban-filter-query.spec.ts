import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { boardCard, BOARD_SEED_TIME, openShelf, seedBoard } from "./helpers/board";

// Pins the board filter's query language as it works today (#label, label:,
// @owner, p0-p3, col:, is:archived, free text). The archive shelf reuses it.
// Card ids, labels and the query tokens are the external contract users type.
const board = {
  version: 1,
  columns: [{ id: "todo", title: "Todo" }, { id: "done", title: "Done" }],
  cards: [
    boardCard("t-1", "Fix auth timeout", { columnId: "todo", labels: ["auth"], priority: "high", assignee: "alice" }),
    boardCard("t-2", "Write docs", { columnId: "done", labels: ["docs"], priority: "low" }),
    boardCard("t-3", "Refactor parser", { columnId: "todo", priority: "urgent", assignee: "bob" }),
  ],
  archivedCards: [
    boardCard("t-4", "Old auth fix", { columnId: "done", labels: ["auth"], archivedAt: BOARD_SEED_TIME }),
    boardCard("t-5", "Old release", { columnId: "done", archivedAt: BOARD_SEED_TIME }),
  ],
};
const BOARD_IDS = ["t-1", "t-2", "t-3"];
const ARCHIVED_IDS = ["t-4", "t-5"];
test.use({ seedOptions: seedBoard(board) });

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
  await expect(await openShelf(window)).toBeVisible();
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
