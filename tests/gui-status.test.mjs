// A Conversation GUI pane's status for the attention centre / status rail / sidebar.

import { test } from "node:test";
import assert from "node:assert/strict";
import { guiPaneStatus, sameGuiPaneStatus } from "../dist-test/gui-status.js";

const base = { agentLabel: "Codex", ready: true, busy: false, requests: [], turnOutcome: null, queueHeld: false, queued: 0 };

test("a pending approval or question wins over everything and names what is asked", () => {
  assert.deepEqual(guiPaneStatus({ ...base, busy: true, requests: [{ kind: "approval", text: "rm -rf build" }] }),
    { level: "waiting", text: "Approval needed: rm -rf build" });
  assert.deepEqual(guiPaneStatus({ ...base, requests: [{ kind: "question", text: "Which\n  database?" }] }),
    { level: "waiting", text: "Codex has a question: Which database?" });
  assert.equal(guiPaneStatus({ ...base, requests: [{ kind: "approval", text: "a" }, { kind: "approval", text: "b" }] }).text,
    "Approval needed: a (+1 more)");
});

test("a question the agent asked in a message holds the pane waiting until it is answered", () => {
  assert.deepEqual(guiPaneStatus({ ...base, unansweredQuestion: "Use Postgres?", turnOutcome: "complete" }),
    { level: "waiting", text: "Codex has a question: Use Postgres?" });
});

test("working, finished, failed and idle map to the four levels", () => {
  assert.deepEqual(guiPaneStatus({ ...base, busy: true }), { level: "active", text: "Codex is working" });
  assert.deepEqual(guiPaneStatus({ ...base, turnOutcome: "complete" }), { level: "done", text: "Turn complete" });
  assert.deepEqual(guiPaneStatus({ ...base, turnOutcome: "failed" }), { level: "error", text: "Codex's turn failed" });
  assert.equal(guiPaneStatus({ ...base, turnOutcome: "interrupted" }), "clear");
  assert.equal(guiPaneStatus(base), "clear");
});

test("a finished turn with held queued messages says so", () => {
  assert.equal(guiPaneStatus({ ...base, turnOutcome: "complete", queueHeld: true, queued: 2 }).text, "Turn complete · 2 queued messages held");
  assert.equal(guiPaneStatus({ ...base, turnOutcome: "complete", queueHeld: true, queued: 1 }).text, "Turn complete · 1 queued message held");
});

test("a disconnected pane reports nothing but an open question", () => {
  assert.equal(guiPaneStatus({ ...base, ready: false, busy: true }), "clear");
  assert.equal(guiPaneStatus({ ...base, ready: false, requests: [{ kind: "approval", text: "x" }] }).level, "waiting");
});

test("long text is cut to one line", () => {
  const status = guiPaneStatus({ ...base, requests: [{ kind: "approval", text: "x".repeat(500) }] });
  assert.ok(status.text.length < 160);
  assert.ok(status.text.includes("…"));
});

test("sameGuiPaneStatus compares level and text", () => {
  assert.ok(sameGuiPaneStatus("clear", "clear"));
  assert.ok(sameGuiPaneStatus({ level: "done", text: "a" }, { level: "done", text: "a" }));
  assert.ok(!sameGuiPaneStatus({ level: "done", text: "a" }, { level: "done", text: "b" }));
  assert.ok(!sameGuiPaneStatus("clear", { level: "done", text: "a" }));
  assert.ok(!sameGuiPaneStatus(null, "clear"));
});
