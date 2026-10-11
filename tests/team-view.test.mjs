// The tab list's view of teams: role and unread per pane, totals per project.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as view from "../dist-test/team-view.js";
import {
  paneOptionLabel,
  pendingMoves,
  rolePanesSummary as panesNote,
  messageDeliveryText,
  paneRoles,
  startSummary as startNote,
  teamPromptKey,
  unassignedTeams,
  unreadTotal,
} from "../dist-test/team-view.js";

const startSummary = (...args) => startNote(...args)?.text ?? null;
const rolePanesSummary = (...args) => panesNote(...args).text;

const team = (name, assignments, unread, definition = {}) => ({
  name,
  definition,
  error: null,
  repoChanged: false,
  unsaved: false,
  repoDefinition: null,
  paused: false,
  running: true,
  assignments,
  unread,
  log: [],
});

test("each assigned pane gets its team, role and unread count", () => {
  const teams = [team("ux-review", { tester: "p1", implementer: "p2" }, { tester: 0, implementer: 3 })];
  assert.deepEqual(paneRoles(teams), {
    p1: { team: "ux-review", role: "tester", unread: 0 },
    p2: { team: "ux-review", role: "implementer", unread: 3 },
  });
});

test("a role with no unread entry shows zero, not undefined", () => {
  assert.deepEqual(paneRoles([team("t", { tester: "p1" }, {})]), { p1: { team: "t", role: "tester", unread: 0 } });
});

test("unread messages add up across a project's teams", () => {
  assert.equal(unreadTotal([team("a", {}, { x: 2, y: 1 }), team("b", {}, { z: 4 })]), 7);
});

test("only valid teams with no pane assigned are offered on project open", () => {
  const teams = [team("new", {}, {}), team("busy", { x: "p1" }, {}), team("broken", {}, {}, null)];
  assert.deepEqual(unassignedTeams(teams).map((t) => t.name), ["new"]);
});

test("a dismissed team prompt is keyed by project slug and team name", () => {
  assert.equal(teamPromptKey("my-app", "review"), "my-app/review");
});

test("a logged message says how far it got, in the teams window's words", () => {
  const m = (over) => ({ from: "dev", delivered: false, ...over });
  assert.equal(messageDeliveryText(m({ delivered: true })), "written");
  assert.equal(messageDeliveryText(m({ delivered: true, held: "busy" })), "written later (was held: busy)");
  assert.equal(messageDeliveryText(m({ delivered: true, typedOnly: true, held: "shows an approval prompt" })), "typed, Enter withheld: shows an approval prompt");
  assert.equal(messageDeliveryText(m({ from: "aya" })), "not typed: held");
  assert.equal(messageDeliveryText(m({ from: "aya", held: "busy" })), "not typed: busy");
  assert.equal(messageDeliveryText(m({})), "waiting in inbox: held");
  assert.equal(messageDeliveryText(m({ held: "busy" })), "waiting in inbox: busy");
});

test("Start's summary line names what the marked roles mean", () => {
  const held = [{ role: "dev", reason: "busy" }];
  assert.equal(
    startSummary({ started: false, delivered: [], held }),
    "Not started, nothing was sent: fix the roles marked below, then Start again.",
  );
  assert.equal(
    startSummary({ started: true, delivered: [], held }),
    "Started; the roles marked below did not get the delivery test.",
  );
  assert.equal(startSummary({ started: true, delivered: ["dev"], held: [], task: null }), null);
  assert.equal(startSummary({ started: true, delivered: ["dev"], held: [], task: { to: "dev", held: null } }), "Started; task sent to dev.");
  assert.equal(
    startSummary({ started: true, delivered: [], held, task: { to: "dev", held: "busy" } }),
    "Started; the roles marked below did not get the delivery test. The task for dev waits in its inbox: busy.",
  );
  assert.equal(
    startSummary({ started: true, delivered: [], held, task: { to: "dev", held: "busy", typedOnly: true } }),
    "Started; the roles marked below did not get the delivery test. The task for dev is typed in its composer, Enter withheld: busy.",
  );
  assert.equal(
    startSummary({ started: true, delivered: ["dev"], held: [], task: { to: "dev", held: "busy", typedOnly: true } }),
    "Started; task for dev is typed in its composer, Enter withheld: busy.",
  );
});

