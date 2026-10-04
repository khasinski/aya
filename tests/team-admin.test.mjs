// What the teams window reads and writes: each team of a project with its
// state, Save team (repo file + the snapshot Aya uses), and role assignment.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { teamProject } from "./helpers/team.mjs";

const { LOG_TAIL, listTeams, saveTeam, assignRole, releasePaneEverywhere } = await import("../dist-electron/team-admin.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { teamFile, teamNames, teamsDir } = await import("../dist-electron/team-files.js");

const TEAM = {
  name: "ux-review",
  roles: [
    { id: "tester", sendsTo: [{ to: "implementer", what: "" }], mustNot: "edit code", responsibilities: "Plays the build." },
    { id: "implementer", sendsTo: [{ to: "tester", what: "" }], mustNot: "skip a report", responsibilities: "" },
  ],
  lead: "tester",
  cadenceMinutes: 30,
  protocol: "One round every 30 minutes.",
};

const setup = () => teamProject("aya-admin-");
const adminTest = (name, ...args) => {
  const fn = args.pop();
  test(name, async () => {
    const t = await setup(...args);
    try {
      await fn(t);
    } finally {
      t.cleanup();
    }
  });
};

adminTest("Save team writes the repo file and the snapshot Aya runs on", async (t) => {
  await saveTeam(t.teamHome, t.project, TEAM);
  const repo = readFileSync(join(t.project.directory, ".aya", "teams", "ux-review.md"), "utf8");
  assert.match(repo, /## Role: tester\nSends to: implementer\nMust not: edit code/);
  const [team] = await listTeams(t.teamHome, t.project);
  assert.deepEqual(team.definition, TEAM);
  assert.equal(team.repoChanged, false);
  assert.equal(team.error, null);
});

adminTest("an invalid team is refused and nothing is written", async (t) => {
  const bad = { ...TEAM, roles: [{ ...TEAM.roles[0], mustNot: "" }, TEAM.roles[1]] };
  await assert.rejects(saveTeam(t.teamHome, t.project, bad), /Must not/);
  assert.deepEqual(await listTeams(t.teamHome, t.project), []);
});

adminTest("a role named aya is refused on Save and nothing is written", async (t) => {
  const team = { ...TEAM, roles: [{ ...TEAM.roles[0], id: "aya" }, { ...TEAM.roles[1], sendsTo: [] }], lead: "implementer", cadenceMinutes: null };
  await assert.rejects(saveTeam(t.teamHome, t.project, team), /"aya" is reserved for Aya's own messages/);
  assert.deepEqual(await listTeams(t.teamHome, t.project), []);
});

adminTest("a role named user is refused on Save, but a team saved with one before still lists", async (t) => {
  const team = { ...TEAM, roles: [{ ...TEAM.roles[0], id: "user", sendsTo: [] }, { ...TEAM.roles[1], sendsTo: [] }], lead: "implementer", cadenceMinutes: null };
  await assert.rejects(saveTeam(t.teamHome, t.project, team), {
    message: `team "ux-review": "user" is reserved for the user's own messages; name the role something else`,
  });
  assert.deepEqual(await listTeams(t.teamHome, t.project), []);
  // As an older Aya saved it: both the repo file and the snapshot.
  const text = "# ux-review\n\n## Role: user\nSends to: implementer\nMust not: edit code\n\n## Role: implementer\nMust not: skip a report\n";
  mkdirSync(teamsDir(t.project), { recursive: true });
  writeFileSync(teamFile(t.project, "ux-review"), text);
  await new TeamStore(teamDir(t.teamHome, "game", "ux-review")).saveDefinition(text);
  const [listed] = await listTeams(t.teamHome, t.project);
  assert.equal(listed.error, null);
  assert.deepEqual(listed.definition.roles.map((r) => r.id), ["user", "implementer"]);
  assert.deepEqual(listed.repoDefinition.roles.map((r) => r.id), ["user", "implementer"]);
});

adminTest("a field line inside free text is refused with the exact message, not read back as that field", async (t) => {
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
});

adminTest("a new team with the name of an existing one is refused and the old one stays", async (t) => {
  await saveTeam(t.teamHome, t.project, TEAM);
  const other = { ...TEAM, protocol: "Something else." };
  await assert.rejects(saveTeam(t.teamHome, t.project, other, { create: true }), /team "ux-review" already exists/);
  assert.equal((await listTeams(t.teamHome, t.project))[0].definition.protocol, TEAM.protocol);
  await saveTeam(t.teamHome, t.project, other);
  assert.equal((await listTeams(t.teamHome, t.project))[0].definition.protocol, "Something else.");
});

adminTest("a team that would not read back the same from its file is refused", async (t) => {
  const broken = { ...TEAM, roles: [{ ...TEAM.roles[0], mustNot: "edit\ncode" }, TEAM.roles[1]] };
  await assert.rejects(saveTeam(t.teamHome, t.project, broken), /tester.*would not read back/);
  const twice = { ...TEAM, roles: [{ ...TEAM.roles[0], mustNot: "a\nMust not: b", responsibilities: "" }, TEAM.roles[1]] };
  await assert.rejects(saveTeam(t.teamHome, t.project, twice), /tester.*would not read back/);
  const crlf = { ...TEAM, roles: [{ ...TEAM.roles[0], responsibilities: "Plays.\r\nReports." }, TEAM.roles[1]] };
  await assert.rejects(saveTeam(t.teamHome, t.project, crlf), /tester.*would not read back/);
  const spaced = { ...TEAM, protocol: "  One round every 30 minutes.  " };
  await saveTeam(t.teamHome, t.project, spaced);
  assert.deepEqual((await listTeams(t.teamHome, t.project))[0].definition.protocol, "One round every 30 minutes.");
});

adminTest("teams are listed by name, whatever order they were saved in", async (t) => {
  await saveTeam(t.teamHome, t.project, { ...TEAM, name: "zeta" });
  await saveTeam(t.teamHome, t.project, { ...TEAM, name: "alpha" });
  assert.deepEqual((await listTeams(t.teamHome, t.project)).map((x) => x.name), ["alpha", "zeta"]);
});

adminTest("a repo edit after Save shows as changed; Aya keeps using the saved one", async (t) => {
  await saveTeam(t.teamHome, t.project, TEAM);
  const file = join(t.project.directory, ".aya", "teams", "ux-review.md");
  writeFileSync(file, readFileSync(file, "utf8").replace("edit code", "nothing"));
  const [team] = await listTeams(t.teamHome, t.project);
  assert.equal(team.repoChanged, true);
  assert.equal(team.definition.roles[0].mustNot, "edit code");
  assert.equal(team.repoDefinition.roles[0].mustNot, "nothing");
});

adminTest("a repo team never saved in Aya is listed from the file, marked as not yet saved", async (t) => {
  mkdirSync(join(t.project.directory, ".aya", "teams"), { recursive: true });
  writeFileSync(join(t.project.directory, ".aya", "teams", "broken.md"), "## Role: x\n");
  await saveTeam(t.teamHome, t.project, TEAM);
  const teams = await listTeams(t.teamHome, t.project);
  assert.deepEqual(teams.map((x) => x.name), ["broken", "ux-review"]);
  assert.match(teams[0].error, /Must not|two roles/);
  assert.equal(teams[0].definition, null);
  assert.equal(teams[0].repoChanged, false);
  assert.equal(teams[0].unsaved, true, "only the repo has it");
  assert.equal(teams[1].unsaved, false);
});

adminTest("assignments, pause state and the recent log come back with the team", async (t) => {
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
});

adminTest("a pane from another project cannot take a role", async (t) => {
  await saveTeam(t.teamHome, t.project, TEAM);
  await assert.rejects(assignRole(t.teamHome, t.project, "ux-review", "tester", "pane-elsewhere"), /not in this project/);
});

adminTest("each role's unread count comes with the team", async (t) => {
  await saveTeam(t.teamHome, t.project, TEAM);
  const store = new TeamStore(teamDir(t.teamHome, "game", "ux-review"));
  await store.append({ from: "tester", to: "implementer", commit: null, text: "waiting", delivered: false });
  await store.append({ from: "tester", to: "implementer", commit: null, text: "typed", delivered: true });
  const [team] = await listTeams(t.teamHome, t.project);
  assert.deepEqual(team.unread, { tester: 0, implementer: 1 });
});

// Only what a person's agent still has to read is "unread"; Aya's skipped rounds and tests are not.
const UNREAD_ROWS = [
  ["a held report", { from: "tester" }, 1],
  ["a held task from the user", { from: "user" }, 1],
  ["a round Aya could not type (busy)", { from: "aya", held: "is busy working" }, 0],
  ["four skipped rounds", { from: "aya", held: "is busy working", times: 4 }, 0],
  ["a held delivery test", { from: "aya", held: "shows an approval prompt" }, 0],
  ["a report and two skipped rounds", { from: "tester", extra: 2 }, 1],
];
for (const [name, entry, want] of UNREAD_ROWS) {
  adminTest(`unread count: ${name}`, async (t) => {
    await saveTeam(t.teamHome, t.project, TEAM);
    const store = new TeamStore(teamDir(t.teamHome, "game", "ux-review"));
    for (let i = 0; i < (entry.times ?? 1); i++) {
      await store.append({ from: entry.from, to: "implementer", commit: null, text: "waiting", delivered: false, held: entry.held ?? "shows an approval prompt" });
    }
    for (let i = 0; i < (entry.extra ?? 0); i++) await store.append({ from: "aya", to: "implementer", commit: null, text: "Round 1", delivered: false, held: "is busy working" });
    const [team] = await listTeams(t.teamHome, t.project);
    assert.equal(team.unread.implementer, want);
  });
}

// A report held for a role the team no longer has (a rename) is not "waiting in inbox" for ever.
const RENAMED = { ...TEAM, roles: [TEAM.roles[0], { ...TEAM.roles[1], id: "measurer" }].map((r) => ({ ...r, sendsTo: [{ to: r.id === "tester" ? "measurer" : "tester", what: "" }] })) };
const GONE_ROWS = [
  ["held for the renamed role", { from: "tester", to: "implementer", delivered: false, held: "shows an approval prompt" }, /^implementer is no longer a role of this team; this will not be delivered$/],
  ["held for a role that stayed", { from: "implementer", to: "tester", delivered: false, held: "shows an approval prompt" }, /^shows an approval prompt$/],
  ["already typed to the renamed role", { from: "tester", to: "implementer", delivered: true }, undefined],
  ["Aya's own round for the renamed role", { from: "aya", to: "implementer", delivered: false, held: "is busy working" }, /^implementer is no longer a role of this team; this will not be delivered$/],
];
for (const [name, entry, held] of GONE_ROWS) {
  adminTest(`a role is renamed: ${name}`, async (t) => {
    await saveTeam(t.teamHome, t.project, TEAM);
    const store = new TeamStore(teamDir(t.teamHome, "game", "ux-review"));
    await store.append({ ...entry, commit: null, text: "report" });
    await saveTeam(t.teamHome, t.project, RENAMED);
    const [team] = await listTeams(t.teamHome, t.project);
    const shown = team.log.at(-1);
    if (held) assert.match(shown.held, held);
    else assert.equal(shown.held, undefined);
    assert.equal(shown.delivered, entry.delivered);
  });
}

adminTest("a remote project's panes cannot take a role", async (t) => {
  await saveTeam(t.teamHome, t.project, TEAM);
  const remote = { ...t.project, remote: { hostId: "h", label: "box", sshTarget: "box", directory: "/srv" } };
  await assert.rejects(assignRole(t.teamHome, remote, "ux-review", "tester", "pane-t"), /only on local panes/);
});

adminTest("Save team drops the pane of a role that no longer exists (a rename)", async (t) => {
  await saveTeam(t.teamHome, t.project, TEAM);
  await assignRole(t.teamHome, t.project, "ux-review", "tester", "pane-t");
  const renamed = { ...TEAM, roles: [{ ...TEAM.roles[0], id: "reviewer" }, { ...TEAM.roles[1], sendsTo: [{ to: "reviewer", what: "" }] }], lead: "implementer", cadenceMinutes: null };
  await saveTeam(t.teamHome, t.project, renamed);
  const [team] = await listTeams(t.teamHome, t.project);
  assert.deepEqual(team.assignments, {});
});

adminTest("a pane plays one role in one team: taking a role elsewhere frees the old one", async (t) => {
  await saveTeam(t.teamHome, t.project, TEAM);
  await saveTeam(t.teamHome, t.project, { ...TEAM, name: "night-shift" });
  await assignRole(t.teamHome, t.project, "ux-review", "tester", "pane-t");
  await assignRole(t.teamHome, t.project, "night-shift", "implementer", "pane-t");
  const teams = await listTeams(t.teamHome, t.project);
  assert.deepEqual(teams.find((x) => x.name === "ux-review").assignments, {});
  assert.deepEqual(teams.find((x) => x.name === "night-shift").assignments, { implementer: "pane-t" });
});

adminTest("closing a pane frees its role in every team", async (t) => {
  await saveTeam(t.teamHome, t.project, TEAM);
  await assignRole(t.teamHome, t.project, "ux-review", "tester", "pane-t");
  await releasePaneEverywhere(t.teamHome, t.project, "pane-t");
  const [team] = await listTeams(t.teamHome, t.project);
  assert.deepEqual(team.assignments, {});
});

test("a project's teams live in .aya/teams, one <name>.md each", () => {
  const project = { slug: "game", name: "game", directory: "/work/game", tabs: [] };
  assert.equal(teamsDir(project), join("/work/game", ".aya", "teams"));
  assert.equal(teamFile(project, "ux-review"), join("/work/game", ".aya", "teams", "ux-review.md"));
});

adminTest("a held message the receiver has since had shows as delivered; Aya's own never do", async (t) => {
  await saveTeam(t.teamHome, t.project, TEAM);
  const store = new TeamStore(teamDir(t.teamHome, "game", "ux-review"));
  const held = (from, text) => store.append({ from, to: "implementer", commit: null, text, delivered: false, held: "busy" });
  await held("aya", "round 1");
  await held("tester", "had");
  await held("tester", "not yet");
  await store.markRead("implementer", 2);
  const [team] = await listTeams(t.teamHome, t.project);
  assert.deepEqual(team.log.map((m) => [m.text, m.delivered]), [["round 1", false], ["had", true], ["not yet", false]]);
});

adminTest("the team comes back with exactly the last LOG_TAIL messages", async (t) => {
  await saveTeam(t.teamHome, t.project, TEAM);
  const store = new TeamStore(teamDir(t.teamHome, "game", "ux-review"));
  for (let i = 1; i <= LOG_TAIL + 1; i++) {
    await store.append({ from: "tester", to: "implementer", commit: null, text: String(i), delivered: true });
  }
  const [team] = await listTeams(t.teamHome, t.project);
  assert.equal(team.log.length, LOG_TAIL);
  assert.equal(team.log[0].text, "2");
});

adminTest("only .md files in .aya/teams are teams", async (t) => {
  await saveTeam(t.teamHome, t.project, TEAM);
  writeFileSync(join(t.project.directory, ".aya", "teams", "notes.txt"), "not a team");
  assert.deepEqual(await teamNames(t.project), ["ux-review"]);
});

test("two concurrent creates of one new team: exactly one wins, the other is told it exists", async () => {
  const { TeamExistsError } = await import("../dist-electron/team-admin.js");
  const t = setup();
  try {
    const other = { ...TEAM, roles: [{ ...TEAM.roles[0], mustNot: "touch the build" }, TEAM.roles[1]] };
    const results = await Promise.allSettled([
      saveTeam(t.teamHome, t.project, TEAM, { create: true }),
      saveTeam(t.teamHome, t.project, other, { create: true }),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    assert.equal(won.length, 1);
    assert.equal(lost.length, 1);
    assert.ok(lost[0].reason instanceof TeamExistsError);
    const winner = results[0].status === "fulfilled" ? TEAM : other;
    const [team] = await listTeams(t.teamHome, t.project);
    assert.deepEqual(team.definition, winner);
    assert.equal(team.repoChanged, false);
  } finally {
    t.cleanup();
  }
});

adminTest("a save queued behind a refused create still runs", async (t) => {
  const edit = { ...TEAM, roles: [{ ...TEAM.roles[0], mustNot: "edit the tests" }, TEAM.roles[1]] };
  const results = await Promise.allSettled([
    saveTeam(t.teamHome, t.project, TEAM, { create: true }),
    saveTeam(t.teamHome, t.project, TEAM, { create: true }),
    saveTeam(t.teamHome, t.project, edit),
  ]);
  assert.deepEqual(results.map((r) => r.status), ["fulfilled", "rejected", "fulfilled"]);
  const [team] = await listTeams(t.teamHome, t.project);
  assert.deepEqual(team.definition, edit);
});

test("listTeams reports each assigned pane's hold when asked, and none otherwise", async () => {
  const { listTeams: list } = await import("../dist-electron/team-admin.js");
  const { teamProject } = await import("./helpers/team.mjs");
  const t = teamProject("aya-holds-", { teamFile: "# ux-review\n## Role: a\nMust not: x\n## Role: b\nMust not: y\n", tabs: [{ id: "p1" }, { id: "p2" }] });
  try {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(t.teamHome, "teams", "game", "ux-review");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "assignments.json"), JSON.stringify({ a: "p1", b: "p9" }));
    const asked = [];
    const [team] = await list(t.teamHome, t.project, async (pane) => (asked.push(pane), pane === "p1" ? "runs a shell" : null));
    assert.deepEqual(team.paneHolds, { a: "runs a shell" });
    assert.deepEqual(asked, ["p1"], "a pane whose tab is gone is not asked");
    const [plain] = await list(t.teamHome, t.project);
    assert.deepEqual(plain.paneHolds, {});
  } finally {
    t.cleanup();
  }
});

// The repo file of a running team was removed on purpose: the saved copy keeps running,
// so the window must list it (to pause it) and a closed tab must free its role.
async function runningSavedOnly(t) {
  await saveTeam(t.teamHome, t.project, TEAM);
  const store = new TeamStore(teamDir(t.teamHome, "game", "ux-review"));
  await store.assign("tester", "pane-t");
  await store.setPaused(false);
  rmSync(teamFile(t.project, "ux-review"));
  return store;
}

adminTest("a running team whose repo file is gone is listed, from its saved copy, and can be paused", async (t) => {
  const store = await runningSavedOnly(t);
  const [team] = await listTeams(t.teamHome, t.project);
  assert.equal(team.name, "ux-review");
  assert.equal(team.running, true);
  assert.equal(team.definition.roles.length, 2);
  assert.equal(team.repoDefinition, null);
  await store.setPaused(true);
  assert.equal((await listTeams(t.teamHome, t.project))[0].paused, true);
});

adminTest("closing a pane frees its role in a team whose repo file is gone", async (t) => {
  await runningSavedOnly(t);
  await releasePaneEverywhere(t.teamHome, t.project, "pane-t");
  assert.deepEqual((await listTeams(t.teamHome, t.project))[0].assignments, {});
});

test("listTeams reports the role-note report of each team, and none otherwise", async () => {
  const t = teamProject("aya-rolenotes-", { teamFile: "# ux-review\n## Role: a\nMust not: x\n## Role: b\nMust not: y\n", tabs: [{ id: "p1" }, { id: "p2" }] });
  try {
    const dir = join(t.teamHome, "teams", "game", "ux-review");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "assignments.json"), JSON.stringify({ a: "p1", b: "p9" }));
    const asked = [];
    const report = { roleNotes: { a: "x" }, staleNotes: ["p2 still carries the role note of b"] };
    const [team] = await listTeams(t.teamHome, t.project, undefined, async (project, name, assignments) => (asked.push([name, assignments]), report));
    assert.deepEqual([team.roleNotes, team.staleNotes], [report.roleNotes, report.staleNotes]);
    assert.deepEqual(asked, [["ux-review", { a: "p1", b: "p9" }]]);
    const [plain] = await listTeams(t.teamHome, t.project);
    assert.deepEqual([plain.roleNotes, plain.staleNotes], [{}, []]);
  } finally {
    t.cleanup();
  }
});

test("listTeams reports what Aya widened for each assigned pane, so the Teams window can say so", async () => {
  const { listTeams: list } = await import("../dist-electron/team-admin.js");
  const { launchNoteOf } = await import("../dist-electron/launch-mode.js");
  const { teamProject } = await import("./helpers/team.mjs");
  const t = teamProject("aya-notes-", { teamFile: "# ux-review\n## Role: a\nMust not: x\n## Role: b\nMust not: y\n", tabs: [{ id: "p1" }, { id: "p2" }] });
  try {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(t.teamHome, "teams", "game", "ux-review");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "assignments.json"), JSON.stringify({ a: "p1", b: "p2" }));
    const launches = {
      p1: { command: "codex", cwd: "/x", added: ["-c", "sandbox_workspace_write.network_access=true"] },
      p2: { command: "codex", cwd: "/x", added: [] },
    };
    const [team] = await list(t.teamHome, t.project, undefined, undefined, async (pane) => launchNoteOf(launches[pane]));
    assert.match(team.paneNotes.a, /every network host/);
    assert.equal(team.paneNotes.b, null);
    const [plain] = await list(t.teamHome, t.project);
    assert.deepEqual(plain.paneNotes, {});
  } finally {
    t.cleanup();
  }
});

adminTest("a team file that cannot be read and was never saved is not shown as gone from the repo", async (t) => {
  const { symlinkSync } = await import("node:fs");
  mkdirSync(teamsDir(t.project), { recursive: true });
  symlinkSync(join(t.project.directory, "nowhere.md"), teamFile(t.project, "ghost"));
  const [team] = await listTeams(t.teamHome, t.project);
  assert.deepEqual([team.name, team.repoGone, team.unsaved], ["ghost", false, false]);
});
