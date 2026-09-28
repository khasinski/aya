// Flow preview: the routes come from the Sends to checkboxes (code); the model
// only says what the text sends along each, and which routes the text implies.

import { test } from "node:test";
import assert from "node:assert/strict";
import { flowPreviewPrompt, parseFlowPreview, previewFlow, allowedRoutes } from "../dist-electron/team-flow.js";

const role = (id, sendsTo, responsibilities = "", mustNot = "x") => ({ id, sendsTo, responsibilities, mustNot });
const TEAM = {
  name: "trio",
  roles: [
    role("reviewer", ["implementer", "tester"], "Sends findings to the implementer."),
    role("implementer", ["reviewer", "tester"], "Fixes findings and asks the tester to check the commit.", "merge unreviewed"),
    role("tester", ["reviewer"], "Reports each bug to the implementer with steps."),
  ],
  cadence: { role: "reviewer", minutes: 30 },
  protocol: "The reviewer keeps the list.",
};

test("routes are the ticked Sends to between named roles, once each, never to itself", () => {
  const team = { ...TEAM, roles: [role("a", ["b", "a", "b", "ghost", ""]), role("b", ["a"]), role("", ["a"])] };
  assert.deepEqual(allowedRoutes(team), [{ from: "a", to: "b" }, { from: "b", to: "a" }]);
});

test("the prompt holds only the whitelisted text and lists every route", () => {
  const prompt = flowPreviewPrompt({
    ...TEAM,
    name: "SECRET-NAME",
    cadence: { role: "reviewer", minutes: 987 },
    roles: [...TEAM.roles, role("", [], "UNNAMED ROLE TEXT")],
  });
  for (const text of ["Sends findings to the implementer.", "merge unreviewed", "The reviewer keeps the list.", "reviewer -> implementer", "tester -> reviewer"]) {
    assert.ok(prompt.includes(text), text);
  }
  assert.doesNotMatch(prompt, /SECRET-NAME|987|UNNAMED ROLE TEXT/);
  assert.doesNotMatch(prompt, /tester -> implementer/);
  assert.match(prompt, /"unclear"/);
  assert.match(prompt, /seems likely/);
});

test("one entry per route: missing or unclear is null, duplicates and unknown routes are dropped", () => {
  const reply = `Here: {"routes":[
    {"from":"reviewer","to":"implementer","carries":"  findings to fix  "},
    {"from":"reviewer","to":"implementer","carries":"second answer"},
    {"from":"implementer","to":"tester","carries":"UNCLEAR"},
    {"from":"tester","to":"ghost","carries":"x"},
    {"from":"tester","to":"implementer","carries":"not a ticked route"}
  ],"unlisted":[]}`;
  const preview = parseFlowPreview(reply, TEAM);
  assert.deepEqual(preview.routes, [
    { from: "reviewer", to: "implementer", carries: "findings to fix" },
    { from: "reviewer", to: "tester", carries: null },
    { from: "implementer", to: "reviewer", carries: null },
    { from: "implementer", to: "tester", carries: null },
    { from: "tester", to: "reviewer", carries: null },
  ]);
});

test("unlisted keeps only routes between real roles that are not ticked, once each", () => {
  const reply = JSON.stringify({
    routes: [],
    unlisted: [
      { from: "tester", to: "implementer", carries: "  " },
      { from: "tester", to: "implementer", carries: "bug steps" },
      { from: "tester", to: "implementer", carries: "again" },
      { from: "boss", to: "tester", carries: "unknown sender" },
      { from: "reviewer", to: "implementer", carries: "already ticked" },
      { from: "tester", to: "tester", carries: "self" },
      { from: "tester", to: "boss", carries: "unknown role" },
      { from: "reviewer", to: "tester", carries: "" },
    ],
  });
  assert.deepEqual(parseFlowPreview(reply, TEAM).unlisted, [{ from: "tester", to: "implementer", carries: "bug steps" }]);
});

test("a reply that is not JSON is an error, and phrases are capped", async () => {
  assert.throws(() => parseFlowPreview("I cannot.", TEAM), /no usable/);
  const long = "word ".repeat(100);
  const preview = parseFlowPreview(JSON.stringify({ routes: [{ from: "reviewer", to: "implementer", carries: long }], unlisted: [] }), TEAM);
  assert.ok(preview.routes[0].carries.length <= 80);
  let calls = 0;
  await previewFlow(TEAM, async (system) => {
    calls++;
    assert.match(system, /JSON only/);
    return '{"routes":[],"unlisted":[]}';
  });
  assert.equal(calls, 1);
});
