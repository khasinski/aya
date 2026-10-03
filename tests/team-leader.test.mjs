// A role with "## Cadence" IS the lead; Cadence and Lead naming different roles is refused when saved and
// warned about when an old file loads.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { teamProject } from "./helpers/team.mjs";
import * as edit from "../dist-test/team-edit.js";
import * as view from "../dist-test/team-view.js";

const { parseTeamFile, serializeTeam } = await import("../dist-electron/team-definition.js");
const { handleTeamAuthorRequest, teamGuide } = await import("../dist-electron/team-author.js");
const { listTeams, saveTeam } = await import("../dist-electron/team-admin.js");
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
const LEAD = (role) => `## Lead\n${role}`;
const CADENCE = (role) => `## Cadence\n${role} every 30 min`;
const NO_LEAD = /^team "duo": no role leads it; add "## Lead" with the role that starts the work and checks nobody waits too long$/;
const DIFFERENT = /^team "duo": cadence and lead name different roles; make them the same$/;

// [name, sections, who leads once loaded, the periodic round goes to (always the lead), saved?, why not]
const FILES = [
  ["only Cadence", [CADENCE("reviewer")], "reviewer", "reviewer", true, null],
  ["only Lead", [LEAD("fixer")], "fixer", null, true, null],
  ["Lead and Cadence on one role", [LEAD("reviewer"), CADENCE("reviewer")], "reviewer", "reviewer", true, null],
  ["Lead and Cadence on different roles", [LEAD("fixer"), CADENCE("reviewer")], "reviewer", "reviewer", false, DIFFERENT],
  ["neither", [], null, null, false, NO_LEAD],
];

function setup(teamFile) {
  const t = teamProject("aya-leader-", { tabs: [{ id: "pane-1" }], teamFile });
  const deps = { teamHome: t.teamHome, listProjects: async () => [t.project] };
  const agentSave = (text) => handleTeamAuthorRequest({ type: "team-save", text, replace: false }, "pane-1", deps, async () => {});
  return { ...t, agentSave, file: join(t.directory, ".aya", "teams", "duo.md") };
}

test("loading: who leads, and the one warning, for every kind of file", async (s) => {
  for (const [name, sections, lead, cadenceRole, , why] of FILES) {
    await s.test(name, async () => {
      const team = parseTeamFile("duo", withSections(...sections));
      assert.equal(team.lead, lead, "lead");
      assert.equal(team.cadenceMinutes === null ? null : team.lead, cadenceRole, "the periodic round's role");
      assert.equal(team.leadConflict ?? null, why === DIFFERENT ? "fixer" : null, "the lead the cadence overrides");
      assert.equal(view.leadWarning(team) !== null, lead === null || why === DIFFERENT, "the card warns exactly then");
      if (why === DIFFERENT) assert.match(view.leadWarning(team), /cadence and lead name different roles: rounds go to reviewer/);
      if (lead === null) assert.equal(view.leadWarning(team), "no lead role: set one");
    });
  }
});

test("loading an old file through the window's list: the warning shows, nothing is refused", async () => {
  const t = setup(withSections(LEAD("fixer"), CADENCE("reviewer")).replace("# duo", "# ux-review"));
  try {
    const [team] = await listTeams(t.teamHome, t.project);
    assert.equal(team.error, null);
    assert.equal(team.definition.lead, "reviewer");
    assert.match(view.leadWarning(team.definition), /different roles/);
  } finally {
    t.cleanup();
  }
});

test("saving: by an agent or from the window, for every kind of file", async (s) => {
  for (const [name, sections, lead, , saved, why] of FILES) {
    for (const how of ["agent", "window (parsed)", "window (a plain object)"]) {
      await s.test(`${name} | ${how}`, async () => {
        const t = setup();
        try {
          const text = withSections(...sections);
          const parsed = parseTeamFile("duo", text);
          // The renderer's model drops leadConflict (the Lead the cadence overrides).
          const plain = { ...parsed, leadConflict: undefined };
          const save =
            how === "agent"
              ? () => t.agentSave(text)
              : () => saveTeam(t.teamHome, t.project, validateTeamDefinition(JSON.parse(JSON.stringify(how === "window (parsed)" ? parsed : plain))), { create: true });
          // An old file's two roles reach the window's model as the rhythm's role leading.
          const ok = saved || (how === "window (a plain object)" && why === DIFFERENT);
          if (ok) await save();
          else await assert.rejects(save, { message: why });
          assert.equal(existsSync(t.file), ok, "the file is written only when saved");
          if (ok) assert.equal(parseTeamFile("duo", readFileSync(t.file, "utf8")).lead, lead);
        } finally {
          t.cleanup();
        }
      });
    }
  }
});

