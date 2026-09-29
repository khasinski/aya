// The guide `aya team new` prints: its rule values come from the parser's own
// constants, and its example is a file the real save accepts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { teamProject } from "./helpers/team.mjs";

const { teamGuide, handleTeamAuthorRequest, GUIDE_EXAMPLE_START, GUIDE_EXAMPLE_END } = await import("../dist-electron/team-author.js");
const { ID_MAX_LEN, MAX_CADENCE_MINUTES, MIN_TEAM_ROLES, MUST_NOT_FIELD, SENDS_TO_FIELD, TEAM_SYSTEM_SENDER, parseTeamFile } =
  await import("../dist-electron/teams.js");
const { WHAT_WORDS } = await import("../dist-electron/team-draft.js");

const guide = teamGuide(undefined, []);

function example(text) {
  const start = text.indexOf(`${GUIDE_EXAMPLE_START}\n`);
  const end = text.indexOf(`\n${GUIDE_EXAMPLE_END}`);
  assert.ok(start >= 0 && end > start, "the guide marks its example");
  return text.slice(start + GUIDE_EXAMPLE_START.length + 1, end + 1);
}

test("every rule value is the parser's own", () => {
  for (const expected of [
    `1-${MAX_CADENCE_MINUTES}`,
    `at most ${ID_MAX_LEN} characters`,
    `"${TEAM_SYSTEM_SENDER}" is reserved`,
    `at least ${MIN_TEAM_ROLES} roles`,
    `${SENDS_TO_FIELD}: <role> (<what>), <role> (<what>)`,
    `${MUST_NOT_FIELD}: <one line>`,
    WHAT_WORDS,
    ".aya/teams/<name>.md",
    "aya team save",
    "--replace",
  ]) {
    assert.ok(guide.includes(expected), `guide names ${expected}`);
  }
});

test("the example is a complete file the real save accepts, every route with a what", async () => {
  const text = example(guide);
  const team = parseTeamFile("ux-fix", text);
  assert.ok(team.roles.length >= 3);
  assert.ok(team.cadence);
  assert.ok(team.protocol);
  for (const role of team.roles) {
    assert.ok(role.responsibilities, role.id);
    for (const route of role.sendsTo) assert.ok(route.what, `${role.id} -> ${route.to}`);
  }
  const t = teamProject("aya-guide-", { tabs: [{ id: "pane-1" }] });
  try {
    const deps = { teamHome: t.teamHome, listProjects: async () => [t.project] };
    const { output } = await handleTeamAuthorRequest({ type: "team-save", text, replace: false }, "pane-1", deps, async () => {});
    assert.match(output, /^saved team ux-fix: /);
    assert.ok(readFileSync(join(t.directory, ".aya", "teams", "ux-fix.md"), "utf8").startsWith("# ux-fix\n"));
  } finally {
    t.cleanup();
  }
});

test("any agent CLI can follow it: no one harness's words", () => {
  assert.doesNotMatch(guide, /claude|codex|grok|gemini|skill|slash|\/clear|\/resume|tool call/i);
});

test("the description leads, on one line, and the guide is the same without one", () => {
  const asked = teamGuide("a team that\nreviews and fixes the UX", []);
  assert.ok(asked.startsWith("The user asked for: a team that reviews and fixes the UX\n\n"));
  assert.equal(asked.slice(asked.indexOf("\n\n") + 2), guide);
  assert.equal(teamGuide("   ", []), guide);
});

test("existing teams are named, with what reusing a name takes", () => {
  const listed = teamGuide(undefined, ["review", "ux-fix"]);
  assert.match(listed, /Teams this project already has: review, ux-fix\. Saving under one of these names needs --replace; ask the user first\./);
});

test("the last step proposes a pane per role and opens panes only after the user says yes", () => {
  const steps = guide.slice(guide.indexOf("Steps\n"), guide.indexOf("\nThe team file\n"));
  const last = steps.slice(steps.lastIndexOf("\n5. "));
  assert.match(last, /aya presets/);
  assert.match(last, /aya pane list/);
  assert.match(last, /installed/);
  assert.match(last, /one role per pane/);
  assert.match(last, /several roles may take the same preset: each gets its own pane/);
  assert.match(last, /this pane you run in/);
  assert.match(last, /wait for the user's yes/i);
  assert.match(last, /aya team open <team> <role>=<target>/);
  assert.match(last, /<target> is a preset id, this, or a pane's name or id/);
  assert.match(last, /new:<preset> or pane:<name>/);
  assert.match(last, /\n6\. Ask the user whether to start the team now, and with what task/);
  assert.match(last, /only on the user's word: aya team start <team> "<task>"/);
  assert.match(last, /it prints who got the task/);
  assert.match(guide, /Put first the role that takes the user's request and hands out the work/);
  assert.match(last, /Never open panes without the user's yes/);
  assert.ok(last.indexOf("aya presets") < last.indexOf("aya team open"), "presets are read before any pane opens");
});
