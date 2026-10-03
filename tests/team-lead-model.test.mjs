// A team has a lead and, optionally, rounds every `cadenceMinutes` minutes, which always go to the lead.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { teamProject } from "./helpers/team.mjs";
import * as edit from "../dist-test/team-edit.js";
import * as view from "../dist-test/team-view.js";

const { parseTeamFile, serializeTeam } = await import("../dist-electron/team-definition.js");
const { saveTeam } = await import("../dist-electron/team-admin.js");
const { validateTeamDefinition } = await import("../dist-electron/validation.js");
const { taskRecipient } = await import("../dist-electron/team-runner.js");

const BODY = `# duo

## Role: reviewer
Sends to: fixer (findings)
Must not: edit code

## Role: fixer
Sends to: reviewer (the commit)
Must not: skip a finding
`;
const file = (...sections) => `${BODY}${sections.map((s) => `\n${s}\n`).join("")}`;

// [file, lead, cadenceMinutes, leadConflict]
const FILES = [
  ["only Cadence", file("## Cadence\nreviewer every 30 min"), "reviewer", 30, null],
  ["only Lead", file("## Lead\nfixer"), "fixer", null, null],
  ["both on one role", file("## Lead\nfixer", "## Cadence\nfixer every 5 min"), "fixer", 5, null],
  ["both on different roles (old file)", file("## Lead\nfixer", "## Cadence\nreviewer every 30 min"), "reviewer", 30, "fixer"],
  ["neither", file(), null, null, null],
];

test("a team is a lead and, optionally, its rounds' minutes: no second role for the rhythm", async (s) => {
  for (const [name, text, lead, minutes, conflict] of FILES) {
    await s.test(name, () => {
      const team = parseTeamFile("duo", text);
      assert.equal(team.lead, lead);
      assert.equal(team.cadenceMinutes, minutes);
      assert.equal(team.leadConflict ?? null, conflict);
      assert.equal("cadence" in team, false, "no cadence object with a role of its own");
    });
  }
});

test("written back, the rhythm is the lead's, and it reads back the same", () => {
  const team = parseTeamFile("duo", file("## Cadence\nreviewer every 30 min"));
  const text = serializeTeam(team);
  assert.match(text, /## Lead\nreviewer\n\n## Cadence\nreviewer every 30 min/);
  assert.deepEqual(parseTeamFile("duo", text), team);
});

function setup() {
  const t = teamProject("aya-lead-model-", { tabs: [{ id: "pane-1" }] });
  return { ...t, file: join(t.directory, ".aya", "teams", "duo.md") };
}

const MODELS = [
  ["a lead and its rounds", { lead: "fixer", cadenceMinutes: 30 }, null],
  ["a lead, no rounds", { lead: "fixer", cadenceMinutes: null }, null],
  ["rounds and no lead", { lead: null, cadenceMinutes: 30 }, /no role leads it/],
  ["no lead, no rounds", { lead: null, cadenceMinutes: null }, /no role leads it/],
  ["a lead the team does not have", { lead: "ghost", cadenceMinutes: null }, /lead names unknown role "ghost"/],
  ["rounds every 0 min", { lead: "fixer", cadenceMinutes: 0 }, /every <1-1440> min/],
  ["rounds every 1441 min", { lead: "fixer", cadenceMinutes: 1441 }, /every <1-1440> min/],
];
for (const [name, model, refused] of MODELS) {
  test(`saving from the window | ${name}`, async () => {
    const t = setup();
    try {
      const base = parseTeamFile("duo", file("## Lead\nreviewer"));
      const sent = validateTeamDefinition(JSON.parse(JSON.stringify({ ...base, ...model })));
      const save = () => saveTeam(t.teamHome, t.project, sent, { create: true });
      if (refused) {
        await assert.rejects(save, { message: refused });
        assert.equal(existsSync(t.file), false);
        return;
      }
      await save();
      const back = parseTeamFile("duo", readFileSync(t.file, "utf8"));
      assert.deepEqual([back.lead, back.cadenceMinutes], [model.lead, model.cadenceMinutes]);
    } finally {
      t.cleanup();
    }
  });
}

test("the IPC payload carries cadenceMinutes, a number or null, and nothing else for the rhythm", () => {
  const team = parseTeamFile("duo", file("## Lead\nfixer", "## Cadence\nfixer every 5 min"));
  assert.equal(validateTeamDefinition(JSON.parse(JSON.stringify(team))).cadenceMinutes, 5);
  assert.equal(validateTeamDefinition({ ...team, cadenceMinutes: undefined }).cadenceMinutes, null);
  assert.throws(() => validateTeamDefinition({ ...team, cadenceMinutes: "5" }), /cadenceMinutes: expected number/);
});

test("the editor: rounds go to the lead; there is no role to pick for them, and only a missing lead is a problem", () => {
  const team = edit.toEditor(parseTeamFile("duo", file("## Lead\nreviewer")));
  const key = (id) => team.roles.find((r) => r.id === id).key;
  const rounds = edit.setCadence(team, 10);
  assert.deepEqual([edit.fromEditor(rounds).lead, edit.fromEditor(rounds).cadenceMinutes], ["reviewer", 10]);
  const moved = edit.setLead(rounds, key("fixer"));
  assert.deepEqual([edit.fromEditor(moved).lead, edit.fromEditor(moved).cadenceMinutes], ["fixer", 10], "the rounds go with the lead");
  assert.equal(edit.fromEditor(edit.setCadence(moved, null)).cadenceMinutes, null);
  assert.equal(edit.leadProblem(moved), null);
  assert.match(edit.leadProblem(edit.removeRole(moved, key("fixer"))), /Pick the role that leads/);
  assert.equal("setCadenceRole" in edit, false);
  const apart = parseTeamFile("duo", file("## Lead\nfixer", "## Cadence\nreviewer every 30 min"));
  assert.equal(edit.leadProblem(edit.toEditor(apart)), null);
  assert.match(view.leadWarning(apart), /different roles: rounds go to reviewer/);
});

// The rhythm's role is the lead, so Start's task goes to it; the window says so before Start.
test("10b: a file with only a Cadence on the reviewer: the reviewer leads and gets the task, and the window says so first", () => {
  const team = parseTeamFile("duo", file("## Cadence\nreviewer every 3 min"));
  assert.equal(team.lead, "reviewer");
  assert.equal(taskRecipient(team), "reviewer");
  assert.equal(view.taskPlaceholder(team), "Task for reviewer (the lead)");
  assert.equal(taskRecipient(team, "fixer"), "fixer", "the window's role select still sends it elsewhere");
});
