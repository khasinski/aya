import { test } from "node:test";
import assert from "node:assert/strict";
import * as view from "../dist-test/team-view.js";

const sup = await import("../dist-electron/team-supervision.js");
const { HOLD_APPROVAL } = await import("../dist-electron/pane-holds.js");

const ROLES = ["tester", "implementer"];
const clock = (iso) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const msg = (id, from, to, time = "2026-09-30T10:00:00.000Z") => ({ id, from, to, time, text: "x y", delivered: true, commit: null });
const WAIT_TABLE = [
  ["one unanswered message", [msg(1, "implementer", "tester")], [["implementer", "tester", "2026-09-30T10:00:00.000Z"]]],
  ["the reply is the last word: its sender has had no answer", [msg(1, "implementer", "tester"), msg(2, "tester", "implementer")], [["tester", "implementer", "2026-09-30T10:00:00.000Z"]]],
  ["two unanswered: since the first of them", [msg(1, "implementer", "tester", "2026-09-30T10:01:00.000Z"), msg(2, "implementer", "tester", "2026-09-30T10:03:00.000Z")], [["implementer", "tester", "2026-09-30T10:01:00.000Z"]]],
  ["both ways, the later one is open", [msg(1, "implementer", "tester"), msg(2, "tester", "implementer", "2026-09-30T10:02:00.000Z")], [["tester", "implementer", "2026-09-30T10:02:00.000Z"]]],
  ["a three-message exchange: only the last sender waits", [msg(1, "implementer", "tester"), msg(2, "tester", "implementer"), msg(3, "implementer", "tester", "2026-09-30T10:09:00.000Z")], [["implementer", "tester", "2026-09-30T10:09:00.000Z"]]],
  ["aya and the user are not roles", [msg(1, "aya", "tester"), msg(2, "user", "tester")], []],
  ["a role the team does not have is dropped", [msg(1, "qa", "tester"), msg(2, "tester", "qa")], []],
  ["empty log", [], []],
  ["the answer is held in the waiter's inbox: both still wait", [msg(1, "implementer", "tester"), { ...msg(2, "tester", "implementer"), delivered: false }], [["tester", "implementer", "2026-09-30T10:00:00.000Z"], ["implementer", "tester", "2026-09-30T10:00:00.000Z"]]],
  ["the answer sits in the composer, Enter withheld: both still wait", [msg(1, "implementer", "tester"), { ...msg(2, "tester", "implementer"), typedOnly: true, held: "shows an approval prompt" }], [["tester", "implementer", "2026-09-30T10:00:00.000Z"], ["implementer", "tester", "2026-09-30T10:00:00.000Z"]]],
  ["the held answer was typed later (delivered): answered", [msg(1, "implementer", "tester"), { ...msg(2, "tester", "implementer"), held: "shows an approval prompt" }], [["tester", "implementer", "2026-09-30T10:00:00.000Z"]]],
];
function waitsTest(title, roles, table) {
  for (const [label, log, expected] of table) {
    test(`${title} | ${label}`, () => {
      assert.deepEqual(sup.pendingWaits(log, roles).map((x) => [x.waiter, x.on, x.since]), expected);
    });
  }
}
waitsTest("pendingWaits", ROLES, WAIT_TABLE);

test("pendingWaits | an answer heard round a ring is not forgotten when a later message carries less news", () => {
  const log = [msg(1, "a", "b"), msg(2, "c", "a"), msg(3, "a", "c"), msg(4, "b", "c")];
  assert.deepEqual(sup.pendingWaits(log, ["a", "b", "c"]).filter((w) => w.waiter === "c"), []);
});

