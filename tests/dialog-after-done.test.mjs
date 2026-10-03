// A CLI dialog proves a turn is running, so a "done" reported before it is stale (the hook has no turn-start
// event); a done reported while the dialog is up is this turn's and counts once the screen clears.

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPtyEvent, isTerminalDone } from "../dist-test/pty-event-reducer.js";

const PANE = { id: "t1", projectSlug: "demo", presetId: "claude", name: "t1", cwd: "/tmp", status: "running", bell: false, exitCode: null };
const report = (level) => ({ type: "osc-status", ptyId: "t1", level, text: `said ${level}`, updatedAt: 1 });
const OUTPUT = { type: "data", ptyId: "t1", data: "working..." };
const DIALOG = { type: "vt-status", ptyId: "t1", waiting: true };
const ANSWERED = { type: "vt-status", ptyId: "t1", waiting: false };

// [label, events, status after, finished after]
const ROWS = [
  ["the previous turn's done, output, a dialog, answered", [report("done"), OUTPUT, DIALOG, ANSWERED], "running", false],
  ["the previous turn's done, a dialog at once, answered", [report("done"), DIALOG, ANSWERED], "running", false],
  ["a tool reported (active), a dialog, answered", [report("active"), DIALOG, ANSWERED], "running", false],
  ["nothing reported, a dialog, answered", [DIALOG, ANSWERED], "running", false],
  ["a dialog, done reported while it is up, the screen clears", [DIALOG, report("done"), ANSWERED], "idle", true],
  ["the previous turn's done, a dialog, done again while it is up, the screen clears", [report("done"), DIALOG, report("done"), ANSWERED], "idle", true],
];

for (const [label, events, status, finished] of ROWS) {
  test(`a dialog after a done | ${label}`, () => {
    let state = { t1: PANE };
    const done = [];
    for (const event of events) {
      state = applyPtyEvent(state, event);
      done.push(isTerminalDone(state.t1));
    }
    assert.equal(state.t1.status, status);
    assert.equal(isTerminalDone(state.t1), finished);
    const edge = done.findIndex((d, i) => i > 0 && d && !done[i - 1] && events[i] === ANSWERED);
    assert.equal(edge === -1, !finished, `a finished edge at the answer only for a done of this turn: ${JSON.stringify(done)}`);
  });
}

test("a dialog seen again after the user silenced its bell keeps the done reported while it was up", () => {
  const up = { ...PANE, status: "waiting", bell: false, externalStatus: { level: "done", text: "said done", updatedAt: 1 } };
  const next = applyPtyEvent({ t1: up }, DIALOG).t1;
  assert.deepEqual([next.status, next.bell, next.externalStatus?.level], ["waiting", true, "done"]);
});
