// The Teams window's chat: the team log in order, delivery-test exchanges
// collapsed to one line, Aya's and the user's messages as system lines, and
// only abnormal delivery shown loudly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { teamChat, abnormal } from "../dist-test/team-chat.js";

let next = 0;
const m = (from, to, text, extra = {}) => ({
  id: ++next,
  time: `2026-09-29T10:${String(next).padStart(2, "0")}:00.000Z`,
  from,
  to,
  commit: "d95af8a",
  text,
  delivered: true,
  ...extra,
});
const test3 = () => [m("aya", "dev", "Delivery test: run aya team whoami."), m("aya", "ux", "Delivery test: run aya team whoami."), m("aya", "qa", "Delivery test: run aya team whoami.")];
const kinds = (chat) => chat.map((e) => (e.kind === "delivery-test" ? `tests ${e.answered.length}/${e.tested.length}` : `${e.kind} ${e.message.text}`));

test("oldest first, whatever order the log comes in", () => {
  const log = [m("dev", "ux", "one"), m("ux", "dev", "two"), m("dev", "ux", "three")];
  assert.deepEqual(kinds(teamChat([log[2], log[0], log[1]])), ["peer one", "peer two", "peer three"]);
});

test("a delivery-test exchange collapses to one line with who answered", () => {
  const cases = [
    ["every role answered", [...test3(), m("dev", "ux", "ok"), m("ux", "dev", "ok"), m("qa", "dev", "ok")], ["tests 3/3"]],
    ["one did not", [...test3(), m("dev", "ux", "ok"), m("qa", "dev", "ok")], ["tests 2/3"]],
    ["a real message ends the exchange", [...test3(), m("dev", "ux", "ok"), m("ux", "dev", "the timer is broken"), m("qa", "dev", "ok")], ["tests 1/3", "peer the timer is broken", "peer ok"]],
    ["a longer reply is a real message", [...test3(), m("dev", "ux", "ok, starting on it")], ["tests 0/3", "peer ok, starting on it"]],
    ["a role answers once", [...test3(), m("dev", "ux", "ok"), m("dev", "ux", "ok")], ["tests 1/3", "peer ok"]],
    ["a role not tested is not an answer", [m("aya", "dev", "Delivery test: x"), m("ux", "dev", "ok")], ["tests 0/1", "peer ok"]],
    ["two Starts are two lines", [...test3(), m("dev", "ux", "ok"), m("dev", "ux", "fixed"), ...test3()], ["tests 1/3", "peer fixed", "tests 0/3"]],
  ];
  for (const [name, log, expected] of cases) assert.deepEqual(kinds(teamChat(log)), expected, name);
  const [group] = teamChat([...test3(), m("dev", "ux", "ok")]);
  assert.equal(group.messages.length, 4, "the group keeps its messages, to expand");
  assert.deepEqual(group.tested, ["dev", "ux", "qa"]);
  assert.deepEqual(group.answered, ["dev"]);
});

test("Aya's rounds and the user's task are system lines; peers are messages", () => {
  const log = [m("aya", "dev", "Round 3: run your round."), m("user", "dev", "Make the timer pausable"), m("dev", "ux", "done")];
  assert.deepEqual(kinds(teamChat(log)), ["system Round 3: run your round.", "system Make the timer pausable", "peer done"]);
});

test("only what went wrong is loud: held, or typed after a hold", () => {
  assert.equal(abnormal(m("dev", "ux", "x")), false);
  assert.equal(abnormal(m("dev", "ux", "x", { held: "busy" })), true);
  assert.equal(abnormal(m("dev", "ux", "x", { delivered: false })), true);
  assert.equal(abnormal(m("aya", "dev", "Round 1", { delivered: false, held: "runs a shell" })), true);
  assert.deepEqual(
    teamChat([m("dev", "ux", "fine"), m("ux", "dev", "stuck", { delivered: false, held: "busy" })]).map((e) => e.abnormal),
    [false, true],
  );
});
