// The files a pane's launch mode is read from, on disk: the repository's
// config reaches a pane started in a subdirectory, the user's config the rest.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { paneLaunchMode, readLaunchConfig, roleLaunchCheck } from "../dist-electron/launch-config.js";

const RO = 'sandbox_mode = "read-only"';

/** A home and a repo under a temp root, removed after test `t`. */
function world(t) {
  const root = mkdtempSync(join(tmpdir(), "aya-launch-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "app"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, home, repo, env: { HOME: home }, socket: join(root, "aya.sock") };
}

/** A git repo at <root>/main with a worktree at <root>/tree. */
function worktree(w) {
  const main = join(w.root, "main");
  const tree = join(w.root, "tree");
  const git = (...args) => execFileSync("git", ["-C", main, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { env: { ...process.env, HOME: w.home }, stdio: "pipe" });
  mkdirSync(main);
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "x");
  git("worktree", "add", "-q", tree);
  return { main, tree };
}

test("a repository's .codex/config.toml decides for a pane in its subdirectory, over the user's", async (t) => {
  const w = world(t);
  writeFileSync(join(w.home, ".codex", "config.toml"), `sandbox_mode = "read-only"\n[projects."${w.repo}"]\ntrust_level = "trusted"\n`);
  mkdirSync(join(w.repo, ".codex"));
  writeFileSync(join(w.repo, ".codex", "config.toml"), 'sandbox_mode = "danger-full-access"\n');
  const mode = await paneLaunchMode("codex --no-daemon", join(w.repo, "app"), w.env, w.socket);
  assert.deepEqual([mode.mode, mode.reach], ["sandbox danger-full-access", "reaches"]);
});

test("a project's .codex/config.toml counts only once the user's config trusts the project", async (t) => {
  const w = world(t);
  mkdirSync(join(w.repo, ".codex"));
  writeFileSync(join(w.repo, ".codex", "config.toml"), 'sandbox_mode = "danger-full-access"\n');
  const socket = w.socket;
  const cwd = join(w.repo, "app");
  const before = await paneLaunchMode("codex --no-daemon", cwd, w.env, socket);
  assert.deepEqual([before.mode, before.reach], ["untrusted project config", "unknown"]);
  writeFileSync(join(w.home, ".codex", "config.toml"), `[projects."${realpathSync(w.repo)}"]\ntrust_level = "untrusted"\n`);
  assert.equal((await paneLaunchMode("codex --no-daemon", cwd, w.env, socket)).reach, "unknown");
  writeFileSync(join(w.home, ".codex", "config.toml"), `[projects."${realpathSync(w.repo)}"]\ntrust_level = "trusted"\n`);
  const after = await paneLaunchMode("codex --no-daemon", cwd, w.env, socket);
  assert.deepEqual([after.mode, after.reach], ["sandbox danger-full-access", "reaches"]);
  writeFileSync(join(w.home, ".codex", "config.toml"), `[projects."${cwd}"]\ntrust_level = "trusted"\n`);
  assert.equal((await paneLaunchMode("codex --no-daemon", cwd, w.env, socket)).reach, "reaches", "trusting the pane's directory counts");
  writeFileSync(join(w.home, ".codex", "config.toml"), `projects = { "${w.repo}" = { trust_level = "trusted" } }\n`);
  assert.equal((await paneLaunchMode("codex --no-daemon", cwd, w.env, socket)).reach, "reaches", "an inline table trusts too");
});

test("a profile file is the profile's even when config.toml is missing, and its [profiles.<name>] is not legacy", async (t) => {
  const w = world(t);
  const socket = w.socket;
  writeFileSync(join(w.home, ".codex", "team.config.toml"), 'sandbox_mode = "danger-full-access"\n[profiles.team]\nmodel = "x"\n');
  const mode = await paneLaunchMode("codex --no-daemon -p team", w.repo, w.env, socket);
  assert.deepEqual([mode.mode, mode.reach], ["sandbox danger-full-access", "reaches"]);
  writeFileSync(join(w.home, ".codex", "config.toml"), '[profiles.team]\nmodel = "x"\n');
  assert.equal((await paneLaunchMode("codex --no-daemon -p team", w.repo, w.env, socket)).mode, "legacy profile setting");
});

test("a git worktree is trusted through the main repository, as Codex resolves it", async (t) => {
  const w = world(t);
  const { main, tree } = worktree(w);
  mkdirSync(join(tree, ".codex"));
  writeFileSync(join(tree, ".codex", "config.toml"), `${RO}\n`);
  const socket = w.socket;
  const trust = (dir) => writeFileSync(join(w.home, ".codex", "config.toml"), `[projects."${realpathSync(dir)}"]\ntrust_level = "trusted"\n`);
  const launch = () => paneLaunchMode("codex --no-daemon", tree, w.env, socket);
  assert.equal((await launch()).reach, "unknown", "nobody trusts anything");
  trust(main);
  assert.deepEqual([(await launch()).mode, (await launch()).reach], ["sandbox read-only", "blocked"]);
  trust(tree);
  assert.equal((await launch()).reach, "blocked", "the worktree's own path counts too");
});

test("a worktree's .git file may point at its admin dir relatively (worktree.useRelativePaths)", async (t) => {
  const w = world(t);
  const { main, tree } = worktree(w);
  const admin = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(tree, ".git"), "utf-8"))[1].trim();
  writeFileSync(join(tree, ".git"), `gitdir: ${relative(tree, admin)}\n`);
  mkdirSync(join(tree, ".codex"));
  writeFileSync(join(tree, ".codex", "config.toml"), `${RO}\n`);
  writeFileSync(join(w.home, ".codex", "config.toml"), `[projects."${realpathSync(main)}"]\ntrust_level = "trusted"\n`);
  assert.equal((await paneLaunchMode("codex --no-daemon", tree, w.env, w.socket)).mode, "sandbox read-only");
});

