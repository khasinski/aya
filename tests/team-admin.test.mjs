// What the teams window reads and writes: each team of a project with its
// state, Save team (repo file + the snapshot Aya uses), and role assignment.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { teamProject } from "./helpers/team.mjs";

const { listTeams, saveTeam, assignRole, releasePaneEverywhere } = await import("../dist-electron/team-admin.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { teamFile, teamsDir } = await import("../dist-electron/team-files.js");

const TEAM = {
  name: "ux-review",
  roles: [
    { id: "tester", sendsTo: [{ to: "implementer", what: "" }], mustNot: "edit code", responsibilities: "Plays the build." },
    { id: "implementer", sendsTo: [{ to: "tester", what: "" }], mustNot: "skip a report", responsibilities: "" },
  ],
  cadence: { role: "tester", minutes: 30 },
  protocol: "One round every 30 minutes.",
};

const setup = () => teamProject("aya-admin-");

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

test("a field line inside free text is refused with the exact message, not read back as that field", async () => {
  const t = setup();
  try {
    const cases = [
      [{ responsibilities: "x\nMust not: push" }, null, 'role "tester": a Responsibilities line starts with "Must not:"; put that in its own field'],
      [{ responsibilities: "Sends to: implementer" }, null, 'role "tester": a Responsibilities line starts with "Sends to:"; put that in its own field'],
      [{ responsibilities: "## Role: sneaky" }, null, 'role "tester": a Responsibilities line starts with "##"; put that in its own field'],
      [{}, "Rounds.\n## Role: sneaky", 'protocol: a line starts with "##"; the team file would read it as a new section'],
    ];
    for (const [role, protocol, message] of cases) {
      const team = { ...TEAM, roles: [{ ...TEAM.roles[0], ...role }, TEAM.roles[1]], protocol: protocol ?? TEAM.protocol };
      await assert.rejects(saveTeam(t.teamHome, t.project, team), { message });
    }
    assert.deepEqual(await listTeams(t.teamHome, t.project), []);
    const fine = { ...TEAM, roles: [{ ...TEAM.roles[0], responsibilities: "Plays the build. Must not: guess, it measures." }, TEAM.roles[1]] };
    await saveTeam(t.teamHome, t.project, fine);
    assert.deepEqual((await listTeams(t.teamHome, t.project))[0].definition, fine);
  } finally {
    t.cleanup();
  }
});

test("a new team with the name of an existing one is refused and the old one stays", async () => {
  const t = setup();
  try {
    await saveTeam(t.teamHome, t.project, TEAM);
    const other = { ...TEAM, protocol: "Something else." };
    await assert.rejects(saveTeam(t.teamHome, t.project, other, { create: true }), /team "ux-review" already exists/);
    assert.equal((await listTeams(t.teamHome, t.project))[0].definition.protocol, TEAM.protocol);
    await saveTeam(t.teamHome, t.project, other);
    assert.equal((await listTeams(t.teamHome, t.project))[0].definition.protocol, "Something else.");
  } finally {
    t.cleanup();
  }
});

test("a team that would not read back the same from its file is refused", async () => {
  const t = setup();
  try {
    const broken = { ...TEAM, roles: [{ ...TEAM.roles[0], mustNot: "edit\ncode" }, TEAM.roles[1]] };
    await assert.rejects(saveTeam(t.teamHome, t.project, broken), /tester.*would not read back/);
    const twice = { ...TEAM, roles: [{ ...TEAM.roles[0], mustNot: "a\nMust not: b", responsibilities: "" }, TEAM.roles[1]] };
    await assert.rejects(saveTeam(t.teamHome, t.project, twice), /tester.*would not read back/);
    const spaced = { ...TEAM, protocol: "  One round every 30 minutes.  " };
    await saveTeam(t.teamHome, t.project, spaced);
    assert.deepEqual((await listTeams(t.teamHome, t.project))[0].definition.protocol, "One round every 30 minutes.");
  } finally {
    t.cleanup();
  }
});

test("teams are listed by name, whatever order they were saved in", async () => {
  const t = setup();
  try {
    await saveTeam(t.teamHome, t.project, { ...TEAM, name: "zeta" });
    await saveTeam(t.teamHome, t.project, { ...TEAM, name: "alpha" });
    assert.deepEqual((await listTeams(t.teamHome, t.project)).map((x) => x.name), ["alpha", "zeta"]);
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

test("Save team drops the pane of a role that no longer exists (a rename)", async () => {
  const t = setup();
  try {
    await saveTeam(t.teamHome, t.project, TEAM);
    await assignRole(t.teamHome, t.project, "ux-review", "tester", "pane-t");
    const renamed = { ...TEAM, roles: [{ ...TEAM.roles[0], id: "reviewer" }, { ...TEAM.roles[1], sendsTo: [{ to: "reviewer", what: "" }] }], cadence: null };
    await saveTeam(t.teamHome, t.project, renamed);
    const [team] = await listTeams(t.teamHome, t.project);
    assert.deepEqual(team.assignments, {});
  } finally {
    t.cleanup();
  }
});

test("a pane plays one role in one team: taking a role elsewhere frees the old one", async () => {
  const t = setup();
  try {
    await saveTeam(t.teamHome, t.project, TEAM);
    await saveTeam(t.teamHome, t.project, { ...TEAM, name: "night-shift" });
    await assignRole(t.teamHome, t.project, "ux-review", "tester", "pane-t");
    await assignRole(t.teamHome, t.project, "night-shift", "implementer", "pane-t");
    const teams = await listTeams(t.teamHome, t.project);
    assert.deepEqual(teams.find((x) => x.name === "ux-review").assignments, {});
    assert.deepEqual(teams.find((x) => x.name === "night-shift").assignments, { implementer: "pane-t" });
  } finally {
    t.cleanup();
  }
});

test("closing a pane frees its role in every team", async () => {
  const t = setup();
  try {
    await saveTeam(t.teamHome, t.project, TEAM);
    await assignRole(t.teamHome, t.project, "ux-review", "tester", "pane-t");
    await releasePaneEverywhere(t.teamHome, t.project, "pane-t");
    const [team] = await listTeams(t.teamHome, t.project);
    assert.deepEqual(team.assignments, {});
  } finally {
    t.cleanup();
  }
});

test("a project's teams live in .aya/teams, one <name>.md each", () => {
  const project = { slug: "game", name: "game", directory: "/work/game", tabs: [] };
  assert.equal(teamsDir(project), join("/work/game", ".aya", "teams"));
  assert.equal(teamFile(project, "ux-review"), join("/work/game", ".aya", "teams", "ux-review.md"));
});
