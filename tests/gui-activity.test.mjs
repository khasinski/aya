// Grouping the tool calls of a turn into phases.

import { test } from "node:test";
import assert from "node:assert/strict";
import { activityDuration, activityKind, activityPhases, phaseText, shortDuration } from "../dist-test/gui-activity.js";

const a = (kind, startedAt, endedAt) => ({ kind, startedAt, endedAt });

test("item types map to kinds", () => {
  assert.equal(activityKind("commandExecution"), "command");
  assert.equal(activityKind("fileChange"), "edit");
  assert.equal(activityKind("webSearch"), "web");
  assert.equal(activityKind("mcpToolCall"), "tool");
  assert.equal(activityKind("dynamicToolCall"), "tool");
});

test("a call has a duration only once it has ended", () => {
  assert.equal(activityDuration(a("command", 1000, 3500)), 2500);
  assert.equal(activityDuration(a("command", 1000)), null);
  assert.equal(activityDuration({ kind: "command" }), null);
  assert.equal(activityDuration(a("command", 5000, 4000)), 0);
});

test("consecutive calls of one kind form a phase; a lone call does not", () => {
  const list = [a("command", 0, 1000), a("command", 1000, 3000), a("edit", 3000, 3500), a("command", 4000, 5000), a("command", 5000, 5500), a("command", 5500, 6000)];
  assert.deepEqual(activityPhases(list), [
    { index: 0, kind: "command", label: "Commands", count: 2, ms: 3000 },
    { index: 3, kind: "command", label: "Commands", count: 3, ms: 2000 },
  ]);
});

test("a phase with no timings shows no time", () => {
  const phases = activityPhases([{ kind: "web" }, { kind: "web" }]);
  assert.equal(phases[0].ms, null);
  assert.equal(phaseText(phases[0]), "Web searches · 2");
});

test("durations and phase text read short", () => {
  assert.equal(shortDuration(400), "<1s");
  assert.equal(shortDuration(4100), "4s");
  assert.equal(shortDuration(125000), "2m 05s");
  assert.equal(phaseText({ index: 0, kind: "command", label: "Commands", count: 3, ms: 4100 }), "Commands · 3 · 4s");
});

test("no activities, no phases", () => {
  assert.deepEqual(activityPhases([]), []);
});
