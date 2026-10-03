import { test } from "node:test";
import assert from "node:assert/strict";

const sup = await import("../dist-electron/team-supervision.js");

const ROLES = ["lead", "implementer", "tester"];
const SINCE = Date.parse("2026-10-03T10:00:00.000Z");
const NOW = Date.parse("2026-10-03T10:10:00.000Z");
const msg = (id, from, to, time = "2026-10-03T10:05:00.000Z") => ({ id, from, to, time, text: "x", delivered: true, commit: null });

const TABLE = [
  ["no talk in the window: nothing appended", [msg(1, "lead", "implementer", "2026-10-03T09:50:00.000Z")], [], (t) => assert.equal(t, "")],
  ["empty log: nothing appended", [], [], (t) => assert.equal(t, "")],
  ["counts got and sent per role, only in the window", [msg(1, "lead", "implementer", "2026-10-03T09:59:00.000Z"), msg(2, "lead", "implementer"), msg(3, "lead", "implementer"), msg(4, "implementer", "lead")], [], (t) => {
    assert.match(t, /lead got 1 sent 2/);
    assert.match(t, /implementer got 2 sent 1/);
    assert.doesNotMatch(t, /tester/);
  }],
  ["names the role most messages went to", [msg(1, "lead", "implementer"), msg(2, "tester", "implementer"), msg(3, "implementer", "lead")], [], (t) => assert.match(t, /Most messages went to implementer \(2\)/)],
  ["aya, the user and roles the team does not have are not counted", [msg(1, "aya", "lead"), msg(2, "user", "lead"), msg(3, "qa", "lead"), msg(4, "lead", "tester")], [], (t) => {
    assert.match(t, /lead got 0 sent 1/);
    assert.match(t, /tester got 1 sent 0/);
  }],
  ["lists who waits on whom, in minutes", [msg(1, "tester", "implementer")], [{ waiter: "tester", on: "implementer", since: "2026-10-03T10:02:00.000Z" }], (t) => assert.match(t, /Waiting: tester on implementer 8 min\./)],
  ["plain ASCII, one line", [msg(1, "lead", "tester")], [], (t) => assert.match(t, /^[\x20-\x7e]*$/)],
];

for (const [label, log, waits, check] of TABLE) {
  test(`loadText | ${label}`, () => check(sup.loadText({ log, roles: ROLES, sinceMs: SINCE, waits, nowMs: NOW })));
}
