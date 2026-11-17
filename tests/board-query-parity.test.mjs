// The board query language is written twice: src/components/kanban-search.ts
// (the board filter and shelf search in the renderer) and matchesBoardQuery in
// electron/board.ts (`aya board search`). This runs one table of queries through
// both and pins what each returns, so neither side changes what users get
// without this table changing too.
//
// An empty priority token ("p:" or "priority:") is ignored on both sides, as
// the board filter always did; aya board search used to keep only cards without
// a priority.

import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesSearchQuery } from "../dist-test/components/kanban-search.js";

const { matchesBoardQuery } = await import("../dist-electron/board.js");

const at = "2026-11-12T10:00:00.000Z";
const card = (id, title, columnId, extra = {}) => ({ id, title, columnId, createdAt: at, updatedAt: at, ...extra });
const CARDS = [
  card("t-1", "Fix auth timeout", "todo", { labels: ["auth"], priority: "high", assignee: "alice" }),
  card("t-2", "Write docs", "done", { labels: ["docs"], priority: "low", description: "Release notes" }),
  card("t-3", "Refactor parser", "in-progress", { priority: "urgent", claim: { paneName: "Bob" } }),
  card("t-4", "Old auth fix", "done", { labels: ["Auth"], archivedAt: at }),
  card("t-5", "Medium thing", "review", { priority: "medium" }),
  card("t-6", "plain", "todo"),
];

const renderer = (query, archived) =>
  CARDS.filter((c) => (archived === undefined ? matchesSearchQuery(c, query) : matchesSearchQuery(c, query, archived))).map((c) => c.id);
const cli = (query, archived) =>
  CARDS.filter((c) => (archived === undefined ? matchesBoardQuery(c, query) : matchesBoardQuery(c, query, { isArchived: archived }))).map((c) => c.id);

// `want`: both sides return it.
// `archived`: the archived flag the caller passes; without it, each side reads card.archivedAt.
const ROWS = [
  { query: "", want: ["t-1", "t-2", "t-3", "t-4", "t-5", "t-6"] },
  { query: "   ", want: ["t-1", "t-2", "t-3", "t-4", "t-5", "t-6"] },
  { query: "#auth", want: ["t-1", "t-4"] },
  { query: "#AUTH", want: ["t-1", "t-4"] },
  { query: "#", want: [] },
  { query: "label:docs", want: ["t-2"] },
  { query: "label:", want: ["t-1", "t-2", "t-3", "t-4", "t-5", "t-6"] },
  { query: "tag:au", want: ["t-1", "t-4"] },
  { query: "tag:", want: ["t-1", "t-2", "t-3", "t-4", "t-5", "t-6"] },
  { query: "@alice", want: ["t-1"] },
  { query: "@bob", want: ["t-3"] },
  { query: "@", want: [] },
  { query: "owner:ali", want: ["t-1"] },
  { query: "owner:", want: ["t-1", "t-2", "t-3", "t-4", "t-5", "t-6"] },
  { query: "assignee:bob", want: ["t-3"] },
  { query: "assignee:", want: ["t-1", "t-2", "t-3", "t-4", "t-5", "t-6"] },
  { query: "p0", want: ["t-3"] },
  { query: "p1", want: ["t-1"] },
  { query: "p2", want: ["t-5"] },
  { query: "p3", want: ["t-2"] },
  { query: "P0", want: ["t-3"] },
  { query: "p4", want: [] },
  { query: "p:p0", want: ["t-3"] },
  { query: "p:urgent", want: ["t-3"] },
  { query: "p:high", want: ["t-1"] },
  { query: "priority:p2", want: ["t-5"] },
  { query: "priority:low", want: ["t-2"] },
  { query: "priority:URGENT", want: ["t-3"] },
  { query: "p:none", want: [] },
  // An empty priority token is ignored.
  { query: "p:", want: ["t-1", "t-2", "t-3", "t-4", "t-5", "t-6"] },
  { query: "priority:", want: ["t-1", "t-2", "t-3", "t-4", "t-5", "t-6"] },
  { query: "p: #auth", want: ["t-1", "t-4"] },
  { query: "urgent", want: ["t-3"] },
  { query: "medium", want: ["t-5"] },
  { query: "col:done", want: ["t-2", "t-4"] },
  { query: "column:in", want: ["t-3"] },
  { query: "COL:Review", want: ["t-5"] },
  { query: "col:", want: ["t-1", "t-2", "t-3", "t-4", "t-5", "t-6"] },
  { query: "is:archived", want: ["t-4"] },
  { query: "is:archived", archived: true, want: ["t-1", "t-2", "t-3", "t-4", "t-5", "t-6"] },
  { query: "is:archived", archived: false, want: [] },
  { query: "in:archive", want: ["t-4"] },
  { query: "is:active", want: ["t-1", "t-2", "t-3", "t-5", "t-6"] },
  { query: "is:active", archived: true, want: [] },
  { query: "is:open", want: ["t-1", "t-2", "t-3", "t-5", "t-6"] },
  { query: "is:claimed", want: ["t-3"] },
  { query: "is:unassigned", want: ["t-2", "t-4", "t-5", "t-6"] },
  { query: "PARSER", want: ["t-3"] },
  { query: "release", want: ["t-2"] },
  { query: "t-4", want: ["t-4"] },
  { query: "auth p1", want: ["t-1"] },
  { query: "auth   nothing-like-this", want: [] },
  { query: "#auth is:active", want: ["t-1"] },
  { query: "#auth @alice p1 col:todo", want: ["t-1"] },
];

for (const row of ROWS) {
  const name = `${JSON.stringify(row.query)}${row.archived === undefined ? "" : ` (archived: ${row.archived})`}`;
  test(`board filter and aya board search agree on ${name}`, () => {
    assert.deepEqual(renderer(row.query, row.archived), row.want, "board filter");
    assert.deepEqual(cli(row.query, row.archived), row.want, "aya board search");
  });
}

test("the table covers every token kind of the query language", () => {
  const queries = ROWS.map((row) => row.query.toLowerCase()).join(" ");
  for (const token of ["#", "label:", "tag:", "@", "owner:", "assignee:", "p0", "p1", "p2", "p3", "p:", "priority:",
    "col:", "column:", "is:archived", "in:archive", "is:active", "is:open", "is:claimed", "is:unassigned"]) {
    assert.ok(queries.includes(token), token);
  }
});
