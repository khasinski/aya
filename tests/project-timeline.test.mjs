import { test } from "node:test";
import assert from "node:assert/strict";
import { prependProjectEvent, projectEventForPtyEvent } from "../dist-test/project-timeline.js";

const terminal = Object.freeze({ projectSlug: "aya", id: "terminal-1", name: "Claude" });
const identity = { projectSlug: "aya", terminalId: "terminal-1" };
const ptyId = terminal.id;

function entry(id) {
  return Object.freeze({ id, projectSlug: "aya", level: "info", title: id, createdAt: 123 });
}

test("prepend keeps newest-first insertion order without mutating entries or input", () => {
  const prev = Object.freeze([entry("old-1"), entry("old-2")]);
  const next = entry("new");
  const result = prependProjectEvent(prev, next);
  assert.deepEqual(result, [next, ...prev]);
  assert.notEqual(result, prev);
  assert.equal(result[0], next);
  assert.equal(result[1], prev[0]);
  assert.deepEqual(prev.map((event) => event.id), ["old-1", "old-2"]);
});

test("prepend caps retention at 200 and drops only the tail", () => {
  const prev = Object.freeze(Array.from({ length: 200 }, (_, i) => entry(`old-${i}`)));
  const next = entry("new");
  const result = prependProjectEvent(prev, next);
  assert.equal(result.length, 200);
  assert.equal(result[0], next);
  assert.deepEqual(result.slice(1), prev.slice(0, 199));
  assert.equal(prev.length, 200);
  assert.equal(prev[199].id, "old-199");
  assert.deepEqual(prependProjectEvent([], next), [next]);
});

test("timeline ordering follows arrival even when timestamps are older", () => {
  const prev = [entry("old")];
  const next = { ...entry("late"), createdAt: 0 };
  assert.deepEqual(prependProjectEvent(prev, next), [next, ...prev]);
});

test("spawn failures preserve terminal identity and failure detail", () => {
  assert.deepEqual(projectEventForPtyEvent({ type: "spawn-failed", ptyId, reason: "missing-command", detail: "command missing" }, terminal), {
    ...identity, level: "error", title: "Claude failed to launch", detail: "command missing",
  });
});

for (const exitCode of [0, 1, -1, 137]) {
  test(`exit ${exitCode} keeps the original level, title and detail`, () => {
    assert.deepEqual(projectEventForPtyEvent({ type: "exit", ptyId, exitCode }, terminal), {
      ...identity,
      level: exitCode === 0 ? "done" : "error",
      title: exitCode === 0 ? "Claude exited" : "Claude exited with error",
      detail: `exit ${exitCode}`,
    });
  });
}

test("screen waiting preserves dialog text, including empty text, and fallback", () => {
  for (const dialog of [undefined, "Approval dialog", ""]) {
    assert.deepEqual(projectEventForPtyEvent({ type: "vt-status", ptyId, waiting: true, dialog }, terminal), {
      ...identity, level: "waiting", title: "Claude is waiting", detail: dialog ?? "Approval or input needed",
    });
  }
});

for (const [level, title] of [
  ["active", "Claude updated status"],
  ["waiting", "Claude is waiting"],
  ["done", "Claude finished"],
  ["error", "Claude reported an error"],
]) {
  test(`OSC ${level} preserves status text and the reported timestamp`, () => {
    for (const updatedAt of [0, 987654321]) {
      assert.deepEqual(projectEventForPtyEvent({ type: "osc-status", ptyId, level, text: "status detail", updatedAt }, terminal), {
        ...identity, level, title, detail: "status detail", createdAt: updatedAt,
      });
    }
  });
}

test("output, session events and cleared screen waiting do not make timeline entries", () => {
  for (const event of [
    { type: "data", ptyId, chunk: "output" },
    { type: "data", ptyId, chunk: "replayed", replay: true },
    { type: "no-session", ptyId },
    { type: "osc-session", ptyId, sessionId: "session" },
    { type: "vt-status", ptyId, waiting: false, dialog: "old dialog" },
  ]) {
    assert.equal(projectEventForPtyEvent(event, terminal), null);
  }
});