test("supervisionText | short, one line, ASCII, no em-dash, with and without waits", () => {
  const nowMs = Date.parse("2026-09-30T10:06:00.000Z");
  const waits = [{ waiter: "implementer", on: "tester", since: "2026-09-30T10:00:00.000Z" }];
  const withWaits = sup.supervisionText({ round: 4, quietSince: "2026-09-30T09:50:00.000Z", waits, nowMs });
  assert.ok(withWaits.includes(`implementer waits for tester since ${clock(waits[0].since)} (6 min)`));
  assert.ok(withWaits.includes(`since ${clock("2026-09-30T09:50:00.000Z")}`));
  const none = sup.supervisionText({ round: 4, quietSince: "2026-09-30T09:50:00.000Z", waits: [], nowMs });
  assert.match(none, /no role has an unanswered message/i);
  for (const text of [withWaits, none]) {
    assert.match(text, /^[\x20-\x7e]+$/, "printable ASCII only");
    assert.ok(text.length <= 600, `${text.length} chars`);
    assert.ok(text.includes("no progress"));
    assert.ok(text.includes("aya status waiting"));
  }
  // A clock set back (log written in the future) never prints a negative age.
  assert.match(sup.supervisionText({ round: 4, quietSince: "2026-09-30T09:50:00.000Z", waits, nowMs: nowMs - 3_600_000 }), /\(0 min\)/);
  assert.match(withWaits, /^Round 4: no progress since /, "it is a numbered round, on the shared count");
});

const def = (lead) => ({ name: "ux-review", roles: [{ id: "tester" }, { id: "implementer" }], lead, cadenceMinutes: 30 });
const SINCE = Date.parse("2026-09-30T10:07:00Z");
const LEAD_WAITING_TABLE = [
  ["lead's pane waits, team running", { definition: def("tester"), assignments: { tester: "pane-t" }, running: true, paused: false }, { "pane-t": { text: "need the staging password", since: SINCE } }, "tester is waiting for you since", "need the staging password"],
  ["another role's pane waits: not the lead's line", { definition: def("tester"), assignments: { tester: "pane-t", implementer: "pane-i" }, running: true, paused: false }, { "pane-i": { text: "x", since: SINCE } }, null],
  ["nobody waits", { definition: def("tester"), assignments: { tester: "pane-t" }, running: true, paused: false }, {}, null],
  ["no lead: nothing", { definition: def(null), assignments: { tester: "pane-t" }, running: true, paused: false }, { "pane-t": { text: "x", since: SINCE } }, null],
  ["lead has no pane: nothing", { definition: def("tester"), assignments: {}, running: true, paused: false }, { "pane-t": { text: "x", since: SINCE } }, null],
  ["team not running: nothing", { definition: def("tester"), assignments: { tester: "pane-t" }, running: false, paused: false }, { "pane-t": { text: "x", since: SINCE } }, null],
  ["status cleared after the reply: nothing", { definition: def("tester"), assignments: { tester: "pane-t" }, running: true, paused: false }, {}, null],
];
for (const [label, team, waiting, expected, text] of LEAD_WAITING_TABLE) {
  test(`leadWaitingLine | ${label}`, () => {
    const got = view.leadWaitingLine(team, waiting);
    if (expected === null) return assert.equal(got, null);
    assert.equal(got.tone, "held");
    assert.ok(got.text.includes(expected), got.text);
    assert.ok(got.text.includes(text), got.text);
    assert.match(got.text, /^[\x20-\x7e]+$/);
  });
}

test("roleStatus | a pane whose agent set `aya status waiting` reads waiting for you; a CLI block still wins", () => {
  const tabs = [{ id: "pane-t" }];
  const team = { assignments: { tester: "pane-t" }, paneHolds: { tester: null }, liveness: { blocked: [] } };
  const waiting = { "pane-t": { text: "need a decision", since: SINCE } };
  assert.match(view.roleStatus(team, "tester", tabs, waiting).text, /^waiting for you since \d\d:\d\d$/);
  assert.equal(view.roleStatus(team, "tester", tabs, waiting).tone, "held");
  assert.equal(view.roleStatus(team, "tester", tabs, {}).text, "ready");
  const blocked = { ...team, liveness: { blocked: [{ role: "tester", reason: HOLD_APPROVAL, since: "2026-09-30T08:00:00Z" }] } };
  assert.equal(view.roleStatus(blocked, "tester", tabs, waiting).text, `waiting for you since ${clock("2026-09-30T08:00:00Z")}`);
});