test("the main repository is where the worktree's commondir says, not two levels above its admin dir", async (t) => {
  const w = world(t);
  const store = join(w.root, "x", "store");
  const admin = join(w.root, "x", "admin", "wt");
  const tree = join(w.root, "tree");
  for (const dir of [join(store, ".git"), admin, join(tree, ".codex")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(admin, "commondir"), `${relative(admin, join(store, ".git"))}\n`);
  writeFileSync(join(tree, ".git"), `gitdir: ${admin}\n`);
  writeFileSync(join(tree, ".codex", "config.toml"), `${RO}\n`);
  writeFileSync(join(w.home, ".codex", "config.toml"), `[projects."${realpathSync(store)}"]\ntrust_level = "trusted"\n`);
  assert.equal((await paneLaunchMode("codex --no-daemon", tree, w.env, w.socket)).mode, "sandbox read-only");
});

test("OpenCode's OPENCODE_CONFIG_CONTENT from Aya's environment is the top layer", async (t) => {
  const w = world(t);
  const socket = w.socket;
  const plan = { ...w.env, OPENCODE_CONFIG_CONTENT: '{"default_agent":"plan"}' };
  assert.deepEqual((await paneLaunchMode("opencode", w.repo, plan, socket)).reach, "blocked");
  assert.equal((await paneLaunchMode("opencode --agent build", w.repo, plan, socket)).reach, "reaches");
  assert.equal((await paneLaunchMode(`OPENCODE_CONFIG_CONTENT='{"instructions":[]}' opencode`, w.repo, plan, socket)).reach, "reaches");
  assert.equal((await roleLaunchCheck("opencode", w.repo, plan, socket, "/bin/sh")).reach, "reaches", "a role's pane gets --agent build");
});

test("outside a repository only the pane's own directory counts, not its parents", async (t) => {
  const w = world(t);
  const outside = join(w.root, "plain", "sub");
  mkdirSync(outside, { recursive: true });
  mkdirSync(join(w.root, "plain", ".codex"));
  writeFileSync(join(w.root, "plain", ".codex", "config.toml"), 'sandbox_mode = "danger-full-access"\n');
  const mode = await paneLaunchMode("codex --no-daemon", outside, w.env, w.socket);
  assert.deepEqual([mode.mode, mode.reach], ["sandbox workspace-write", "blocked"]);
});

test("an OpenCode project default agent is read from the repository root", async (t) => {
  const w = world(t);
  writeFileSync(join(w.repo, "opencode.json"), '{"default_agent": "plan"}');
  const mode = await paneLaunchMode("opencode", join(w.repo, "app"), w.env, w.socket);
  assert.deepEqual([mode.mode, mode.reach], ["agent plan", "blocked"]);
});

test("Claude Code settings: the user's, the project's, and a --settings file", async (t) => {
  const w = world(t);
  mkdirSync(join(w.home, ".claude"));
  writeFileSync(join(w.home, ".claude", "settings.json"), JSON.stringify({ sandbox: { enabled: true } }));
  const cwd = join(w.repo, "app");
  const socket = w.socket;
  assert.equal((await paneLaunchMode("claude", cwd, w.env, socket)).reach, "blocked");
  const allow = { sandbox: { network: { allowUnixSockets: [join(realpathSync(w.root), "aya.sock")] } } };
  writeFileSync(join(cwd, "team.json"), JSON.stringify(allow));
  assert.equal((await paneLaunchMode("claude --settings team.json", cwd, w.env, socket)).reach, "reaches");
  mkdirSync(join(cwd, ".claude"));
  writeFileSync(join(cwd, ".claude", "settings.local.json"), JSON.stringify(allow));
  assert.equal((await paneLaunchMode("claude", cwd, w.env, socket)).reach, "reaches");
});

test("the socket is matched by its real path, as Claude Code matches it", async (t) => {
  const w = world(t);
  symlinkSync(w.root, join(w.home, "link"));
  const config = await readLaunchConfig("claude", w.repo, w.env, join(w.home, "link", "aya.sock"));
  assert.equal(config.socket, join(realpathSync(w.root), "aya.sock"));
});

function fakeCodex(dir, help) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "codex"), `#!/bin/sh\necho '      ${help}'\n`);
  chmodSync(join(dir, "codex"), 0o755);
}

