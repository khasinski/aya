// Draft a role with Aya Intelligence. The model returns fields; the code
// normalizes them, so a bad answer never reaches the team file.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MUST_NOT_MAX,
  RESPONSIBILITIES_MAX,
  ROLE_DRAFT_CHAT,
  WHAT_MAX,
  draftRole,
  parseRoleDraft,
  roleDraftPrompt,
} from "../dist-electron/team-draft.js";

const role = (id, sends = [], responsibilities = "", mustNot = "") => ({
  id,
  sendsTo: sends.map(([to, what = ""]) => ({ to, what })),
  responsibilities,
  mustNot,
});
const team = (roles, protocol = "") => ({ name: "t", roles, cadence: null, protocol });

const TRIO = team(
  [
    role("reviewer", [["implementer", "findings to fix"], ["tester", "measurement requests"]], "Reviews each change.", "edit code"),
    role("senior-ux-designer", [["tester"]]),
    role("tester", [["reviewer", "measured results"]], "", ""),
  ],
  "The reviewer keeps the list.",
);

test("the prompt names the role by its words, lists the others, and asks for JSON fields", () => {
  const prompt = roleDraftPrompt(TRIO, "senior-ux-designer");
  assert.match(prompt, /"senior ux designer"/);
  assert.match(prompt, /other roles in the team: reviewer, tester\./);
  for (const field of ['"responsibilities"', '"mustNot"', '"sendsTo"']) assert.ok(prompt.includes(field), field);
  assert.doesNotMatch(prompt, /edit code"|e\.g\./);
  assert.match(prompt, /Never forbid the work its name says it does/);
});

test("what the others do and send to this role goes into the prompt; empty roles and itself do not", () => {
  const prompt = roleDraftPrompt(TRIO, "senior-ux-designer");
  assert.match(prompt, /- reviewer: Reviews each change\. Must not: edit code\./);
  assert.doesNotMatch(prompt, /- tester:/);
  const tester = roleDraftPrompt(TRIO, "tester");
  assert.match(tester, /It receives: measurement requests from reviewer\./);
  assert.doesNotMatch(tester, /- tester:/);
});

test("ticked routes go into the prompt and win; a typed what stays, the model fills the empty ones", () => {
  const t = team([role("a", [["b", "typed by hand"], ["c"]]), role("b"), role("c"), role("d")]);
  assert.match(roleDraftPrompt(t, "a"), /It sends to: b, c\. For each, say what it sends\./);
  const draft = parseRoleDraft(
    JSON.stringify({ mustNot: "x", sendsTo: { b: "model's b", c: "  the build  (to test)", d: "not ticked" } }),
    t,
    "a",
  );
  assert.deepEqual(draft.sendsTo, [
    { to: "b", what: "typed by hand" },
    { to: "c", what: "the build to test" },
  ]);
});

test("with nothing ticked the model picks routes, only among the other named roles, once each", () => {
  const t = team([role("a"), role("b"), role("c")]);
  assert.match(roleDraftPrompt(t, "a"), /choose only from the other roles/);
  const asObject = parseRoleDraft('{"mustNot":"x","sendsTo":{"b":"notes","a":"self","ghost":"y"}}', t, "a");
  assert.deepEqual(asObject.sendsTo, [{ to: "b", what: "notes" }]);
  const asList = parseRoleDraft('{"mustNot":"x","sendsTo":["c","c","b"]}', t, "a");
  assert.deepEqual(asList.sendsTo, [{ to: "c", what: "" }, { to: "b", what: "" }]);
  const asPairs = parseRoleDraft('{"mustNot":"x","sendsTo":[{"to":"b","what":"plans"},{"role":"c","what":"tasks"},{"to":"b","what":"again"}]}', t, "a");
  assert.deepEqual(asPairs.sendsTo, [{ to: "b", what: "plans" }, { to: "c", what: "tasks" }]);
});

test("an answer without a must-not, or not JSON, is no draft", () => {
  const t = team([role("a"), role("b")]);
  assert.throws(() => parseRoleDraft('{"responsibilities":"x","mustNot":"  "}', t, "a"), /no usable draft/);
  assert.throws(() => parseRoleDraft("I cannot help with that.", t, "a"), /no usable draft/);
});

test("fields are capped so a rambling model cannot flood the team file", () => {
  const long = "word ".repeat(400);
  const t = team([role("a", [["b"]]), role("b")]);
  const draft = parseRoleDraft(JSON.stringify({ responsibilities: long, mustNot: long, sendsTo: { b: long } }), t, "a");
  assert.deepEqual([RESPONSIBILITIES_MAX, MUST_NOT_MAX, WHAT_MAX], [400, 120, 60]);
  assert.ok(draft.responsibilities.length <= RESPONSIBILITIES_MAX);
  assert.ok(draft.mustNot.length <= MUST_NOT_MAX);
  assert.ok(draft.sendsTo[0].what.length <= WHAT_MAX);
});

test("draftRole asks the chat once and returns the normalized draft", async () => {
  const calls = [];
  const draft = await draftRole(TRIO, "tester", async (system, user) => {
    calls.push({ system, user });
    return '```json\n{"responsibilities":"Checks each build.","mustNot":"fix bugs itself","sendsTo":{"reviewer":"pass or fail"}}\n```';
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].system, /JSON only/);
  assert.match(calls[0].user, /"tester"/);
  assert.deepEqual(draft, { responsibilities: "Checks each build.", mustNot: "fix bugs itself", sendsTo: [{ to: "reviewer", what: "measured results" }] });
});

test("an unknown role id is refused", () => {
  assert.throws(() => roleDraftPrompt(TRIO, "ghost"), /no role "ghost"/);
});

test("the draft waits long enough for Apple's on-device model (13-44 s measured)", () => {
  assert.ok(ROLE_DRAFT_CHAT.timeoutMs >= 60_000, `timeout ${ROLE_DRAFT_CHAT.timeoutMs} ms`);
});

test("a role draft asks for a short, low-temperature answer", () => {
  assert.deepEqual(ROLE_DRAFT_CHAT, { temperature: 0.2, maxTokens: 400, timeoutMs: 90_000 });
});
