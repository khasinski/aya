// `aya team new|save` in main: the guide, and a save that goes through the
// Teams window's own Save team, scoped to the caller's project.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { envWithoutAya } from "./helpers/env.mjs";
import { teamProject } from "./helpers/team.mjs";

const cli = resolve("bin/aya");

const { handleTeamAuthorRequest } = await import("../dist-electron/team-author.js");
const { startControlServerOn } = await import("../dist-electron/control.js");
const { listTeams } = await import("../dist-electron/team-admin.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { serializeTeam, parseTeamFile } = await import("../dist-electron/teams.js");

const GOOD = `# ux-fix

## Role: reviewer
Sends to: fixer (findings with proof)
Must not: edit code
Plays the game and reports what confuses a player.

## Role: fixer
Sends to: reviewer (the commit to check)
Must not: leave a finding unanswered
Fixes findings.

## Cadence
reviewer every 30 min

## Protocol
Number rounds.
`;

function setup({ remote = false } = {}) {
  const t = teamProject("aya-author-", { tabs: [{ id: "pane-1" }] });
  const other = { slug: "site", name: "site", directory: join(t.root, "site"), tabs: [{ id: "pane-9" }] };
  mkdirSync(other.directory);
  const project = remote ? { ...t.project, remote: { host: "box" } } : t.project;
  const refreshed = [];
  const deps = { teamHome: t.teamHome, listProjects: async () => [project, other] };
  const run = (request, callerId = "pane-1") =>
    handleTeamAuthorRequest(request, callerId, deps, async (slug, name) => void refreshed.push(`${slug}/${name}`));
  const save = (text, extra = {}) => run({ type: "team-save", text, replace: false, ...extra });
  const repoFile = (name, dir = t.directory) => join(dir, ".aya", "teams", `${name}.md`);
  return { ...t, other, refreshed, run, save, repoFile };
}

test("a valid file is written, saved in Aya, and the running team refreshed", async () => {
  const t = setup();
  try {
    const { output } = await t.save(GOOD);
    const file = t.repoFile("ux-fix");
    assert.equal(readFileSync(file, "utf8"), serializeTeam(parseTeamFile("ux-fix", GOOD)));
    assert.equal(await new TeamStore(teamDir(t.teamHome, "game", "ux-fix")).savedDefinition(), readFileSync(file, "utf8"));
    const [team] = await listTeams(t.teamHome, t.project);
    assert.equal(team.unsaved, false);
    assert.equal(team.error, null);
    assert.deepEqual(t.refreshed, ["game/ux-fix"]);
    assert.equal(
      output,
      `saved team ux-fix: 2 roles (reviewer, fixer); reviewer -> fixer (findings with proof), fixer -> reviewer (the commit to check)\n` +
        `written to ${file}; saved in Aya, so its roles can be given panes and started from the Teams window\n`,
    );
  } finally {
    t.cleanup();
  }
});

test("a role that sends nothing shows as sending to nobody", async () => {
  const t = setup();
  try {
    const { output } = await t.save("# pair\n## Role: a\nSends to: b\nMust not: x\n## Role: b\nMust not: y\n");
    assert.match(output, /^saved team pair: 2 roles \(a, b\); a -> b, b -> nobody\n/);
  } finally {
    t.cleanup();
  }
});

const BROKEN = [
  ["no title", GOOD.replace("# ux-fix\n", ""), 'the team file must start with "# <team-name>"'],
  ["a title with spaces", GOOD.replace("# ux-fix", "# UX Fix"), 'team "UX Fix": the file name must be lowercase letters, digits and dashes'],
  ["one role", "# solo\n## Role: a\nMust not: x\n", 'team "solo": a team needs at least 2 roles'],
  ["a bad role id", GOOD.replace("Role: fixer", "Role: Fixer"), 'team "ux-fix": role "Fixer" must be lowercase letters, digits and dashes'],
  ["a role named aya", GOOD.replaceAll("fixer", "aya"), `team "ux-fix": "aya" is reserved for Aya's own messages; name the role something else`],
  ["a role named user", GOOD.replaceAll("fixer", "user"), `team "ux-fix": "user" is reserved for the user's own messages; name the role something else`],
  ["no must-not", GOOD.replace("Must not: edit code\n", ""), 'team "ux-fix": role "reviewer" needs a "Must not:" line'],
  ["a route to an unknown role", GOOD.replace("Sends to: fixer", "Sends to: tester"), 'team "ux-fix": role "reviewer" sends to unknown role "tester"'],
  ["a route to itself", GOOD.replace("Sends to: fixer", "Sends to: reviewer"), 'team "ux-fix": role "reviewer" sends to itself'],
  ["a route listed twice", GOOD.replace("Sends to: fixer (findings with proof)", "Sends to: fixer (a), fixer (b)"), 'team "ux-fix": role "reviewer" lists "fixer" twice in "Sends to:"'],
  ["a what in nested parentheses", GOOD.replace("(findings with proof)", "(findings (proof))"), 'team "ux-fix": role "reviewer": unbalanced parentheses in "Sends to:"'],
  ["a cadence of 0", GOOD.replace("every 30 min", "every 0 min"), 'team "ux-fix": cadence must read "<role> every <1-1440> min"'],
  ["a cadence past a day", GOOD.replace("every 30 min", "every 1441 min"), 'team "ux-fix": cadence must read "<role> every <1-1440> min"'],
  ["a cadence for an unknown role", GOOD.replace("reviewer every", "tester every"), 'team "ux-fix": cadence names unknown role "tester"'],
  ["an unknown section", `${GOOD}\n## Notes\nhi\n`, 'team "ux-fix": unknown section "## Notes"'],
  ["a role defined twice", GOOD.replace("Role: fixer", "Role: reviewer"), 'team "ux-fix": role "reviewer" is defined twice'],
];

for (const [what, text, problem] of BROKEN) {
  test(`${what}: refused with the exact problem, nothing saved`, async () => {
    const t = setup();
    try {
      await assert.rejects(t.save(text), (err) => {
        assert.equal(err.message, problem);
        return true;
      });
      assert.equal(existsSync(join(t.directory, ".aya")), false);
      assert.equal(existsSync(join(t.teamHome, "teams")), false);
      assert.deepEqual(t.refreshed, []);
    } finally {
      t.cleanup();
    }
  });
}

test("an existing team is refused without --replace and left as it was", async () => {
  const t = setup();
  try {
    await t.save(GOOD);
    const before = readFileSync(t.repoFile("ux-fix"), "utf8");
    const changed = GOOD.replace("Must not: edit code", "Must not: touch the save files");
    await assert.rejects(t.save(changed), {
      message: `team "ux-fix" already exists in ${t.repoFile("ux-fix")}; nothing was saved. Run aya team save again with --replace to overwrite it`,
    });
    assert.equal(readFileSync(t.repoFile("ux-fix"), "utf8"), before);
    assert.equal(await new TeamStore(teamDir(t.teamHome, "game", "ux-fix")).savedDefinition(), before);
    await t.save(changed, { replace: true });
    const [team] = await listTeams(t.teamHome, t.project);
    assert.equal(team.definition.roles[0].mustNot, "touch the save files");
    assert.equal(team.repoChanged, false);
  } finally {
    t.cleanup();
  }
});

test("an unsaved repo file of the same name also needs --replace", async () => {
  const t = setup();
  try {
    mkdirSync(join(t.directory, ".aya", "teams"), { recursive: true });
    writeFileSync(t.repoFile("ux-fix"), GOOD);
    await assert.rejects(t.save(GOOD), /already exists/);
    await t.save(GOOD, { replace: true });
    const [team] = await listTeams(t.teamHome, t.project);
    assert.equal(team.unsaved, false);
  } finally {
    t.cleanup();
  }
});

test("--replace drops a removed role's pane, as Save team does", async () => {
  const t = setup();
  try {
    await t.save(GOOD);
    const store = new TeamStore(teamDir(t.teamHome, "game", "ux-fix"));
    await store.assign("fixer", "pane-1");
    await t.save(GOOD.replaceAll("fixer", "builder"), { replace: true });
    assert.deepEqual(await store.assignments(), {});
  } finally {
    t.cleanup();
  }
});

test("the calling pane's project wins over the slug and the cwd", async () => {
  const t = setup();
  try {
    await t.save(GOOD, { projectSlug: "site", cwd: t.other.directory });
    assert.ok(existsSync(t.repoFile("ux-fix")));
    assert.equal(existsSync(t.repoFile("ux-fix", t.other.directory)), false);
  } finally {
    t.cleanup();
  }
});

test("outside a pane: the slug, else the project the cwd is in", async () => {
  const t = setup();
  try {
    await t.run({ type: "team-save", text: GOOD, replace: false, projectSlug: "site" }, null);
    assert.ok(existsSync(t.repoFile("ux-fix", t.other.directory)));
    const sub = join(t.directory, "src", "ui");
    mkdirSync(sub, { recursive: true });
    await t.run({ type: "team-save", text: GOOD, replace: false, cwd: realpathSync(sub) }, null);
    assert.ok(existsSync(t.repoFile("ux-fix")));
    assert.deepEqual(t.refreshed, ["site/ux-fix", "game/ux-fix"]);
  } finally {
    t.cleanup();
  }
});

test("the cwd matches through symlinks, at the project root too, and the innermost project wins", async () => {
  const t = setup();
  try {
    const engine = { slug: "engine", name: "engine", directory: join(t.directory, "engine"), tabs: [] };
    mkdirSync(join(engine.directory, "src"), { recursive: true });
    const deps = { teamHome: t.teamHome, listProjects: async () => [t.project, engine] };
    const save = (cwd) => handleTeamAuthorRequest({ type: "team-save", text: GOOD, replace: true, cwd }, null, deps, async () => {});
    await save(join(engine.directory, "src"));
    assert.ok(existsSync(t.repoFile("ux-fix", engine.directory)));
    assert.equal(existsSync(t.repoFile("ux-fix")), false);
    await save(realpathSync(t.directory));
    assert.ok(existsSync(t.repoFile("ux-fix")));
  } finally {
    t.cleanup();
  }
});

test("a title with trailing spaces names the team without them", async () => {
  const t = setup();
  try {
    assert.match((await t.save(GOOD.replace("# ux-fix\n", "# ux-fix  \n"))).output, /^saved team ux-fix: /);
  } finally {
    t.cleanup();
  }
});

test("a write that fails is reported as itself, not as an existing team", async () => {
  const t = setup();
  try {
    writeFileSync(join(t.directory, ".aya"), "a file where the directory would go");
    await assert.rejects(t.save(GOOD), (err) => {
      assert.doesNotMatch(err.message, /already exists/);
      assert.match(err.message, /ENOTDIR|EEXIST/);
      return true;
    });
  } finally {
    t.cleanup();
  }
});

test("a control server without teams says so", async () => {
  const t = setup();
  const socket = join(t.root, "aya.sock");
  const stop = startControlServerOn(socket, { getWindow: () => null, openProject: () => {} });
  try {
    const result = await new Promise((done) => {
      const child = spawn(cli, ["team", "new"], { env: { ...envWithoutAya(), AYA_SOCKET: socket } });
      let stderr = "";
      child.stderr.on("data", (x) => (stderr += x));
      child.on("close", (status) => done({ status, stderr }));
    });
    assert.deepEqual(result, { status: 1, stderr: "aya: teams are not available\n" });
  } finally {
    stop();
    t.cleanup();
  }
});

test("a pane of no open project, an unknown slug or a cwd outside every project saves nothing", async () => {
  const t = setup();
  try {
    const nowhere = "run aya team save in an Aya pane, or in the directory of a project open in Aya; nothing was saved";
    const sibling = `${t.directory}-other`;
    mkdirSync(sibling);
    for (const scope of [{}, { projectSlug: "nope" }, { cwd: t.root }, { cwd: sibling }, { cwd: realpathSync(sibling) }]) {
      await assert.rejects(t.run({ type: "team-save", text: GOOD, replace: false, ...scope }, "pane-gone"), { message: nowhere });
    }
    assert.equal(existsSync(join(t.directory, ".aya")), false);
  } finally {
    t.cleanup();
  }
});

test("a remote project is refused: its files are on another machine", async () => {
  const t = setup({ remote: true });
  try {
    await assert.rejects(t.save(GOOD), { message: "teams work only on local projects; nothing was saved" });
    assert.equal(existsSync(join(t.directory, ".aya")), false);
  } finally {
    t.cleanup();
  }
});

test("the guide echoes the request and names the project's teams", async () => {
  const t = setup();
  try {
    await t.save(GOOD);
    const { output } = await t.run({ type: "team-guide", description: "a team that fixes UX" });
    assert.match(output, /^The user asked for: a team that fixes UX\n/);
    assert.match(output, /Teams this project already has: ux-fix\./);
    const bare = (await t.run({ type: "team-guide" }, "pane-gone")).output;
    assert.doesNotMatch(bare, /The user asked for/);
    assert.doesNotMatch(bare, /already has/);
  } finally {
    t.cleanup();
  }
});

test("through the real CLI and control server: saved, summarized, the runner told", async () => {
  const t = setup();
  const socket = join(t.root, "aya.sock");
  const refreshed = [];
  const stop = startControlServerOn(socket, {
    getWindow: () => null,
    openProject: () => {},
    team: {
      teamHome: t.teamHome,
      listProjects: async () => [t.project],
      deliver: async () => {},
      headCommit: async () => null,
      holdReason: async () => null,
    },
    teamRunner: { refresh: async (slug, name) => void refreshed.push(`${slug}/${name}`) },
  });
  const aya = (...args) =>
    new Promise((done) => {
      const child = spawn(cli, ["team", ...args], { env: { ...envWithoutAya(), AYA_SOCKET: socket, AYA_TERMINAL_ID: "pane-1" } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (x) => (stdout += x));
      child.stderr.on("data", (x) => (stderr += x));
      child.on("close", (status) => done({ status, stdout, stderr }));
    });
  try {
    const draft = join(t.root, "draft.md");
    writeFileSync(draft, GOOD);
    const saved = await aya("save", draft);
    assert.equal(saved.status, 0, saved.stderr);
    assert.match(saved.stdout, /^saved team ux-fix: 2 roles \(reviewer, fixer\)/);
    assert.deepEqual(refreshed, ["game/ux-fix"]);
    const again = await aya("save", draft);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /^aya: team "ux-fix" already exists in .*; nothing was saved\. Run aya team save again with --replace to overwrite it\n$/);
    assert.equal((await aya("save", draft, "--replace")).status, 0);
    const guide = await aya("new", "fix", "the", "UX");
    assert.equal(guide.status, 0);
    assert.match(guide.stdout, /^The user asked for: fix the UX\n[\s\S]*Teams this project already has: ux-fix\./);
  } finally {
    stop();
    t.cleanup();
  }
});

test("a team saved from a pane is marked as the agent's, so the window does not ask to assign it too; one saved outside a pane is not", async () => {
  const t = setup();
  try {
    await t.save(GOOD);
    await t.run({ type: "team-save", text: GOOD.replace("# ux-fix", "# other"), replace: false, projectSlug: "game" }, null);
    const byName = Object.fromEntries((await listTeams(t.teamHome, t.project)).map((team) => [team.name, team]));
    assert.equal(byName["ux-fix"].agentAuthored, true);
    assert.equal(byName.other.agentAuthored, false);
  } finally {
    t.cleanup();
  }
});

test("the agent's mark goes with the first role given a pane, or a save from the window", async () => {
  const { assignRole, saveTeam } = await import("../dist-electron/team-admin.js");
  const t = setup();
  const authored = async (name) => (await listTeams(t.teamHome, t.project)).find((team) => team.name === name).agentAuthored;
  try {
    await t.save(GOOD);
    await t.save(GOOD.replace("# ux-fix", "# other"));
    assert.equal(await authored("ux-fix"), true);
    await assignRole(t.teamHome, t.project, "ux-fix", "reviewer", "pane-1");
    assert.equal(await authored("ux-fix"), false);
    // Its panes closing later leaves a team the window offers to assign again.
    assert.equal(await authored("other"), true);
    await saveTeam(t.teamHome, t.project, parseTeamFile("other", GOOD.replace("# ux-fix", "# other")));
    assert.equal(await authored("other"), false);
    // aya team save --replace from a pane marks it again.
    await t.save(GOOD.replace("# ux-fix", "# other"), { replace: true });
    assert.equal(await authored("other"), true);
  } finally {
    t.cleanup();
  }
});
