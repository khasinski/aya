// What the teams window reads and writes: each team of a project with its
// state, Save team (repo file + the snapshot Aya uses), and role assignment.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { listTeams, saveTeam, assignRole } = await import("../dist-electron/team-admin.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");

const TEAM = {
  name: "ux-review",
  roles: [
    { id: "tester", sendsTo: ["implementer"], mustNot: "edit code", responsibilities: "Plays the build." },
    { id: "implementer", sendsTo: ["tester"], mustNot: "skip a report", responsibilities: "" },
  ],
  cadence: { role: "tester", minutes: 30 },
  protocol: "One round every 30 minutes.",
};

function setup() {
  const root = mkdtempSync(join(tmpdir(), "aya-admin-"));
  const directory = join(root, "game");
  mkdirSync(directory, { recursive: true });
  const project = { slug: "game", name: "game", directory, tabs: [{ id: "pane-t" }, { id: "pane-i" }] };
  const teamHome = join(root, "aya");
  return { root, project, teamHome, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("Save team writes the repo file and the snapshot Aya runs on", async () => {
  const t = setup();
  try {
    await saveTeam(t.teamHome, t.project, TEAM);
    const repo = readFileSync(join(t.project.directory, ".aya", "teams", "ux-review.md"), "utf8");
    assert.match(repo, /## Role: tester\nSends to: implementer\nMust not: edit code/);
    const [team] = await listTeams(t.teamHome, t.project);
    assert.deepEqual(team.definition, TEAM);
    assert.equal(team.repoChanged, false);
    assert.equal(team.error, null);
  } finally {
    t.cleanup();
  }
});

test("an invalid team is refused and nothing is written", async () => {
  const t = setup();
  try {
    const bad = { ...TEAM, roles: [{ ...TEAM.roles[0], mustNot: "" }, TEAM.roles[1]] };
    await assert.rejects(saveTeam(t.teamHome, t.project, bad), /Must not/);
    assert.deepEqual(await listTeams(t.teamHome, t.project), []);
  } finally {
    t.cleanup();
  }
});

test("a repo edit after Save shows as changed; Aya keeps using the saved one", async () => {
  const t = setup();
  try {
    await saveTeam(t.teamHome, t.project, TEAM);
    const file = join(t.project.directory, ".aya", "teams", "ux-review.md");
    writeFileSync(file, readFileSync(file, "utf8").replace("edit code", "nothing"));
    const [team] = await listTeams(t.teamHome, t.project);
    assert.equal(team.repoChanged, true);
    assert.equal(team.definition.roles[0].mustNot, "edit code");
    assert.equal(team.repoDefinition.roles[0].mustNot, "nothing");
  } finally {
    t.cleanup();
  }
});

test("a repo team never saved in Aya is listed from the file, marked as not yet saved", async () => {
  const t = setup();
  try {
    mkdirSync(join(t.project.directory, ".aya", "teams"), { recursive: true });
    writeFileSync(join(t.project.directory, ".aya", "teams", "broken.md"), "## Role: x\n");
    await saveTeam(t.teamHome, t.project, TEAM);
    const teams = await listTeams(t.teamHome, t.project);
    assert.deepEqual(teams.map((x) => x.name), ["broken", "ux-review"]);
    assert.match(teams[0].error, /Must not|two roles/);
    assert.equal(teams[0].definition, null);
  } finally {
    t.cleanup();
  }
});

test("assignments, pause state and the recent log come back with the team", async () => {
  const t = setup();
  try {
    await saveTeam(t.teamHome, t.project, TEAM);
    await assignRole(t.teamHome, t.project, "ux-review", "tester", "pane-t");
    await assignRole(t.teamHome, t.project, "ux-review", "implementer", "pane-i");
    await assignRole(t.teamHome, t.project, "ux-review", "implementer", null);
    const store = new TeamStore(teamDir(t.teamHome, "game", "ux-review"));
    await store.append({ from: "tester", to: "implementer", commit: null, text: "hi", delivered: true });
    await store.setPaused(true);
    const [team] = await listTeams(t.teamHome, t.project);
    assert.deepEqual(team.assignments, { tester: "pane-t" });
    assert.equal(team.paused, true);
    assert.deepEqual(team.log.map((m) => m.text), ["hi"]);
  } finally {
    t.cleanup();
  }
});

test("a pane from another project cannot take a role", async () => {
  const t = setup();
  try {
    await saveTeam(t.teamHome, t.project, TEAM);
    await assert.rejects(assignRole(t.teamHome, t.project, "ux-review", "tester", "pane-elsewhere"), /not in this project/);
  } finally {
    t.cleanup();
  }
});

test("each role's unread count comes with the team", async () => {
  const t = setup();
  try {
    await saveTeam(t.teamHome, t.project, TEAM);
    const store = new TeamStore(teamDir(t.teamHome, "game", "ux-review"));
    await store.append({ from: "tester", to: "implementer", commit: null, text: "waiting", delivered: false });
    await store.append({ from: "tester", to: "implementer", commit: null, text: "typed", delivered: true });
    const [team] = await listTeams(t.teamHome, t.project);
    assert.deepEqual(team.unread, { tester: 0, implementer: 1 });
  } finally {
    t.cleanup();
  }
});

test("a remote project's panes cannot take a role", async () => {
  const t = setup();
  try {
    await saveTeam(t.teamHome, t.project, TEAM);
    const remote = { ...t.project, remote: { hostId: "h", label: "box", sshTarget: "box", directory: "/srv" } };
    await assert.rejects(assignRole(t.teamHome, remote, "ux-review", "tester", "pane-t"), /only on local panes/);
  } finally {
    t.cleanup();
  }
});
