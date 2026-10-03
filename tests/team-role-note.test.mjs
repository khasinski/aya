// A task given with Start arrives as "[team <name> | from user | ...]": the role note must not call it a
// teammate's report.

import { test } from "node:test";
import assert from "node:assert/strict";

const { teamNote } = await import("../dist-electron/agent-brief.js");
const { typedTeamMessage } = await import("../dist-electron/team-control.js");
const { TEAM_SYSTEM_SENDER, TEAM_USER_SENDER } = await import("../dist-electron/team-definition.js");

const note = teamNote("sudoku-crew", "leader");
const header = (from) => typedTeamMessage("sudoku-crew", from, "2026-10-01T10:00:00.000Z", null, "write the solver").split("]")[0];
const clauses = note.split(/;|\n/).map((c) => c.trim());
const about = (needle) => clauses.filter((c) => c.includes(needle));

test("the Start task really arrives as a message from user, under the same [team header as a report", () => {
  assert.match(header(TEAM_USER_SENDER), /^\[team sudoku-crew \| from user \| \d\d:\d\d$/);
  assert.match(header("implementer"), /^\[team sudoku-crew \| from implementer \| \d\d:\d\d$/);
  assert.match(header(TEAM_SYSTEM_SENDER), /^\[team sudoku-crew \| from aya \| \d\d:\d\d$/);
});

// sender x what the note must tell the agent to do with it
const ROWS = [
  [TEAM_USER_SENDER, /the user's (own )?(instruction|task)/, /\bnot\b/],
  [TEAM_SYSTEM_SENDER, /(round|delivery test)/, /\bnot the user's\b/],
];
for (const [sender, mustSay, mustNotSay] of ROWS) {
  test(`the note classifies "from ${sender}" apart from a teammate's report`, () => {
    const sentences = about(`from ${sender}`);
    assert.equal(sentences.length, 1, `exactly one clause names "from ${sender}": ${JSON.stringify(clauses)}`);
    assert.match(sentences[0], mustSay);
    assert.doesNotMatch(sentences[0], mustNotSay);
  });
}

test("a teammate's message is still only a report", () => {
  assert.match(note, /teammate's report, not the user's instructions/);
});