test("a cadence-only file keeps working after the save: the Lead it implies is written", async () => {
  const t = setup();
  try {
    await t.agentSave(withSections(CADENCE("reviewer")));
    const written = readFileSync(t.file, "utf8");
    assert.match(written, /## Lead\nreviewer/);
    assert.match(written, /## Cadence\nreviewer every 30 min/);
    assert.deepEqual(parseTeamFile("duo", written), parseTeamFile("duo", withSections(CADENCE("reviewer"))));
  } finally {
    t.cleanup();
  }
});

test("the window's validation keeps the conflict it was told of", () => {
  const team = parseTeamFile("duo", withSections(LEAD("fixer"), CADENCE("reviewer")));
  assert.equal(validateTeamDefinition(JSON.parse(JSON.stringify(team))).leadConflict, "fixer");
  assert.equal(validateTeamDefinition({ ...team, leadConflict: undefined }).leadConflict ?? null, null);
  assert.throws(() => validateTeamDefinition({ ...team, leadConflict: 7 }), /leadConflict/);
});

test("the Start task: --to, else the lead, else the first role; the rhythm's role is the lead", () => {
  const rows = [
    ["only Cadence", [CADENCE("fixer")], undefined, "fixer"],
    ["only Lead", [LEAD("fixer")], undefined, "fixer"],
    ["Lead and Cadence on different roles (old file): the rhythm's role", [LEAD("fixer"), CADENCE("reviewer")], undefined, "reviewer"],
    ["neither: the first role", [], undefined, "reviewer"],
    ["--to wins over the lead", [CADENCE("fixer")], "reviewer", "reviewer"],
    ["--to unknown", [LEAD("fixer")], "ghost", /has no role "ghost"/],
  ];
  for (const [name, sections, to, expected] of rows) {
    const team = parseTeamFile("duo", withSections(...sections));
    if (expected instanceof RegExp) assert.throws(() => taskRecipient(team, to), { message: expected }, name);
    else assert.equal(taskRecipient(team, to), expected, name);
  }
});

test("the editor: the rhythm goes with the lead, so the two can never name different roles", () => {
  const key = (t, id) => t.roles.find((r) => r.id === id).key;
  const team = toEditorOf(withSections(LEAD("reviewer"), CADENCE("reviewer")));
  const moved = edit.setLead(team, key(team, "fixer"));
  assert.deepEqual([edit.fromEditor(moved).lead, edit.fromEditor(moved).cadenceMinutes], ["fixer", 30]);
  // A team the user loaded with the two apart is shown with the rhythm's role leading, so Save works.
  const apart = toEditorOf(withSections(LEAD("fixer"), CADENCE("reviewer")));
  assert.equal(edit.leadProblem(apart), null);
  assert.equal(edit.fromEditor(apart).lead, "reviewer");
  assert.match(edit.leadProblem(edit.setLead(team, null)), /Pick the role that leads/);
  // Clearing the rhythm leaves the lead; a rhythm on a team with no lead waits for one.
  assert.equal(edit.fromEditor(edit.setCadence(team, null)).lead, "reviewer");
  assert.match(edit.leadProblem(edit.setCadence(toEditorOf(BODY), 30)), /Pick the role that leads/);
});

function toEditorOf(text) {
  return edit.toEditor(parseTeamFile("duo", text));
}

test("the guide: the lead is named explicitly, the rhythm is optional and belongs to the lead", () => {
  const guide = teamGuide(undefined, []);
  assert.match(guide, /Required "## Lead": one line/);
  assert.match(guide, /Optional "## Cadence"[^\n]*the lead's role/);
  assert.match(guide, /cadence and lead name different roles/);
  assert.match(guide, /no Cadence/i);
  const example = guide.slice(guide.indexOf("----- example"), guide.indexOf("----- end of example"));
  const team = parseTeamFile("ux-fix", example.replace(/^.*\n# ux-fix/s, "# ux-fix"));
  assert.ok(team.lead && team.cadenceMinutes, "the example has a lead and its rhythm");
  assert.match(example, new RegExp(`## Cadence\\n${team.lead} every`), "the example's rhythm names the lead");
  assert.equal(serializeTeam(team).includes("## Lead"), true);
});
