// A team has a lead in "## Lead": a new team without one is refused, a saved one without one still loads.

import { test } from "node:test";
import assert from "node:assert/strict";
import { teamProject } from "./helpers/team.mjs";
import * as edit from "../dist-test/team-edit.js";
import * as view from "../dist-test/team-view.js";

const { addRole, fromEditor, removeRole, toEditor, updateRole } = edit;
const { parseTeamFile, serializeTeam } = await import("../dist-electron/team-definition.js");
const { teamGuide } = await import("../dist-electron/team-author.js");
const { listTeams } = await import("../dist-electron/team-admin.js");
const { validateTeamDefinition } = await import("../dist-electron/validation.js");
const { taskRecipient } = await import("../dist-electron/team-runner.js");

const BODY = `# duo

## Role: reviewer
Sends to: fixer (findings)
Must not: edit code
Reviews.

## Role: fixer
Sends to: reviewer (the commit)
Must not: skip a finding
Fixes.
`;
const withSections = (...sections) => `${BODY}${sections.map((s) => `\n${s}\n`).join("")}`;
const LEAD_FIXER = "## Lead\nfixer";
const CADENCE_REVIEWER = "## Cadence\nreviewer every 30 min";

test("the file: a Lead names a role of the file, and is written back", () => {
  const rows = [
    ["no Lead", BODY, null, undefined],
    ["Lead on a role", withSections(LEAD_FIXER), "fixer", undefined],
    ["Cadence only: its role leads", withSections(CADENCE_REVIEWER), "reviewer", undefined],
    ["Lead on an unknown role", withSections("## Lead\nghost"), null, /^team "duo": lead names unknown role "ghost"$/],
    ["Lead that is not a role id", withSections("## Lead\nthe fixer please"), null, /^team "duo": lead must read "<role>"/],
    ["an empty Lead", withSections("## Lead\n"), null, /^team "duo": lead must read "<role>"/],
  ];
  for (const [name, text, lead, error] of rows) {
    if (error) {
      assert.throws(() => parseTeamFile("duo", text), { message: error }, name);
      continue;
    }
    const team = parseTeamFile("duo", text);
    assert.equal(team.lead, lead, name);
    assert.deepEqual(parseTeamFile("duo", serializeTeam(team)), team, `${name}: round trip`);
    assert.equal(serializeTeam(team).includes("## Lead"), lead !== null, `${name}: written whenever it has a lead`);
  }
});

const setup = (teamFile) => teamProject("aya-lead-", { tabs: [{ id: "pane-1" }], teamFile });

test("the window's save keeps the lead through validation", () => {
  const team = parseTeamFile("duo", withSections(LEAD_FIXER));
  assert.equal(validateTeamDefinition(JSON.parse(JSON.stringify(team))).lead, "fixer");
  assert.equal(validateTeamDefinition({ ...team, lead: undefined }).lead, null);
  assert.throws(() => validateTeamDefinition({ ...team, lead: 7 }), /lead/);
});

test("a saved team with no Lead still loads, and the window says to set one", async () => {
  const t = setup(BODY.replace("# duo", "# ux-review"));
  try {
    const [team] = await listTeams(t.teamHome, t.project);
    assert.equal(team.error, null);
    assert.equal(team.definition.lead, null);
    assert.match(view.leadWarning(team.definition), /^no lead role: set one$/);
    assert.equal(view.leadWarning(parseTeamFile("duo", withSections(LEAD_FIXER))), null);
    assert.equal(view.leadWarning(null), null);
  } finally {
    t.cleanup();
  }
});

test("who gets the Start task: --to, else the lead (the cadence role is the lead), else the first role", () => {
  const rows = [
    ["lead and cadence on another role (an old file): the rhythm's role leads, no --to", withSections(LEAD_FIXER, CADENCE_REVIEWER), undefined, "reviewer"],
    ["lead is the cadence role, no --to", withSections("## Lead\nreviewer", CADENCE_REVIEWER), undefined, "reviewer"],
    ["lead, no cadence, no --to", withSections(LEAD_FIXER), undefined, "fixer"],
    ["cadence only, no --to", withSections(CADENCE_REVIEWER), undefined, "reviewer"],
    ["no lead, no cadence, no --to", BODY, undefined, "reviewer"],
    ["lead, --to another role", withSections(LEAD_FIXER), "reviewer", "reviewer"],
    ["lead, --to the lead", withSections(LEAD_FIXER), "fixer", "fixer"],
    ["lead, --to unknown", withSections(LEAD_FIXER), "ghost", /has no role "ghost"/],
  ];
  for (const [name, text, to, expected] of rows) {
    const team = parseTeamFile("duo", text);
    if (expected instanceof RegExp) assert.throws(() => taskRecipient(team, to), { message: expected }, name);
    else assert.equal(taskRecipient(team, to), expected, name);
  }
});

test("the editor: the lead survives a round trip, a rename, and goes with its role", () => {
  const team = parseTeamFile("duo", withSections(LEAD_FIXER));
  const key = (t, id) => t.roles.find((r) => r.id === id).key;
  assert.deepEqual(fromEditor(toEditor(team)), team);
  const renamed = updateRole(toEditor(team), key(toEditor(team), "fixer"), { id: "dev" });
  assert.equal(fromEditor(renamed).lead, "dev");
  const unnamed = updateRole(toEditor(team), key(toEditor(team), "fixer"), { id: "" });
  assert.equal(fromEditor(unnamed).lead, null);
  assert.ok(edit.leadProblem(unnamed), "Save stays off while the lead's row has no name");
  assert.equal(edit.leadProblem(updateRole(unnamed, key(unnamed, ""), { id: "dev" })), null);
  assert.equal(fromEditor(updateRole(unnamed, key(unnamed, ""), { id: "dev" })).lead, "dev");
  assert.equal(fromEditor(addRole(toEditor(team))).lead, "fixer", "a role added after the pick leaves the lead alone");
  const removed = removeRole(toEditor(team), key(toEditor(team), "fixer"));
  assert.equal(removed.lead, null);
  assert.equal(fromEditor(removed).lead, null);
  assert.ok(edit.leadProblem(removed), "with its lead removed, Save waits for a new one (the rounds go to it)");
  const legacy = toEditor(parseTeamFile("duo", BODY));
  assert.equal(legacy.lead, null);
  assert.equal(fromEditor(addRole(legacy)).lead, null);
});

test("the editor asks for a lead exactly when the saved file would refuse the team", () => {
  for (const text of [BODY, withSections(LEAD_FIXER)]) {
    const t = toEditor(parseTeamFile("duo", text));
    assert.equal(edit.leadProblem(t) === null, fromEditor(t).lead !== null);
  }
  assert.match(edit.leadProblem(toEditor(parseTeamFile("duo", BODY))), /Pick the role that leads/);
});

test("the guide: Lead is required and explained, Cadence stays optional, the example has a lead", () => {
  const guide = teamGuide(undefined, []);
  assert.match(guide, /Required "## Lead": one line/);
  assert.match(guide, /checks that nobody waits too long/);
  assert.match(guide, /Optional "## Cadence"/);
  const example = guide.slice(guide.indexOf("----- example"), guide.indexOf("----- end of example"));
  assert.equal(parseTeamFile("ux-fix", example.replace(/^.*\n# ux-fix/s, "# ux-fix")).lead !== null, true);
  assert.match(guide, /the task goes to the lead/i);
});