// The task line is true only while the task waits: once the log says it was written, it goes.
test("Start's task line goes once the task was written; a typed-only one stays", () => {
  const entry = (patch) => [{ id: 7, time: "", from: "user", to: "dev", commit: null, text: "t", delivered: false, held: "busy", ...patch }];
  const roleHeld = [{ role: "ops", reason: "busy" }];
  const ROLES = "the roles marked below did not get the delivery test.";
  const rows = [
    // [name, task, log, held roles, expected]
    ["waiting in the inbox: shown", { to: "dev", held: "busy", messageId: 7 }, entry({}), [], "Started; task for dev waits in its inbox: busy."],
    ["written later: gone", { to: "dev", held: "busy", messageId: 7 }, entry({ delivered: true }), [], null],
    ["typed, Enter withheld: stays", { to: "dev", held: "busy", typedOnly: true, messageId: 7 }, entry({ delivered: true, typedOnly: true }), [], "Started; task for dev is typed in its composer, Enter withheld: busy."],
    ["rolled out of the log: gone", { to: "dev", held: "busy", messageId: 7 }, [], [], null],
    ["that id is not in the log: gone", { to: "dev", held: "busy", messageId: 7 }, entry({ id: 8 }), [], null],
    ["written later, a role missed the test: only the roles", { to: "dev", held: "busy", messageId: 7 }, entry({ delivered: true }), roleHeld, `Started; ${ROLES}`],
    ["waiting, a role missed the test: both", { to: "dev", held: "busy", messageId: 7 }, entry({}), roleHeld, `Started; ${ROLES} The task for dev waits in its inbox: busy.`],
    ["sent at once: unchanged by the log", { to: "dev", held: null, messageId: 7 }, [], [], "Started; task sent to dev."],
    ["no message id (older result): shown", { to: "dev", held: "busy" }, [], [], "Started; task for dev waits in its inbox: busy."],
  ];
  for (const [name, task, log, held, expected] of rows) {
    assert.equal(startSummary({ started: true, delivered: ["dev"], held, task }, log), expected, name);
  }
});

test("a pane in a role's select names the role it plays, in this team or another", () => {
  const plays = (team, role) => ({ team, role, unread: 0 });
  assert.equal(paneOptionLabel("shell 1", undefined, "ux", "tester"), "shell 1");
  assert.equal(paneOptionLabel("shell 1", plays("ux", "tester"), "ux", "tester"), "shell 1");
  assert.equal(paneOptionLabel("shell 1", plays("ux", "fixer"), "ux", "tester"), "shell 1 (plays fixer)");
  assert.equal(paneOptionLabel("shell 1", plays("docs", "writer"), "ux", "tester"), "shell 1 (plays docs › writer)");
});

test("Apply spells out a move that leaves another role without a pane, unless that role is changed too", () => {
  const plays = { p1: { team: "ux", role: "tester", unread: 0 }, p2: { team: "docs", role: "writer", unread: 0 } };
  const name = (id) => ({ p1: "shell 1", p2: "shell 2" })[id];
  assert.deepEqual(pendingMoves("ux", { fixer: "p1" }, plays, name), ["shell 1 moves from tester to fixer; tester is left without a pane."]);
  assert.deepEqual(pendingMoves("ux", { fixer: "p1", tester: "new:claude" }, plays, name), []);
  assert.deepEqual(pendingMoves("ux", { tester: "p1" }, plays, name), []);
  assert.deepEqual(pendingMoves("ux", { fixer: "p2" }, plays, name), ["shell 2 moves from docs › writer to fixer; docs › writer is left without a pane."]);
  assert.deepEqual(pendingMoves("ux", { fixer: "new:claude", tester: "" }, plays, name), []);
});

test("after Apply: each role's pane, who lost one, and Start left to the user", () => {
  const result = {
    panes: [
      { role: "tester", paneId: "p1", name: "Codex - tester", preset: "Codex", notReached: null },
      { role: "fixer", paneId: "p2", name: "shell 2", preset: null, notReached: "runs a shell" },
    ],
    leftWithoutPane: [],
  };
  assert.equal(rolePanesSummary(result, false), "tester: new Codex pane, fixer: shell 2. Start the team when you are ready.");
  assert.equal(rolePanesSummary(result, true), "tester: new Codex pane, fixer: shell 2. The roles marked below were not told their role.");
  assert.equal(rolePanesSummary({ panes: [result.panes[0]], leftWithoutPane: ["writer"] }, true), "tester: new Codex pane. Left without a pane: writer.");
  const blocked = { role: "reviewer", paneId: "p3", name: "Codex", preset: null, notReached: null, cantReach: "can't reach Aya: Codex sandbox workspace-write blocks the socket" };
  assert.equal(
    rolePanesSummary({ panes: [result.panes[0], blocked], leftWithoutPane: [] }, false),
    "tester: new Codex pane, reviewer: Codex. Can't reach Aya: reviewer; its status below says why. Start the team when you are ready.",
  );
});

