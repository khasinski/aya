// A CLI dialog on the screen is ended by the screen only: Claude's Notification hook reports "done" while its
// permission dialog is up. Only the agent's own question (waiting) takes over.

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPtyEvent, applyReportedStatus, isTerminalDone } from "../dist-test/pty-event-reducer.js";

const pane = (overrides = {}) => ({ id: "t1", projectSlug: "demo", presetId: "claude", name: "t1", cwd: "/tmp", status: "running", bell: false, exitCode: null, ...overrides });
const ext = (level) => ({ externalStatus: { level, text: level, updatedAt: 1 } });
const DIALOG = { status: "waiting", bell: true };

// Both ways a report reaches the renderer: the control socket (App's onControlStatus) and OSC 9001 in the output.
const TRANSPORTS = [
  ["control socket", (t, level, text) => applyReportedStatus(t, { level, text, updatedAt: 2 })],
  ["OSC 9001", (t, level, text) => applyPtyEvent({ t1: t }, { type: "osc-status", ptyId: "t1", level, text, updatedAt: 2 }).t1],
];

// [label, pane before, reported level, status after, bell after, counts as finished]
const ROWS = [
  ["a dialog on screen, the hook's Notification (done)", pane(DIALOG), "done", "waiting", true, false],
  ["a dialog on screen after a tool ran (hook), Notification (done)", pane({ ...DIALOG, ...ext("active") }), "done", "waiting", true, false],
  ["a dialog on screen, a tool reported (active)", pane(DIALOG), "active", "waiting", true, false],
  ["a dialog on screen, an error reported", pane(DIALOG), "error", "waiting", true, false],
  ["a dialog the user already looked at (bell off), done", pane({ status: "waiting", bell: false }), "done", "waiting", false, false],
  ["a dialog on screen, the agent asks the user", pane(DIALOG), "waiting", "waiting", true, false],
  ["a dialog the user already looked at (bell off), the agent asks the user: a new bell", pane({ status: "waiting", bell: false }), "waiting", "waiting", true, false],
  ["no dialog, done", pane(), "done", "idle", false, true],
  ["no dialog, active", pane({ status: "idle" }), "active", "running", false, false],
  ["the agent's own question, then done", pane({ ...DIALOG, ...ext("waiting") }), "done", "idle", false, true],
];

for (const [transport, report] of TRANSPORTS) {
  for (const [label, before, level, status, bell, finished] of ROWS) {
    test(`a dialog outlives a report | ${transport} | ${label}`, () => {
      const next = report(before, level, `said ${level}`);
      assert.equal(next.status, status);
      assert.equal(next.bell, bell);
      assert.deepEqual(next.externalStatus, { level, text: `said ${level}`, updatedAt: 2 }, "the report itself is kept");
      assert.equal(isTerminalDone(next), finished);
    });
  }
}

test("a dialog outlives a report | the screen clears after it: back to what was reported", () => {
  const reported = applyReportedStatus(pane(DIALOG), { level: "done", text: "Turn finished", updatedAt: 2 });
  const cleared = applyPtyEvent({ t1: reported }, { type: "vt-status", ptyId: "t1", waiting: false }).t1;
  assert.equal(cleared.status, "idle");
  assert.equal(cleared.bell, false);
  assert.equal(isTerminalDone(cleared), true);
});
