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
