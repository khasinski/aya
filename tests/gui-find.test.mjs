// Finding text in a Conversation GUI pane, and the turn timer next to its status.

import { test } from "node:test";
import assert from "node:assert/strict";
import { findStatus, findTextMatches, stepMatch } from "../dist-test/gui-find.js";
import { formatElapsed } from "../dist-test/gui-status.js";

test("matches are case-insensitive, non-overlapping and carry their offsets", () => {
  assert.deepEqual(findTextMatches("Foo foo FOO", "foo"), [{ start: 0, length: 3 }, { start: 4, length: 3 }, { start: 8, length: 3 }]);
  assert.deepEqual(findTextMatches("aaaa", "aa"), [{ start: 0, length: 2 }, { start: 2, length: 2 }]);
  assert.deepEqual(findTextMatches("a.b", "."), [{ start: 1, length: 1 }], "no regular expressions");
});

test("an empty query, or text whose case folding changes its length, matches nothing", () => {
  assert.deepEqual(findTextMatches("anything", ""), []);
  assert.deepEqual(findTextMatches("anything", "   "), []);
  assert.deepEqual(findTextMatches("İstanbul", "i"), []);
});

test("Enter and Shift+Enter step through the matches and wrap", () => {
  assert.equal(stepMatch(-1, 3, 1), 0);
  assert.equal(stepMatch(-1, 3, -1), 2);
  assert.equal(stepMatch(2, 3, 1), 0);
  assert.equal(stepMatch(0, 3, -1), 2);
  assert.equal(stepMatch(0, 0, 1), -1);
});

test("the find bar's status", () => {
  assert.equal(findStatus("", 0, 0), "");
  assert.equal(findStatus("x", -1, 0), "No results");
  assert.equal(findStatus("x", 2, 12), "3 of 12");
});

test("elapsed time reads as seconds, minutes or hours", () => {
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(42_900), "42s");
  assert.equal(formatElapsed(187_000), "3m 07s");
  assert.equal(formatElapsed(3_900_000), "1h 05m");
  assert.equal(formatElapsed(-5), "0s");
});
