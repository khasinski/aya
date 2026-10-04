// A question asked before Aya was closed, whose pane now runs a session that cannot be shown to be the one that
// asked, stays unconfirmed: it holds no round, and the user's Enter or the agent's next status ends it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as view from "../dist-test/team-view.js";
import { applyReportedStatus } from "../dist-test/pty-event-reducer.js";

process.env.AYA_HOME = mkdtempSync(join(tmpdir(), "aya-restored-window-"));

const status = await import("../dist-electron/agent-status.js");
const { HOOK_VIA } = await import("../dist-electron/constants.js");

const QUESTION = "need the staging password";
const SINCE = Date.parse("2026-10-02T16:50:00Z");
const PANE = "pane-l";

/** The lead asked in session `asked`; Aya restarts (main reads the file again). Returns the window's updates. */
function restoredQuestion(asked) {
  status.__resetAgentStatusForTests();
  status.recordAgentStatus(PANE, "waiting", SINCE, QUESTION, undefined, asked);
  status.__reloadAgentStatusForTests();
  const told = [];
  status.onQuestionUnconfirmed((update) => told.push(update));
  return told;
}

test("restored, not yet checked: the window is told it was asked before the restart, and it holds the rounds", () => {
  restoredQuestion("s-1");
  assert.deepEqual(status.outstandingWaiting()[PANE], { text: QUESTION, since: SINCE, restart: "restored" });
  assert.equal(status.agentWaitingSince(PANE), SINCE);
});

test("the same session runs: still the question, the window is told nothing new", () => {
  const told = restoredQuestion("s-1");
  assert.equal(status.settleRestored(PANE, "s-1"), null);
  assert.equal(status.agentWaitingSince(PANE), SINCE);
  assert.deepEqual(told, []);
});

// [label, session when asked, session after]
const UNCONFIRMED = [
  ["another session", "s-1", "s-2"],
  ["no session known when it asked (kilo, pi, a wrapper: B-10)", undefined, "s-2"],
  ["no session known after", "s-1", undefined],
  ["no session known either time (B-10)", undefined, undefined],
];
for (const [label, asked, after] of UNCONFIRMED) {
  test(`B-6 ${label}: the question stays, unconfirmed: no round held, the window is told once`, () => {
    const told = restoredQuestion(asked);
    assert.equal(status.settleRestored(PANE, after), QUESTION, "its text goes to the team log once");
    assert.equal(status.agentWaitingSince(PANE), null, "it holds no round");
    assert.deepEqual(status.outstandingWaiting()[PANE], { text: QUESTION, since: SINCE, restart: "unconfirmed" });
    assert.deepEqual(told, [{ terminalId: PANE, level: "waiting", text: QUESTION, updatedAt: SINCE, restart: "unconfirmed" }]);
    assert.equal(status.settleRestored(PANE, after), null, "logged once");
    assert.equal(told.length, 1, "told once");
  });
}

test("B-6 unconfirmed, then the user's Enter in the pane: cleared, in the window and on disk", async () => {
  restoredQuestion("s-1");
  status.settleRestored(PANE, "s-2");
  const update = await status.noteUserAnswer(PANE, "use the test one\r", async () => null, SINCE + 60_000);
  assert.equal(update?.level, "clear");
  assert.equal(status.outstandingWaiting()[PANE], undefined);
  status.__reloadAgentStatusForTests();
  assert.equal(status.outstandingWaiting()[PANE], undefined, "the next life does not read it again");
});

test("B-6 unconfirmed, then the Enter answers a CLI dialog: the question stays", async () => {
  restoredQuestion("s-1");
  status.settleRestored(PANE, "s-2");
  assert.equal(await status.noteUserAnswer(PANE, "\r", async () => "shows an approval prompt"), null);
  assert.equal(status.outstandingWaiting()[PANE]?.restart, "unconfirmed");
});

test("B-6 unconfirmed, then the new life's hook reports a turn: the question ends, on disk too", () => {
  restoredQuestion("s-1");
  status.settleRestored(PANE, "s-2");
  assert.deepEqual(status.recordAgentStatus(PANE, "done", SINCE + 60_000, "", HOOK_VIA), { level: "done", text: "" });
  assert.equal(status.outstandingWaiting()[PANE], undefined);
  status.__reloadAgentStatusForTests();
  assert.equal(status.outstandingWaiting()[PANE], undefined);
});

test("B-6 unconfirmed, then Aya restarts again: still unconfirmed, logged no second time", () => {
  const told = restoredQuestion("s-1");
  status.settleRestored(PANE, "s-2");
  status.__reloadAgentStatusForTests();
  assert.equal(status.outstandingWaiting()[PANE]?.restart, "unconfirmed");
  assert.equal(status.agentWaitingSince(PANE), null);
  assert.equal(status.settleRestored(PANE, "s-1"), null, "not the old session's again, and not logged again");
  assert.equal(told.length, 1);
});

test("a question of this life is plain: no restart mark", () => {
  status.__resetAgentStatusForTests();
  status.recordAgentStatus(PANE, "waiting", SINCE, QUESTION, undefined, "s-1");
  assert.deepEqual(status.outstandingWaiting()[PANE], { text: QUESTION, since: SINCE });
});

const clock = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const team = { definition: { lead: "leader" }, assignments: { leader: PANE }, running: true, paneHolds: { leader: null }, liveness: { blocked: [] } };
const WINDOW = [
  ["this life", undefined, `leader is waiting for you since ${clock(SINCE)}: ${QUESTION}`, `waiting for you since ${clock(SINCE)}`],
  ["restored", "restored", `leader is waiting for you since ${clock(SINCE)} (asked before the restart): ${QUESTION}`, `waiting for you since ${clock(SINCE)}`],
  ["unconfirmed", "unconfirmed", `leader asked you before the restart (${clock(SINCE)}), not confirmed since; rounds go on: ${QUESTION}`, `asked before the restart (${clock(SINCE)}), not confirmed`],
];
for (const [label, restart, line, row] of WINDOW) {
  test(`B-6 window, a ${label} question: the lead line and the role row`, () => {
    const waiting = { [PANE]: { text: QUESTION, since: SINCE, ...(restart ? { restart } : {}) } };
    assert.equal(view.leadWaitingLine(team, waiting)?.text, line);
    assert.equal(view.roleStatus(team, "leader", [{ id: PANE }], waiting).text, row);
  });
}

test("B-6 window: a status update keeps its restart mark on the pane, a later one drops it", () => {
  const pane = { id: PANE, status: "running", bell: false };
  const unconfirmed = applyReportedStatus(pane, { level: "waiting", text: QUESTION, updatedAt: SINCE, restart: "unconfirmed" });
  assert.equal(unconfirmed.externalStatus.restart, "unconfirmed");
  const asked = applyReportedStatus(unconfirmed, { level: "waiting", text: "another question", updatedAt: SINCE + 1 });
  assert.equal(asked.externalStatus.restart, undefined);
});
