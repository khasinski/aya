// A team is defined in .aya/teams/<name>.md: plain markdown sections for
// roles, cadence and protocol, so people and agents can read and edit it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MUST_NOT_FIELD, SECTION_MARKER, SENDS_TO_FIELD, TEAM_SYSTEM_SENDER, parseTeamFile, serializeTeam } from "../dist-electron/teams.js";

const UX_REVIEW = `# ux-review

## Role: tester
Sends to: implementer
Must not: edit code
Plays the build in the browser each round.
Reports findings as hypotheses with a measurement request.

## Role: implementer
Sends to: tester
Must not: skip a report
Fixes findings and names the commit to test.

## Cadence
tester every 30 min

## Protocol
One round every 30 minutes. Reports are one-way.
`;

test("parses roles, send-to, must-not, cadence and protocol", () => {
  const team = parseTeamFile("ux-review", UX_REVIEW);
  assert.deepEqual(team, {
    name: "ux-review",
    roles: [
      {
        id: "tester",
        sendsTo: [{ to: "implementer", what: "" }],
        mustNot: "edit code",
        responsibilities:
          "Plays the build in the browser each round.\nReports findings as hypotheses with a measurement request.",
      },
      {
        id: "implementer",
        sendsTo: [{ to: "tester", what: "" }],
        mustNot: "skip a report",
        responsibilities: "Fixes findings and names the commit to test.",
      },
    ],
    cadence: { role: "tester", minutes: 30 },
    protocol: "One round every 30 minutes. Reports are one-way.",
  });
});

test("serialize then parse gives the same team", () => {
  const team = parseTeamFile("ux-review", UX_REVIEW);
  assert.deepEqual(parseTeamFile("ux-review", serializeTeam(team)), team);
});

test("cadence and protocol are optional", () => {
  const text = UX_REVIEW.replace(/## Cadence[\s\S]*$/, "");
  const team = parseTeamFile("ux-review", text);
  assert.equal(team.cadence, null);
  assert.equal(team.protocol, "");
});

const bad = (why, text, name = "ux-review") =>
  test(`rejects: ${why}`, () => assert.throws(() => parseTeamFile(name, text), /team/i));

bad("a role without must-not", UX_REVIEW.replace("Must not: edit code\n", ""));
bad("send-to naming an unknown role", UX_REVIEW.replace("Sends to: implementer", "Sends to: designer"));
bad("a role sending to itself", UX_REVIEW.replace("Sends to: implementer", "Sends to: tester"));
bad("two roles with one id", UX_REVIEW.replace("## Cadence", "## Role: tester\nSends to: implementer\nMust not: edit code\n\n## Cadence"));
bad("a single role", UX_REVIEW.replace(/## Role: implementer[\s\S]*?(?=## Cadence)/, "").replace("Sends to: implementer\n", ""));
bad("a role id with spaces", UX_REVIEW.replaceAll("implementer", "the implementer"));
bad("cadence for an unknown role", UX_REVIEW.replace("tester every 30 min", "designer every 30 min"));
bad("cadence that is not N min", UX_REVIEW.replace("tester every 30 min", "tester sometimes"));
bad("cadence of zero", UX_REVIEW.replace("every 30 min", "every 0 min"));
bad("a file name that is not a slug", UX_REVIEW, "UX Review!");
bad("an unknown section", `${UX_REVIEW}\n## Budget\n10 dollars\n`);

test("a route carries what is sent in parentheses; the old bare form still parses", () => {
  const text = `# trio

## Role: reviewer
Sends to: implementer (findings to fix, with proof), tester
Must not: edit code

## Role: implementer
Sends to: reviewer (the commit to check)
Must not: merge unreviewed

## Role: tester
Must not: fix bugs itself
`;
  const team = parseTeamFile("trio", text);
  assert.deepEqual(team.roles[0].sendsTo, [
    { to: "implementer", what: "findings to fix, with proof" },
    { to: "tester", what: "" },
  ]);
  assert.deepEqual(team.roles[1].sendsTo, [{ to: "reviewer", what: "the commit to check" }]);
  assert.match(serializeTeam(team), /Sends to: implementer \(findings to fix, with proof\), tester\n/);
  assert.deepEqual(parseTeamFile("trio", serializeTeam(team)), team);
});

test("a what with parentheses, or a route listed twice, is refused", () => {
  const base = (sends) => `# t\n\n## Role: a\nSends to: ${sends}\nMust not: x\n\n## Role: b\nMust not: y\n`;
  assert.throws(() => parseTeamFile("t", base("b (notes (draft))")), /parenthes/);
  assert.throws(() => parseTeamFile("t", base("b (x")), /parenthes/);
  assert.throws(() => parseTeamFile("t", base("b (x), b (y)")), /twice/);
  assert.deepEqual(parseTeamFile("t", base("b (x), ")).roles[0].sendsTo, [{ to: "b", what: "x" }]);
});

test("the file's field names and section marker are the ones the format reads", () => {
  assert.equal(SENDS_TO_FIELD, "Sends to");
  assert.equal(MUST_NOT_FIELD, "Must not");
  assert.equal(SECTION_MARKER, "## ");
});

test("Aya's own messages are sent as aya", () => {
  assert.equal(TEAM_SYSTEM_SENDER, "aya");
});
