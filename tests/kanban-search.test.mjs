// The board filter's query language, shared by the board filter and the
// archive shelf search. Card fields and query tokens are what users type.

import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesSearchQuery } from "../dist-test/components/kanban-search.js";

const at = "2026-11-12T10:00:00.000Z";
const card = (id, title, columnId, extra = {}) => ({ id, title, columnId, createdAt: at, updatedAt: at, ...extra });
const cards = [
  card("t-1", "Fix auth timeout", "todo", { labels: ["auth"], priority: "high", assignee: "alice" }),
  card("t-2", "Write docs", "done", { labels: ["docs"], priority: "low", description: "Release notes" }),
  card("t-3", "Refactor parser", "todo", { priority: "urgent", claim: { paneName: "bob" } }),
  card("t-4", "Old auth fix", "done", { labels: ["auth"], archivedAt: at }),
];
const ids = (query, archived) => cards.filter((c) => matchesSearchQuery(c, query, archived)).map((c) => c.id);

test("an empty or blank query matches every card", () => {
  assert.deepEqual(ids(""), ["t-1", "t-2", "t-3", "t-4"]);
  assert.deepEqual(ids("   "), ["t-1", "t-2", "t-3", "t-4"]);
});

test("label, owner, priority and column tokens", () => {
  assert.deepEqual(ids("#auth"), ["t-1", "t-4"]);
  assert.deepEqual(ids("label:docs"), ["t-2"]);
  assert.deepEqual(ids("tag:au"), ["t-1", "t-4"]);
  assert.deepEqual(ids("@alice"), ["t-1"]);
  assert.deepEqual(ids("@bob"), ["t-3"], "a claim's pane name counts as the owner");
  assert.deepEqual(ids("owner:ali"), ["t-1"]);
  assert.deepEqual(ids("p0"), ["t-3"]);
  assert.deepEqual(ids("p1"), ["t-1"]);
  assert.deepEqual(ids("priority:low"), ["t-2"]);
  assert.deepEqual(ids("col:done"), ["t-2", "t-4"]);
});

test("state tokens use the archived flag when given, else archivedAt", () => {
  assert.deepEqual(ids("is:archived"), ["t-4"]);
  assert.deepEqual(ids("is:active"), ["t-1", "t-2", "t-3"]);
  assert.deepEqual(ids("is:archived", true), ["t-1", "t-2", "t-3", "t-4"]);
  assert.deepEqual(ids("is:claimed"), ["t-3"]);
  assert.deepEqual(ids("is:unassigned"), ["t-2", "t-4"]);
});

test("free text searches id, title, description and other fields; every token must match", () => {
  assert.deepEqual(ids("PARSER"), ["t-3"]);
  assert.deepEqual(ids("release"), ["t-2"], "description");
  assert.deepEqual(ids("t-4"), ["t-4"]);
  assert.deepEqual(ids("auth p1"), ["t-1"]);
  assert.deepEqual(ids("auth nothing-like-this"), []);
});
