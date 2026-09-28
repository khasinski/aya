// Draft a role from its name with Aya Intelligence. The model returns fields;
// the code normalizes them, so a bad answer never reaches the team file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { draftRole, parseRoleDraft, roleDraftPrompt } from "../dist-electron/team-draft.js";

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
  assert.deepEqual(draft, { responsibilities: "Plays the build each round.", mustNot: "edit code", sendsTo: ["implementer"] });
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
  assert.deepEqual(draft.sendsTo, ["implementer"]);
});