test("a preset checked for a role's pane: as the host would launch it, --no-daemon included", async (t) => {
  const w = world(t);
  fakeCodex(join(w.root, "new"), "--no-daemon");
  fakeCodex(join(w.root, "old"), "--model <MODEL>");
  const check = (command, dir) =>
    roleLaunchCheck(command, w.repo, { ...w.env, PATH: `${join(w.root, dir)}:/usr/bin:/bin` }, w.socket, "/bin/sh");
  assert.deepEqual(await check("codex", "new"), { reach: "reaches", refused: null });
  assert.match((await check("codex -s read-only", "new")).refused, /^Codex sandbox read-only blocks the socket; pick a preset/);
  const old = await check("codex --yolo", "old");
  assert.equal(old.reach, "blocked");
  assert.match(old.refused, /shared daemon/);
  assert.deepEqual(await check("$SHELL", "new"), { reach: "unknown", refused: null });
});

const SANDBOX_ON = JSON.stringify({ sandbox: { enabled: true } });

// [--settings spelling, what the file is, expected reach]
const SETTINGS_PATHS = [
  ["~/sb.json", "at HOME", "blocked"],
  ["$HOME/sb.json", "at HOME", "blocked"],
  ['"$HOME/sb.json"', "at HOME", "blocked"],
  ["--settings=~/sb.json", "at HOME", "blocked"],
  ["$TEAMDIR/sb.json", "unresolved", "unknown"],
  ["~/missing.json", "missing", "unknown"],
  ["sb.json", "in the cwd", "blocked"],
];

for (const [spelling, where, reach] of SETTINGS_PATHS) {
  test(`claude --settings ${spelling} (${where}): the sandbox it turns on is seen, an unreadable file is unknown`, async (t) => {
    const w = world(t);
    writeFileSync(join(w.home, "sb.json"), SANDBOX_ON);
    writeFileSync(join(w.repo, "app", "sb.json"), SANDBOX_ON);
    const flag = spelling.startsWith("--settings=") ? spelling : `--settings ${spelling}`;
    const mode = await paneLaunchMode(`claude ${flag}`, join(w.repo, "app"), w.env, w.socket);
    assert.equal(mode.reach, reach, JSON.stringify(mode));
  });
}

test("claude --settings with a variable the command itself assigns is read from that value", async (t) => {
  const w = world(t);
  writeFileSync(join(w.home, "sb.json"), SANDBOX_ON);
  const mode = await paneLaunchMode(`TEAMDIR=${w.home} claude --settings $TEAMDIR/sb.json`, join(w.repo, "app"), w.env, w.socket);
  assert.equal(mode.reach, "blocked");
});

test("claude --settings ~/x with no HOME is unknown, not read as a sandbox-free pane", async (t) => {
  const w = world(t);
  const mode = await paneLaunchMode("claude --settings ~/sb.json", join(w.repo, "app"), {}, w.socket);
  assert.equal(mode.reach, "unknown");
});

test("claude --settings ~/x with no HOME is unknown even when a directory named ~ holds a readable file", async (t) => {
  const w = world(t);
  mkdirSync(join(w.repo, "app", "~"));
  writeFileSync(join(w.repo, "app", "~", "sb.json"), "{}");
  const mode = await paneLaunchMode("claude --settings ~/sb.json", join(w.repo, "app"), {}, w.socket);
  assert.equal(mode.reach, "unknown");
});

test("claude --settings whose value comes from a variable or a command is unknown, not read as no sandbox", async (t) => {
  const w = world(t);
  for (const command of [`claude --settings "$SB"`, `claude --settings "$(printf x)/sb.json"`, "claude --settings `printf x`"]) {
    const mode = await paneLaunchMode(command, join(w.repo, "app"), { ...w.env, SB: SANDBOX_ON }, w.socket);
    assert.equal(mode.reach, "unknown", command);
  }
});