test("after Apply: a pane main marks unsure is May not reach, whatever its texts say", () => {
  // main decides it; the window reads no wording of main's texts.
  const pane = (role, cantReach, unsure) => ({ role, paneId: role, name: role, preset: null, notReached: null, cantReach, note: null, unsure });
  assert.equal(
    rolePanesSummary({ panes: [pane("tester", null, true)], leftWithoutPane: [] }, false),
    "tester: tester. May not reach Aya: tester; its status below says why. Start the team when you are ready.",
  );
  assert.equal(
    rolePanesSummary({ panes: [pane("tester", "Aya does not know yet how this pane was launched", true), pane("fixer", "can't reach Aya: read-only", false)], leftWithoutPane: [] }, false),
    "tester: tester, fixer: fixer. Can't reach Aya: fixer; its status below says why. May not reach Aya: tester; its status below says why. Start the team when you are ready.",
  );
});

test("a team an agent saved from a pane is not offered: the agent proposes its panes", () => {
  const agents = { ...team("agents", {}, {}), agentAuthored: true };
  assert.deepEqual(unassignedTeams([team("new", {}, {}), agents]).map((t) => t.name), ["new"]);
});

test("a role's status: no pane, ready, or why its pane would not take a message", async () => {
  const { roleStatus } = await import("../dist-test/team-view.js");
  const tabs = [{ id: "p1" }, { id: "p2" }, { id: "p3" }];
  const team = { assignments: { a: "p1", b: "p2", c: "p3", gone: "p9" }, paneHolds: { a: null, b: "shows an approval prompt", c: "is not running (exited, or its tab was not opened yet)" } };
  const status = (role) => roleStatus(team, role, tabs);
  assert.deepEqual(status("a"), { text: "ready", tone: "ok" });
  assert.deepEqual(status("b"), { text: "shows an approval prompt", tone: "held" });
  assert.deepEqual(status("c"), { text: "not running", tone: "held" });
  assert.deepEqual(status("gone"), { text: "no pane", tone: "none" });
  assert.deepEqual(status("none"), { text: "no pane", tone: "none" });
  assert.deepEqual(roleStatus({ assignments: { a: "p1" }, paneHolds: {} }, "a", tabs), { text: "ready", tone: "ok" });
  const why = "can't reach Aya: OpenCode's plan agent is read-only (edits denied), so the role never does its work; open a new pane for it, or restart this one with --agent build";
  assert.deepEqual(roleStatus({ assignments: { a: "p1" }, paneHolds: { a: why } }, "a", tabs), { text: why, tone: "held" });
});

test("a role's note: what Aya widened for its pane, only while it has one", async () => {
  const { roleNote } = await import("../dist-test/team-view.js");
  const tabs = [{ id: "p1" }, { id: "p2" }];
  const note = "Aya opened it with -c sandbox_workspace_write.network_access=true so it reaches Aya";
  const team = { assignments: { a: "p1", b: "p2", gone: "p9" }, paneNotes: { a: note, b: null, gone: note } };
  assert.equal(roleNote(team, "a", tabs), note);
  assert.equal(roleNote(team, "b", tabs), null);
  assert.equal(roleNote(team, "gone", tabs), null);
  assert.equal(roleNote(team, "none", tabs), null);
  assert.equal(roleNote({ assignments: { a: "p1" }, paneNotes: {} }, "a", tabs), null);
});

