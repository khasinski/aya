// `cd <dir> &&` in front of an agent's program (a preset has no cwd field) runs it in another directory: Aya reads its
// flags and that directory's config as for the bare program. Anything else (env, npx, sh -c, ssh, ...) is unknown.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CD_LEAD_SPELLINGS } from "./helpers/wrapped-spellings.mjs";
import { cantReach, launchMode, launchNoteOf, teamLaunch, withLaunchArgs } from "../dist-electron/launch-mode.js";
import { withNoDaemon } from "../dist-electron/codex-daemon.js";
import { paneLaunchMode, roleLaunchCheck } from "../dist-electron/launch-config.js";

const SOCK = "/Users/me/.aya/aya.sock";
const SANDBOXED = JSON.stringify({ sandbox: { enabled: true } });
const config = (over = {}) => ({ codex: [], codexProfile: null, codexProject: [], codexTrusted: true, opencode: [], opencodeContent: null, claude: [], socket: SOCK, ...over });

// launchMode recurses on what follows the cd, so each lead is one parse: every lead spelling once, and one
// lead before each kind of program (the bare programs' verdicts are launch-mode.test's MODES).
const CLAUDE_SANDBOXED = ["claude", { claude: [SANDBOXED] }];
const CODEX = ["codex --no-daemon", {}];
const LEADS = ["cd sub && ", "cd 'a b' && ", 'cd "a b" && ', "cd ~/proj && ", "cd /abs/x && cd y && ", "  cd sub&&"];
const CELLS = [
  ...LEADS.map((lead, i) => [lead, ...(i % 2 ? CODEX : CLAUDE_SANDBOXED)]),
  ...[CODEX, CLAUDE_SANDBOXED, ["FOO=1 claude", {}], ["exec codex --no-daemon", {}], ["codex exec hi", {}], ["aider", {}]].map((bare) => ["cd sub && ", ...bare]),
];

for (const [lead, bare, over] of CELLS) {
  const label = `${JSON.stringify(lead)} x ${bare}${Object.keys(over).length ? " (sandbox on)" : ""}`;
  test(`a cd in front is the bare program's verdict | ${label}`, () => {
    assert.deepEqual(launchMode(lead + bare, config(over)), launchMode(bare, config(over)));
  });
  test(`a cd in front: a role's pane gets the bare program's flags, after the program | ${label}`, () => {
    const viaCd = teamLaunch(lead + bare, config(over));
    assert.deepEqual(viaCd, teamLaunch(bare, config(over)));
    if ("args" in viaCd) assert.equal(withLaunchArgs(lead + bare, viaCd.args), lead + withLaunchArgs(bare, viaCd.args));
  });
}

test("a cd in front of codex gets --no-daemon like the bare program", () => {
  for (const lead of LEADS) {
    for (const bare of ["codex", "codex resume abc", "FOO=1 codex", "exec codex"]) {
      assert.equal(withNoDaemon(lead + bare), lead + withNoDaemon(bare), lead + bare);
    }
    assert.equal(withNoDaemon(`${lead}codex exec hi`), `${lead}codex exec hi`, "a non-interactive subcommand is left alone");
  }
});