// A wait ends when something the other role sent after it reaches the waiter, directly or passed on.
const RING = ["lead", "implementer", "benchmarker"];
const T = (min) => `2026-09-30T10:${String(min).padStart(2, "0")}:00.000Z`;
const RING_TABLE = [
  ["lead -> implementer -> benchmarker: both hops are open, nothing came back", [msg(1, "lead", "implementer", T(1)), msg(2, "implementer", "benchmarker", T(2))], [["lead", "implementer", T(1)], ["implementer", "benchmarker", T(2)]]],
  ["the benchmarker answers the lead: the lead's wait is over, the implementer heard nothing back", [msg(1, "lead", "implementer", T(1)), msg(2, "implementer", "benchmarker", T(2)), msg(3, "benchmarker", "lead", T(3))], [["implementer", "benchmarker", T(2)], ["benchmarker", "lead", T(3)]]],
  ["a full cycle and a new lead message: the implementer has heard the ring back", [msg(1, "lead", "implementer", T(1)), msg(2, "implementer", "benchmarker", T(2)), msg(3, "benchmarker", "lead", T(3)), msg(4, "lead", "implementer", T(4))], [["benchmarker", "lead", T(3)], ["lead", "implementer", T(4)]]],
  ["three cycles: stale edges of earlier cycles are gone", [1, 5, 9].flatMap((i) => [msg(i, "lead", "implementer", T(i)), msg(i + 1, "implementer", "benchmarker", T(i + 1)), msg(i + 2, "benchmarker", "lead", T(i + 2))]), [["implementer", "benchmarker", T(10)], ["benchmarker", "lead", T(11)]]],
  ["a role that sent to nobody the waiter wrote to still owes the answer", [msg(1, "lead", "implementer", T(1)), msg(2, "benchmarker", "lead", T(2))], [["lead", "implementer", T(1)], ["benchmarker", "lead", T(2)]]],
];
waitsTest("pendingWaits ring", RING, RING_TABLE);

const CREW = ["lead", "implementer", "reviewer", "tester"];
const SIDE_TABLE = [
  ["the reviewer gives the tester other work: the implementer still waits for the reviewer", [msg(1, "implementer", "reviewer", T(0)), msg(2, "reviewer", "tester", T(5))], [["implementer", "reviewer", T(0)], ["reviewer", "tester", T(5)]]],
  ["the tester answers the reviewer: still nothing for the implementer", [msg(1, "implementer", "reviewer", T(0)), msg(2, "reviewer", "tester", T(5)), msg(3, "tester", "reviewer", T(8))], [["implementer", "reviewer", T(0)], ["tester", "reviewer", T(8)]]],
  ["the reviewer answers the implementer: its wait is over", [msg(1, "implementer", "reviewer", T(0)), msg(2, "reviewer", "tester", T(5)), msg(4, "reviewer", "implementer", T(9))], [["reviewer", "tester", T(5)], ["reviewer", "implementer", T(9)]]],
  ["the reviewer's answer comes back through the lead: its wait is over", [msg(1, "implementer", "reviewer", T(0)), msg(2, "reviewer", "lead", T(5)), msg(3, "lead", "implementer", T(7))], [["reviewer", "lead", T(5)], ["lead", "implementer", T(7)]]],
  ["the lead hears from the reviewer before the implementer asked: no answer to the implementer", [msg(1, "reviewer", "lead", T(0)), msg(2, "implementer", "reviewer", T(2)), msg(3, "lead", "implementer", T(4))], [["reviewer", "lead", T(0)], ["implementer", "reviewer", T(2)], ["lead", "implementer", T(4)]]],
];
waitsTest("pendingWaits side task", CREW, SIDE_TABLE);

test("supervisionText | B-5: the round names the implementer that still waits for the reviewer", () => {
  const log = [msg(1, "implementer", "reviewer", T(0)), msg(2, "reviewer", "tester", T(5))];
  const text = sup.supervisionText({ round: 1, quietSince: T(5), waits: sup.pendingWaits(log, CREW), nowMs: Date.parse(T(40)) });
  assert.match(text, /implementer waits for reviewer since \d\d:\d\d \(40 min\)/);
  assert.match(text, /reviewer waits for tester/);
});
