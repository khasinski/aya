import test from "node:test";
import assert from "node:assert/strict";
import { applyPtyEvent, isTerminalWorking } from "../dist-test/pty-event-reducer.js";
import { projectBadgeLevel } from "../dist-test/attention.js";
import { terminalStatusDotText } from "../dist-test/components/TerminalStatusDot.js";
import { doneToAcknowledge } from "../dist-test/terminal-seen.js";

const base = { name: "agent", status: "idle", exitCode: null, presetId: "claude", bell: false };

test("vt-activity sets and clears working, and repeats change nothing", () => {
  const prev = { t: { ...base, id: "t" } };
  const on = applyPtyEvent(prev, { type: "vt-activity", ptyId: "t", busy: true });
  assert.equal(on.t.working, true);
  assert.equal(applyPtyEvent(on, { type: "vt-activity", ptyId: "t", busy: true }), on);
  assert.equal(applyPtyEvent(on, { type: "vt-activity", ptyId: "t", busy: false }).t.working, false);
  assert.equal(applyPtyEvent(prev, { type: "vt-activity", ptyId: "gone", busy: true }), prev);
});

test("working yields to a dialog, an error, an exit and a stopped pane", () => {
  const working = { ...base, working: true };
  assert.equal(isTerminalWorking(working), true);
  assert.equal(isTerminalWorking({ ...working, status: "waiting" }), false);
  assert.equal(isTerminalWorking({ ...working, status: "error" }), false);
  assert.equal(isTerminalWorking({ ...working, exitCode: 0 }), false);
  assert.equal(isTerminalWorking({ ...working, stopped: true }), false);
  assert.equal(isTerminalWorking({ ...base, externalStatus: { level: "active", text: "x", updatedAt: 1 } }), true);
});

test("project badge: working counts as active, below done, waiting and error", () => {
  assert.equal(projectBadgeLevel({ ...base, working: true }), "active");
  assert.equal(projectBadgeLevel({ ...base, working: true, externalStatus: { level: "done", text: "x", updatedAt: 1 } }), "done");
  assert.equal(projectBadgeLevel({ ...base, working: true, status: "waiting" }), "waiting");
  assert.equal(projectBadgeLevel({ ...base }), null);
});

test("the dot says the agent works", () => {
  assert.equal(terminalStatusDotText({ ...base, status: "running", working: true }), "Agent is working.");
  assert.equal(terminalStatusDotText({ ...base, externalStatus: { level: "done", text: "x", updatedAt: 1 } }), "Agent finished. Select it to dismiss.");
});

test("done is born seen only on the watched terminal of a focused window", () => {
  const done = { externalStatus: { level: "done" }, status: "idle" };
  const terminals = { a: done, b: done, c: { status: "idle" }, d: { externalStatus: { level: "done" }, status: "waiting" } };
  assert.equal(doneToAcknowledge(terminals, "a", true), "a");
  assert.equal(doneToAcknowledge(terminals, "a", false), null);
  assert.equal(doneToAcknowledge(terminals, "c", true), null);
  assert.equal(doneToAcknowledge(terminals, "d", true), null);
  assert.equal(doneToAcknowledge(terminals, null, true), null);
});
