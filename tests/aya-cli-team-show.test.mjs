// `aya team show` through the real CLI and the real control server: caller (role pane, roleless
// pane, terminal with the slug, nowhere) x team named or not x repo file (same, differs, gone, only).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { envWithoutAya } from "./helpers/env.mjs";
import { teamProject } from "./helpers/team.mjs";

const { startControlServerOn } = await import("../dist-electron/control.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");

const cli = resolve("bin/aya");
const TEAM = `# ux-review

## Role: tester
Sends to: implementer (findings with proof)
Must not: edit code
Plays the build each round.
Writes down what a player sees.

## Role: implementer
Sends to: tester (the commit to check)
Must not: skip a report
Fixes findings.

## Role: designer
Must not: write code
Draws screens.

## Lead
tester

## Cadence
tester every 30 min

## Protocol
Number the rounds.

## Status command
git log --oneline -1
`;
// The repo file as an agent left it after the save: what runs is still TEAM.
const REPO_EDIT = TEAM.replace("Fixes findings.", "Fixes findings and writes the prompts.");
const OTHER = "# docs\n\n## Role: writer\nMust not: guess\nWrites.\n\n## Role: editor\nMust not: rewrite\nEdits.\n\n## Lead\nwriter\n";

async function setup({ repo = "same", secondTeam = false } = {}) {
  const tabs = [{ id: "pane-t" }, { id: "pane-i" }, { id: "pane-x" }];
  const t = teamProject("aya-team-show-", { teamFile: TEAM, tabs, saved: repo !== "only" });
  const repoFile = join(t.directory, ".aya", "teams", "ux-review.md");
  if (repo === "differs") writeFileSync(repoFile, REPO_EDIT);
  if (repo === "missing") rmSync(repoFile);
  if (secondTeam) {
    mkdirSync(join(t.teamHome, "teams", "game", "docs"), { recursive: true });
    writeFileSync(join(t.teamHome, "teams", "game", "docs", "saved.md"), OTHER);
  }
  const store = new TeamStore(teamDir(t.teamHome, "game", "ux-review"));
  if (repo !== "only") await store.assign("tester", "pane-t");
  const listProjects = async () => [t.project];
  const socket = join(t.root, "aya.sock");
  const stop = startControlServerOn(socket, {
    getWindow: () => null,
    openProject: () => {},
    listProjects,
    team: { teamHome: t.teamHome, listProjects, deliver: async () => null, headCommit: async () => null, holdReason: async () => null },
  });
  const aya = (env, ...args) =>
    new Promise((done, fail) => {
      // cwd outside the project: only the pane id or the slug may name it.
      const child = spawn("/bin/sh", [cli, "team", "show", ...args], { cwd: t.root, env: { ...envWithoutAya(), AYA_SOCKET: socket, ...env } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stderr += c));
      child.on("error", fail);
      child.on("close", (status) => done({ status, stdout, stderr }));
    });
  return { aya, cleanup: () => (stop(), t.cleanup()) };
}

const IN_ROLE_PANE = { AYA_TERMINAL_ID: "pane-t" };
const IN_ROLELESS_PANE = { AYA_TERMINAL_ID: "pane-x" };
const TERMINAL_WITH_SLUG = { AYA_PROJECT_SLUG: "game" };
const NOWHERE = {};