test("liveness lines: nothing for a team not running, a stall and a blocked role spelled out", async () => {
  const { livenessLine, roleStatus } = await import("../dist-test/team-view.js");
  const live = (status, extra = {}) => ({ status, stalledSince: null, blocked: [], ...extra });
  assert.equal(livenessLine(live("never started")), null);
  assert.equal(livenessLine(live("paused")), null);
  assert.equal(livenessLine(live("progressing")).text, "progressing");
  assert.equal(livenessLine(live("progressing", { roundsHeld: { role: "tester", rounds: 2 } })).text, "progressing - Aya rounds wait for tester to answer (2 unanswered)");
  const silence = { askAfterMin: 30, stalledAfterMin: 60 };
  assert.equal(
    livenessLine(live("progressing", { silence })).text,
    "progressing - the lead is asked for an Aya round after 30 min without a message or a change to the repo; flagged after 60 min without a change to the repo",
    "a team with no cadence says what watches it, not 'no rounds to watch'",
  );
  assert.equal(livenessLine(live("progressing", { silence: { askAfterMin: null, stalledAfterMin: 60 } })).text, "progressing - no lead to ask; flagged after 60 min without a change to the repo");
  assert.equal(livenessLine(live("progressing", { silence })).tone, "ok");
  assert.equal(livenessLine(live("progressing", { silence: { ...silence, everyMin: 3 } })).text, "progressing - the lead gets an Aya round every 3 min; flagged after 60 min without a change to the repo");
  const since = "2026-09-30T18:34:00.000Z";
  // Rounds nobody answers are no stall, so there is no "idle" or "no reply" line.
  assert.match(livenessLine(live("stalled", { stalledSince: since })).text, /^stalled: no change to the repo since \d\d:\d\d - Aya rounds are paused until the repo changes$/);
  const repo = { since, messages: 1 };
  assert.match(livenessLine(live("stalled", { stalledSince: since, repo, silence })).text, /^stalled: no change to the repo since \d\d:\d\d \(1 message\) - Aya rounds are paused until the repo changes$/);
  const clock = (iso) => new Date(iso).toTimeString().slice(0, 5);
  const earlier = "2026-09-30T15:07:00.000Z";
  assert.equal(livenessLine(live("stalled", { stalledSince: since, repo: { since: earlier, messages: 1 } })).text.split(" since ")[1].slice(0, 5), clock(earlier), "the repo's last change, not the stall's start");
  assert.match(livenessLine(live("talking", { repo: { since, messages: 4 }, silence })).text, /^talking - no change to the repo since \d\d:\d\d \(4 messages\); flagged after 60 min without one$/);
  assert.equal(livenessLine(live("talking", { repo, silence })).tone, "ok");
  const blocked = [{ role: "tester", reason: "shows an approval prompt", since }];
  assert.match(livenessLine(live("blocked", { blocked })).text, /^tester is waiting for you in its CLI$/);
  assert.match(livenessLine(live("blocked", { blocked, stalledSince: since })).text, /^stalled since \d\d:\d\d - tester is waiting for you in its CLI$/);
  const unreached = { role: "implementer", reason: "is not running (exited, or its tab was not opened yet)", since };
  const line = livenessLine(live("unreachable", { unreached }));
  assert.equal(line.tone, "held");
  assert.match(line.text, /^no Aya round typed to implementer since \d\d:\d\d: its pane is not running/);
  const team = { assignments: { tester: "p1" }, paneHolds: { tester: "shows an approval prompt" }, liveness: live("blocked", { blocked }) };
  assert.match(roleStatus(team, "tester", [{ id: "p1" }]).text, /^waiting for you since \d\d:\d\d$/);
});

// "Not reached" is the reason Apply or Start last gave; it goes when the pane stops being held.
const NR_ROWS = [
  // [label, stored reason, assigned pane in tabs, current hold, shown]
  ["held then, held now: still shown", "shows an approval prompt", true, "shows an approval prompt", "shows an approval prompt"],
  ["held then, another hold now: still shown", "shows an approval prompt", true, "runs a shell", "shows an approval prompt"],
  ["held then, answered since: gone", "shows an approval prompt", true, null, null],
  ["a replacement pane that is free: gone", "shows an approval prompt", true, null, null],
  ["no pane then and none now: shown", "no pane assigned", false, null, "no pane assigned"],
  ["nothing stored: nothing shown", undefined, true, "shows an approval prompt", null],
  ["nothing stored, no pane: nothing shown", undefined, false, null, null],
];
for (const [label, stored, hasPane, hold, shown] of NR_ROWS) {
  test(`notReachedLine | ${label}`, () => {
    const team = { assignments: hasPane ? { fixer: "p1" } : {}, paneHolds: hasPane ? { fixer: hold } : {} };
    assert.equal(view.notReachedLine(team, "fixer", [{ id: "p1" }], stored), shown);
  });
}

test("notReachedLine | a pane that left the project counts as no pane", () => {
  assert.equal(view.notReachedLine({ assignments: { fixer: "gone" }, paneHolds: {} }, "fixer", [{ id: "p1" }], "no pane assigned"), "no pane assigned");
});