test("every recorded cd spelling reads as its bare program", () => {
  for (const command of CD_LEAD_SPELLINGS) {
    const bare = command.replace(/^(?:\s*cd\s+(?:'[^']*'|"[^"]*"|\S+?)\s*&&\s*)+/, "");
    assert.deepEqual(launchMode(command, config()), launchMode(bare, config()), command);
  }
});

// A wrapper after the cd, a cd Aya cannot follow, or a cd not chained with &&: unknown, noted, never held.
const NOT_FOLLOWED = [
  "cd sub && env codex", "cd sub && npx claude", "cd sub && sh -c 'codex'", "cd sub && ssh host codex", "cd sub && nice codex",
  "cd sub && sudo claude", "cd sub && bash -lc 'claude'", "cd sub; codex", "cd sub || codex", "cd $DIR && codex",
  "cd \"$HOME/x\" && claude", "cd `pwd` && claude", "cd $(pwd) && claude", "cd sub && true & codex", "cd sub && codex; echo done",
  "cd && claude", "cd - && claude", "cd -P sub && claude", "cd sub && make test", "cd ~/src/codex && cargo run", "cd sub && aider",
];
for (const command of NOT_FOLLOWED) {
  test(`behind a cd Aya does not follow: noted, never held | ${command}`, () => {
    const mode = launchMode(command, config());
    assert.equal(cantReach(mode), null);
    assert.match(launchNoteOf({ command, cwd: "/p", mode }) ?? "", /^may not reach Aya: /);
  });
}

// On disk: the config files are the ones of the directory the cd goes to.
function world() {
  const root = mkdtempSync(join(tmpdir(), "aya-cd-lead-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "web", ".claude"), { recursive: true });
  mkdirSync(join(repo, "web", ".codex"), { recursive: true });
  return { root, home, repo, env: { HOME: home }, socket: join(root, "aya.sock"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("on disk: cd into a folder whose Claude settings turn the sandbox on is the verdict of claude run there", async () => {
  const w = world();
  try {
    writeFileSync(join(w.repo, "web", ".claude", "settings.json"), SANDBOXED);
    const there = await paneLaunchMode("claude", join(w.repo, "web"), w.env, w.socket);
    assert.equal(there.reach, "blocked", "the folder's settings decide for claude run in it");
    for (const command of ["cd web && claude", `cd ${join(w.repo, "web")} && claude`, "cd ./web && claude"]) {
      assert.deepEqual(await paneLaunchMode(command, w.repo, w.env, w.socket), there, command);
    }
    assert.equal((await paneLaunchMode("claude", w.repo, w.env, w.socket)).reach, "reaches", "the pane's own folder has no such settings");
  } finally {
    w.cleanup();
  }
});

test("on disk: cd ~/x reads the folder under the pane's HOME; the codex project config of the cd's folder counts", async () => {
  const w = world();
  try {
    mkdirSync(join(w.home, "x", ".git"), { recursive: true });
    mkdirSync(join(w.home, "x", ".codex"));
    writeFileSync(join(w.home, "x", ".codex", "config.toml"), 'sandbox_mode = "read-only"\n');
    writeFileSync(join(w.home, ".codex", "config.toml"), `[projects."${join(w.home, "x")}"]\ntrust_level = "trusted"\n`);
    const mode = await paneLaunchMode("cd ~/x && codex --no-daemon", w.repo, w.env, w.socket);
    assert.deepEqual([mode.mode, mode.reach], ["sandbox read-only", "blocked"]);
    const role = await roleLaunchCheck("cd ~/x && codex", w.repo, w.env, w.socket, "/bin/sh");
    assert.equal(role.reach, "blocked", "a role's pane is refused like codex started in ~/x");
  } finally {
    w.cleanup();
  }
});

// `untrusted` asks before every command not on Codex's read-only list, so each aya call waits for the user;
// a sandbox or approval policy the preset picks is its own: only full access with -a never cannot stop.
const UNTRUSTED = /approval policy untrusted.*each aya call .*waits for you to approve it/;
const PRESET = /as the preset sets them.*may stop for approvals on git and aya/;
const APPROVAL = [
  ["codex --no-daemon -s danger-full-access -a untrusted", {}, UNTRUSTED],
  ["codex --no-daemon -s danger-full-access --ask-for-approval untrusted", {}, UNTRUSTED],
  ["codex --no-daemon -s danger-full-access --ask-for-approval=untrusted", {}, UNTRUSTED],
  ["codex --no-daemon -s danger-full-access -c approval_policy=untrusted", {}, UNTRUSTED],
  ["codex --no-daemon -s danger-full-access", { codex: ['approval_policy = "untrusted"'] }, UNTRUSTED],
  ["codex --no-daemon -s danger-full-access -a on-request", { codex: ['approval_policy = "untrusted"'] }, PRESET],
  ["codex --no-daemon -s danger-full-access -a never", {}, null],
  ["codex --no-daemon -s danger-full-access -a on-request", {}, PRESET],
  ["codex --no-daemon -s danger-full-access", {}, PRESET],
  ["codex --no-daemon --dangerously-bypass-approvals-and-sandbox -a untrusted", {}, null],
  ["cd sub && codex --no-daemon -s danger-full-access -a untrusted", {}, UNTRUSTED],
];
for (const [command, over, expected] of APPROVAL) {
  test(`codex approval policy | ${command}${over.codex ? " (config.toml untrusted)" : ""} -> ${expected ? expected.source.slice(0, 24) : "no note"}`, () => {
    const mode = launchMode(command, config(over));
    assert.equal(mode.reach, "reaches", "the socket is reached once the user approves");
    assert.equal(cantReach(mode), null, "not held up front: messages still go in");
    const note = launchNoteOf({ command, cwd: "/p", added: [], mode });
    if (expected) assert.match(note ?? "", expected);
    else assert.equal(note, null);
  });
}
