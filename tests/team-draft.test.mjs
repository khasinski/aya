// Draft a role from its name with Aya Intelligence. The model returns fields;
// the code normalizes them, so a bad answer never reaches the team file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ROLE_DRAFT_CHAT, draftRole, parseRoleDraft, roleDraftPrompt } from "../dist-electron/team-draft.js";

test("the prompt names the role, lists only the team's other roles, and asks for JSON fields", () => {
  const prompt = roleDraftPrompt("senior UX game designer", ["implementer", "tester", "senior UX game designer"]);
  assert.match(prompt, /senior UX game designer/);
  assert.match(prompt, /implementer, tester/);
  assert.doesNotMatch(prompt, /implementer, tester, senior UX/);
  for (const field of ['"responsibilities"', '"mustNot"', '"sendsTo"']) assert.ok(prompt.includes(field), field);
});

test("a good answer becomes a draft; unknown or self targets are dropped", () => {
  const draft = parseRoleDraft(
    'Sure! {"responsibilities":"  Plays the build each round.  ","mustNot":"edit code","sendsTo":["implementer","nobody","designer","implementer"]}',
    "designer",
    ["implementer", "tester", "designer"],
  );
  assert.deepEqual(draft, { responsibilities: "Plays the build each round.", mustNot: "edit code", sendsTo: [{ to: "implementer", what: "" }] });
});

test("an answer without a must-not, or not JSON, is no draft", () => {
  assert.throws(() => parseRoleDraft('{"responsibilities":"x","mustNot":"  ","sendsTo":[]}', "a", ["b"]), /no usable draft/);
  assert.throws(() => parseRoleDraft("I cannot help with that.", "a", ["b"]), /no usable draft/);
});

test("fields are capped so a rambling model cannot flood the team file", () => {
  const long = "word ".repeat(400);
  const draft = parseRoleDraft(JSON.stringify({ responsibilities: long, mustNot: long, sendsTo: [] }), "a", []);
  assert.ok(draft.responsibilities.length <= 400);
  assert.ok(draft.mustNot.length <= 120);
});

test("draftRole asks the chat once and returns the normalized draft", async () => {
  const calls = [];
  const draft = await draftRole("tester", ["implementer"], async (system, user) => {
    calls.push({ system, user });
    return '{"responsibilities":"Checks each build.","mustNot":"edit code","sendsTo":["implementer"]}';
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].system, /JSON only/);
  assert.equal(draft.mustNot, "edit code");
});

test("a spaced display name is the same role as its dashed id", () => {
  const prompt = roleDraftPrompt("ux designer", ["implementer", "ux-designer"]);
  assert.match(prompt, /other roles in the team: implementer\./);
  const draft = parseRoleDraft('{"mustNot":"x","sendsTo":["ux-designer","implementer"]}', "ux designer", ["implementer", "ux-designer"]);
  assert.deepEqual(draft.sendsTo, [{ to: "implementer", what: "" }]);
});

test("roles the user already ticked go into the prompt and win over the model's pick", async () => {
  const prompt = roleDraftPrompt("reviewer", ["implementer", "tester", "reviewer"], ["tester"]);
  assert.match(prompt, /It sends to: tester\./);
  let sent = "";
  const draft = await draftRole("reviewer", ["implementer", "tester", "reviewer"], async (_system, user) => {
    sent = user;
    return '{"responsibilities":"Reviews.","mustNot":"edit code","sendsTo":["implementer"]}';
  }, ["tester", "gone"]);
  assert.deepEqual(draft.sendsTo, [{ to: "tester", what: "" }]);
  assert.match(sent, /It sends to: tester\./);
});

test("with nothing ticked, the model's pick stands", async () => {
  assert.doesNotMatch(roleDraftPrompt("reviewer", ["implementer", "reviewer"], []), /It sends to/);
  const draft = await draftRole("reviewer", ["implementer", "reviewer"], async () =>
    '{"mustNot":"edit code","sendsTo":["implementer"]}', []);
  assert.deepEqual(draft.sendsTo, [{ to: "implementer", what: "" }]);
});

test("the draft waits long enough for Apple's on-device model (13-44 s measured)", () => {
  assert.ok(ROLE_DRAFT_CHAT.timeoutMs >= 60_000, `timeout ${ROLE_DRAFT_CHAT.timeoutMs} ms`);
});

test("the prompt gives no example must-not for the model to copy onto every role", () => {
  const prompt = roleDraftPrompt("implementer", ["reviewer", "implementer"]);
  assert.doesNotMatch(prompt, /edit code/);
  assert.match(prompt, /Never forbid the work its name says it does/);
});

test("what the other roles already do goes into the prompt, so the draft does not repeat them", async () => {
  const peers = [
    { id: "reviewer", responsibilities: "Reviews each change.", mustNot: "edit code" },
    { id: "tester", responsibilities: "", mustNot: "" },
    { id: "implementer", responsibilities: "Old text of this role.", mustNot: "x" },
  ];
  let sent = "";
  await draftRole("implementer", ["reviewer", "tester", "implementer"], async (_s, user) => {
    sent = user;
    return '{"mustNot":"merge its own change"}';
  }, [], peers);
  assert.match(sent, /reviewer: Reviews each change\. Must not: edit code\./);
  assert.doesNotMatch(sent, /tester:/);
  assert.doesNotMatch(sent, /Old text of this role/);
  assert.match(sent, /do not repeat it/);
});