test("startSummary: a team already running says nothing was sent; taskPlaceholder: no roles, no recipient", () => {
  assert.equal(startSummary({ started: false, alreadyRunning: true, delivered: [], held: [], task: null }), "Already running, nothing was sent.");
  assert.equal(view.taskPlaceholder({ roles: [], lead: null }), "Task (optional)");
});

// Before Start the card already says what rhythm Start begins, in the words the running line uses.
const CADENCE_ROWS = [
  // [label, status, silence, expected line]
  ["a cadence, not started: the rhythm, neutral", "never started", { askAfterMin: 30, everyMin: 10, stalledAfterMin: 60 }, { text: "not started - the lead gets an Aya round every 10 min", tone: "idle" }],
  ["a lead, no cadence, not started: nothing", "never started", { askAfterMin: 30, everyMin: null, stalledAfterMin: 60 }, null],
  ["no lead, no cadence, not started: nothing", "never started", { askAfterMin: null, stalledAfterMin: 60 }, null],
  ["no silence read, not started: nothing", "never started", undefined, null],
  ["a cadence, paused: the paused badge says it", "paused", { askAfterMin: 30, everyMin: 10, stalledAfterMin: 60 }, null],
];
for (const [label, status, silence, expected] of CADENCE_ROWS) {
  test(`livenessLine before Start | ${label}`, () => {
    assert.deepEqual(view.livenessLine({ status, stalledSince: null, blocked: [], unreached: null, ...(silence ? { silence } : {}) }), expected);
  });
}

test("livenessLine before Start | the rhythm reads as it does once the team runs", () => {
  const silence = { askAfterMin: 30, everyMin: 10, stalledAfterMin: 60 };
  const running = view.livenessLine({ status: "progressing", stalledSince: null, blocked: [], unreached: null, silence }).text;
  const before = view.livenessLine({ status: "never started", stalledSince: null, blocked: [], unreached: null, silence }).text;
  const rhythm = "the lead gets an Aya round every 10 min";
  assert.ok(running.includes(rhythm) && before.includes(rhythm), `${running} | ${before}`);
});

// The card styles a note by the kind main's result gives it, never by its words: info is neutral, a problem red.
const held = [{ role: "dev", reason: "busy" }];
const START_KINDS = [
  // [label, Start result, kind]
  ["already running", { started: false, alreadyRunning: true, delivered: [], held: [], task: null }, "info"],
  ["not started: roles to fix", { started: false, delivered: [], held }, "error"],
  ["started, task sent", { started: true, delivered: ["dev"], held: [], task: { to: "dev", held: null } }, "info"],
  ["started, task waits in the inbox", { started: true, delivered: ["dev"], held: [], task: { to: "dev", held: "busy" } }, "error"],
  ["started, task typed with Enter withheld", { started: true, delivered: ["dev"], held: [], task: { to: "dev", held: "busy", typedOnly: true } }, "error"],
  ["started, a role missed the delivery test", { started: true, delivered: [], held }, "error"],
  ["started, a role missed the test, task sent", { started: true, delivered: [], held, task: { to: "dev", held: null } }, "error"],
];
for (const [label, result, kind] of START_KINDS) {
  test(`startSummary kind | ${label}: ${kind}`, () => assert.equal(startNote(result).kind, kind));
}

const reached = { role: "reviewer", paneId: "p1", name: "Claude Code", preset: "Claude Code", notReached: null };
const PANES_KINDS = [
  // [label, Apply result, running, kind]
  ["new pane, team not running: Start when ready", { panes: [reached], leftWithoutPane: [] }, false, "info"],
  ["new pane, team running, told its role", { panes: [reached], leftWithoutPane: [] }, true, "info"],
  ["a role left without a pane", { panes: [reached], leftWithoutPane: ["writer"] }, false, "error"],
  ["a pane that can't reach Aya", { panes: [{ ...reached, cantReach: "can't reach Aya: read-only" }], leftWithoutPane: [] }, false, "error"],
  ["a pane that may not reach Aya", { panes: [{ ...reached, unsure: true }], leftWithoutPane: [] }, false, "error"],
  ["running, a role not told its role", { panes: [{ ...reached, notReached: "runs a shell" }], leftWithoutPane: [] }, true, "error"],
  ["not running, not reached yet: Start tells it", { panes: [{ ...reached, notReached: "runs a shell" }], leftWithoutPane: [] }, false, "info"],
];
for (const [label, result, running, kind] of PANES_KINDS) {
  test(`rolePanesSummary kind | ${label}: ${kind}`, () => assert.equal(panesNote(result, running).kind, kind));
}