/** Every role, its fields, the lead, cadence, protocol and status command of the SAVED team. */
function assertWholeTeam(stdout) {
  for (const re of [
    /^team\s+ux-review$/m,
    /^lead\s+tester$/m,
    /^cadence\s+tester every 30 min$/m,
    /^status\s+git log --oneline -1\b/m,
    /^role tester \(lead/m,
    /^ {2}sends to\s+implementer: findings with proof$/m,
    /^ {2}must not\s+edit code$/m,
    /^ {2}Plays the build each round\.\n {2}Writes down what a player sees\.$/m,
    /^role implementer$/m,
    /^ {2}sends to\s+tester: the commit to check$/m,
    /^ {2}must not\s+skip a report$/m,
    /^ {2}Fixes findings\.$/m,
    /^role designer$/m,
    /^ {2}sends to\s+\(nobody\)$/m,
    /^ {2}must not\s+write code$/m,
    /^ {2}Draws screens\.$/m,
    /^protocol\nNumber the rounds\.$/m,
  ]) {
    assert.match(stdout, re);
  }
}

const CASES = [
  { name: "a role's pane, no team named: its team, marked you", env: IN_ROLE_PANE, args: [], ok: true, you: "tester" },
  { name: "a role's pane names its team", env: IN_ROLE_PANE, args: ["ux-review"], ok: true, you: "tester" },
  { name: "a roleless pane of the project: the only saved team, no you", env: IN_ROLELESS_PANE, args: [], ok: true, you: null },
  { name: "a terminal with the slug names the team", env: TERMINAL_WITH_SLUG, args: ["ux-review"], ok: true, you: null },
  { name: "a terminal with the slug, no team named: the only one", env: TERMINAL_WITH_SLUG, args: [], ok: true, you: null },
  { name: "a terminal with no slug, outside the project", env: NOWHERE, args: [], ok: false, error: /run aya team show in an Aya pane, or with AYA_PROJECT_SLUG/ },
  { name: "an unknown team, from a pane", env: IN_ROLE_PANE, args: ["nope"], ok: false, error: /no team nope in project game; its teams: ux-review/ },
  { name: "an unknown team, from a terminal", env: TERMINAL_WITH_SLUG, args: ["nope"], ok: false, error: /no team nope in project game/ },
  { name: "a name that cannot be a team", env: TERMINAL_WITH_SLUG, args: ["Bad_Name"], ok: false, error: /"Bad_Name" is not a team name/ },
  { name: "repo file differs: the saved team, and it says so", env: IN_ROLE_PANE, args: [], repo: "differs", ok: true, you: "tester", note: /the repo file \.aya\/teams\/ux-review\.md differs from this saved team/ },
  { name: "repo file differs, from a terminal", env: TERMINAL_WITH_SLUG, args: ["ux-review"], repo: "differs", ok: true, you: null, note: /differs from this saved team/ },
  { name: "repo file gone: the saved team runs", env: TERMINAL_WITH_SLUG, args: [], repo: "missing", ok: true, you: null, note: /the repo file \.aya\/teams\/ux-review\.md is gone/ },
  { name: "repo file only, never saved", env: TERMINAL_WITH_SLUG, args: ["ux-review"], repo: "only", ok: false, error: /team ux-review is not saved in Aya yet/ },
  { name: "two teams, none named, outside a role", env: TERMINAL_WITH_SLUG, args: [], secondTeam: true, ok: false, error: /name the team: aya team show <team> \(project game has docs, ux-review\)/ },
  { name: "two teams, none named, from a role's pane: its own", env: IN_ROLE_PANE, args: [], secondTeam: true, ok: true, you: "tester" },
];

for (const c of CASES) {
  test(`team show: ${c.name}`, async () => {
    const t = await setup({ repo: c.repo, secondTeam: c.secondTeam });
    try {
      const { status, stdout, stderr } = await t.aya(c.env, ...c.args);
      if (!c.ok) {
        assert.equal(status, 1, stdout);
        assert.match(stderr, c.error);
        return;
      }
      assert.equal(status, 0, stderr);
      assertWholeTeam(stdout);
      assert.doesNotMatch(stdout, /writes the prompts/, "the repo edit is not what runs");
      if (c.you) {
        assert.match(stdout, new RegExp(`^you\\s+${c.you}$`, "m"));
        assert.match(stdout, /^role tester \(lead, you\)$/m);
      } else {
        assert.doesNotMatch(stdout, /^you\s/m);
        assert.match(stdout, /^role tester \(lead\)$/m);
      }
      if (c.note) assert.match(stdout, c.note);
      else assert.doesNotMatch(stdout, /the repo file/);
    } finally {
      t.cleanup();
    }
  });
}

test("team show --json: the same team as data, repo state included", async () => {
  for (const [repo, repoFile] of [["same", "same"], ["differs", "differs"], ["missing", "missing"]]) {
    const t = await setup({ repo });
    try {
      for (const args of [["--json"], ["ux-review", "--json"], ["--json", "ux-review"]]) {
        const { status, stdout, stderr } = await t.aya(IN_ROLE_PANE, ...args);
        assert.equal(status, 0, stderr);
        assert.deepEqual(JSON.parse(stdout), {
          team: "ux-review",
          project: "game",
          you: "tester",
          lead: "tester",
          cadenceMinutes: 30,
          statusCommand: "git log --oneline -1",
          protocol: "Number the rounds.",
          repoFile,
          roles: [
            { id: "tester", lead: true, sendsTo: [{ to: "implementer", what: "findings with proof" }], mustNot: "edit code", responsibilities: "Plays the build each round.\nWrites down what a player sees." },
            { id: "implementer", lead: false, sendsTo: [{ to: "tester", what: "the commit to check" }], mustNot: "skip a report", responsibilities: "Fixes findings." },
            { id: "designer", lead: false, sendsTo: [], mustNot: "write code", responsibilities: "Draws screens." },
          ],
        }, `${repo} ${args.join(" ")}`);
      }
    } finally {
      t.cleanup();
    }
  }
});

test("team show refuses extra words and unknown flags before Aya hears of it", async () => {
  const t = await setup();
  try {
    for (const args of [["a", "b"], ["--yaml"], ["-f"]]) {
      const { status, stderr } = await t.aya(TERMINAL_WITH_SLUG, ...args);
      assert.equal(status, 1, args.join(" "));
      assert.match(stderr, /Usage/, args.join(" "));
    }
  } finally {
    t.cleanup();
  }
});
