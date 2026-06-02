// Snippet normalization (autoRun default, malformed input, cap, name backfill).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSnippet,
  normalizeSnippets,
  isSnippet,
  SNIPPETS_MAX,
  SNIPPET_TEXT_MAX,
  DEFAULT_SNIPPETS,
} from "../dist-electron/snippets.js";

test("accepts a well-formed snippet", () => {
  const c = normalizeSnippet({
    id: "test",
    name: "npm test",
    text: "npm test",
    autoRun: true,
  });
  assert.deepEqual(c, {
    id: "test",
    name: "npm test",
    text: "npm test",
    autoRun: true,
  });
});

test("defaults autoRun to false when missing or non-boolean", () => {
  assert.equal(normalizeSnippet({ id: "a", text: "ls" }).autoRun, false);
  assert.equal(
    normalizeSnippet({ id: "a", text: "ls", autoRun: "yes" }).autoRun,
    false,
  );
});

test("backfills name from text when name is empty", () => {
  const c = normalizeSnippet({ id: "a", name: "  ", text: "  git status  " });
  assert.equal(c.name, "git status");
});

test("rejects snippets with empty id", () => {
  assert.equal(normalizeSnippet({ id: "", text: "ls" }), null);
  assert.equal(normalizeSnippet({ id: "   ", text: "ls" }), null);
});

test("rejects snippets with empty text (dead row)", () => {
  assert.equal(normalizeSnippet({ id: "a", text: "" }), null);
  assert.equal(normalizeSnippet({ id: "a", text: "   " }), null);
  assert.equal(normalizeSnippet({ id: "a" }), null);
});

test("rejects non-object input", () => {
  assert.equal(normalizeSnippet(null), null);
  assert.equal(normalizeSnippet("ls"), null);
  assert.equal(normalizeSnippet(42), null);
});

test("normalizeSnippets drops malformed entries and keeps valid ones", () => {
  const out = normalizeSnippets([
    { id: "ok", text: "ls", autoRun: false },
    { id: "", text: "bad" },
    null,
    { id: "ok2", text: "pwd", autoRun: true },
    { id: "blank", text: "   " },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((c) => c.id),
    ["ok", "ok2"],
  );
});

test("normalizeSnippets returns [] for non-array input", () => {
  assert.deepEqual(normalizeSnippets(undefined), []);
  assert.deepEqual(normalizeSnippets(null), []);
  assert.deepEqual(normalizeSnippets({ snippets: [] }), []);
});

test("normalizeSnippets enforces the cap", () => {
  // Pin the shipped cap to its contracted value with an independent literal so
  // a silent change to SNIPPETS_MAX (e.g. 200 -> 5) can't pass unnoticed —
  // otherwise the length assertion below is co-derived from the same constant.
  assert.equal(SNIPPETS_MAX, 200);
  const many = Array.from({ length: SNIPPETS_MAX + 50 }, (_, i) => ({
    id: `c${i}`,
    text: `cmd ${i}`,
  }));
  assert.equal(normalizeSnippets(many).length, 200);
  assert.equal(normalizeSnippets(many, 3).length, 3);
});

test("normalizeSnippets collapses duplicate ids (first wins)", () => {
  const out = normalizeSnippets([
    { id: "dup", name: "first", text: "echo 1", autoRun: false },
    { id: "dup", name: "second", text: "echo 2", autoRun: true },
    { id: "other", name: "other", text: "echo 3", autoRun: false },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((c) => c.id), ["dup", "other"]);
  assert.equal(out[0].name, "first", "first occurrence of a duplicate id wins");
});

test("normalizeSnippet rejects text over the length ceiling", () => {
  const ok = normalizeSnippet({ id: "a", text: "x".repeat(SNIPPET_TEXT_MAX) });
  assert.ok(ok, "text exactly at the ceiling is accepted");
  const tooLong = normalizeSnippet({ id: "a", text: "x".repeat(SNIPPET_TEXT_MAX + 1) });
  assert.equal(tooLong, null, "text over the ceiling is dropped");
});

test("DEFAULT_SNIPPETS are all valid and have unique ids", () => {
  assert.ok(DEFAULT_SNIPPETS.length >= 1);
  for (const c of DEFAULT_SNIPPETS) {
    assert.equal(isSnippet(c), true, `invalid default: ${JSON.stringify(c)}`);
    assert.deepEqual(normalizeSnippet(c), c, "default should survive normalize unchanged");
  }
  const ids = DEFAULT_SNIPPETS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "default ids must be unique");
});

test("isSnippet validates shape strictly", () => {
  assert.equal(isSnippet({ id: "a", name: "A", text: "ls", autoRun: false }), true);
  assert.equal(isSnippet({ id: "a", name: "A", text: "ls" }), false);
  assert.equal(isSnippet({ id: "", name: "A", text: "ls", autoRun: false }), false);
  assert.equal(isSnippet(null), false);
});
