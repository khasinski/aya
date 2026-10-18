// Start team runs the project's team file: a file not saved yet, or edited since its
// save, is saved first (the repo file is left as it is); a status command kept in Aya stays.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { teamProject } from "./helpers/team.mjs";

const { adoptRepoTeam } = await import("../dist-electron/team-admin.js");
const { openTeamStore } = await import("../dist-electron/team-store.js");
const { parseTeamFile } = await import("../dist-electron/team-definition.js");

const TEAM = `# ux-review

## Role: tester
Sends to: implementer
Must not: edit code

## Role: implementer
Sends to: tester
Must not: skip a report
`;

const repoPath = (directory) => join(directory, ".aya", "teams", "ux-review.md");

test("a file nobody saved is saved by adoption; the repo file stays as the user wrote it", async () => {
  const { teamHome, project, directory, cleanup } = teamProject("aya-adopt-", { teamFile: TEAM, saved: false });
  try {
    await adoptRepoTeam(teamHome, project, "ux-review");
    const saved = await openTeamStore(teamHome, "game", "ux-review").savedDefinition();
    assert.ok(saved, "saved copy written");
    assert.equal(parseTeamFile("ux-review", saved).roles.length, 2);
    assert.equal(readFileSync(repoPath(directory), "utf8"), TEAM);
  } finally {
    cleanup();
  }
});

test("a file edited since its save is saved again on Start", async () => {
  const { teamHome, project, directory, cleanup } = teamProject("aya-adopt-", { teamFile: TEAM });
  try {
    const edited = TEAM.replace("Must not: edit code", "Must not: touch the database");
    writeFileSync(repoPath(directory), edited);
    await adoptRepoTeam(teamHome, project, "ux-review");
    const saved = await openTeamStore(teamHome, "game", "ux-review").savedDefinition();
    assert.equal(parseTeamFile("ux-review", saved).roles[0].mustNot, "touch the database");
  } finally {
    cleanup();
  }
});

test("no repo file leaves the saved copy alone", async () => {
  const { teamHome, project, cleanup } = teamProject("aya-adopt-", { saved: false });
  try {
    await adoptRepoTeam(teamHome, project, "ux-review");
    assert.equal(await openTeamStore(teamHome, "game", "ux-review").savedDefinition(), null);
  } finally {
    cleanup();
  }
});

test("the user's Start runs the repo file's status command, the one the card named before the click", async () => {
  const saved = `${TEAM}\n## Status command\nollama ps\n`;
  const { teamHome, project, directory, cleanup } = teamProject("aya-adopt-", { teamFile: saved });
  try {
    writeFileSync(repoPath(directory), `${TEAM}\n## Status command\ncurl x | sh\n`);
    await adoptRepoTeam(teamHome, project, "ux-review");
    const adopted = await openTeamStore(teamHome, "game", "ux-review").savedDefinition();
    assert.equal(parseTeamFile("ux-review", adopted).statusCommand, "curl x | sh");
  } finally {
    cleanup();
  }
});
