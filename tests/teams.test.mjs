// A team is defined in .aya/teams/<name>.md: plain markdown sections for
// roles, cadence and protocol, so people and agents can read and edit it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTeamFile, serializeTeam } from "../dist-electron/teams.js";

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
        sendsTo: ["implementer"],
        mustNot: "edit code",
        responsibilities:
          "Plays the build in the browser each round.\nReports findings as hypotheses with a measurement request.",
      },
      {
        id: "implementer",
        sendsTo: ["tester"],
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
