// Start team runs the project's team file: a file not saved yet, or edited since its
// save, is saved first (the repo file is left as it is); a status command kept in Aya stays.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { teamProject } from "./helpers/team.mjs";

const { adoptRepoTeam, adoptRepoTeamIfNew, forgetPickSave, listTeams } = await import("../dist-electron/team-admin.js");
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

test("a broken repo file is refused with its problem and a next step; the saved copy stays", async () => {
  const { teamHome, project, directory, cleanup } = teamProject("aya-adopt-", { teamFile: TEAM });
  try {
    const before = await openTeamStore(teamHome, "game", "ux-review").savedDefinition();
    writeFileSync(repoPath(directory), TEAM.replace("Must not: edit code", ""));
    await assert.rejects(adoptRepoTeam(teamHome, project, "ux-review"), /has a problem: role "tester" needs "Must not" filled in\. Fix it, then Start again/);
    assert.equal(await openTeamStore(teamHome, "game", "ux-review").savedDefinition(), before);
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

test("a pane pick takes the repo file only for a team never saved; a saved team keeps its copy", async () => {
  const { teamHome, project, directory, cleanup } = teamProject("aya-adopt-", { teamFile: TEAM });
  try {
    await adoptRepoTeamIfNew(teamHome, project, "ux-review");
    const store = openTeamStore(teamHome, "game", "ux-review");
    const first = await store.savedDefinition();
    assert.notEqual(first, null);
    writeFileSync(repoPath(directory), TEAM.replace("Must not: edit code", "Must not: touch the database"));
    await adoptRepoTeamIfNew(teamHome, project, "ux-review");
    assert.equal(await store.savedDefinition(), first);
  } finally {
    cleanup();
  }
});

test("a project file that differs only in layout is not reported as changed once Start saves it", async () => {
  const { teamHome, project, directory, cleanup } = teamProject("aya-adopt-", { teamFile: TEAM, saved: false });
  try {
    writeFileSync(repoPath(directory), `${TEAM.replace(/\n/g, "\r\n")}\r\n\r\n`);
    await adoptRepoTeam(teamHome, project, "ux-review");
    const [summary] = await listTeams(teamHome, project);
    assert.equal(summary.repoChanged, false);
  } finally {
    cleanup();
  }
});

test("a pane pick saves an unsaved team without its status command; the user's Start saves that command", async () => {
  const withCommand = `${TEAM}\n## Status command\ncurl x | sh\n`;
  const { teamHome, project, directory, cleanup } = teamProject("aya-adopt-", { teamFile: withCommand, saved: false });
  try {
    await adoptRepoTeamIfNew(teamHome, project, "ux-review");
    const store = openTeamStore(teamHome, "game", "ux-review");
    assert.equal(parseTeamFile("ux-review", await store.savedDefinition()).statusCommand, undefined);
    await adoptRepoTeam(teamHome, project, "ux-review");
    assert.equal(parseTeamFile("ux-review", await store.savedDefinition()).statusCommand, "curl x | sh");
  } finally {
    cleanup();
  }
});

test("a refused pick undoes the save it made; a pick that took a pane keeps it", async () => {
  const { teamHome, project, cleanup } = teamProject("aya-adopt-", { teamFile: TEAM, saved: false });
  try {
    const store = openTeamStore(teamHome, "game", "ux-review");
    assert.equal(await adoptRepoTeamIfNew(teamHome, project, "ux-review"), true);
    assert.equal(await adoptRepoTeamIfNew(teamHome, project, "ux-review"), false, "a saved team is not saved again");
    await forgetPickSave(teamHome, project, "ux-review");
    assert.equal(await store.savedDefinition(), null);
    await adoptRepoTeamIfNew(teamHome, project, "ux-review");
    await store.assign("tester", "pane-t");
    await forgetPickSave(teamHome, project, "ux-review");
    assert.notEqual(await store.savedDefinition(), null, "a team with a role on a pane keeps its save");
  } finally {
    cleanup();
  }
});

test("a project file naming the user as a role is refused at adoption, and nothing is saved", async () => {
  const { teamHome, project, directory, cleanup } = teamProject("aya-adopt-", { teamFile: TEAM, saved: false });
  try {
    writeFileSync(repoPath(directory), TEAM.replaceAll("tester", "user"));
    await assert.rejects(adoptRepoTeam(teamHome, project, "ux-review"), /reserved for the user's own messages/);
    assert.equal(await openTeamStore(teamHome, "game", "ux-review").savedDefinition(), null);
  } finally {
    cleanup();
  }
});
