// A role's pane command composed as pane-brief.ts and pty.ts do (brief -> resume -> --no-daemon -> role launch), run against
// stub binaries that print their argv and env.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opencodeConfigJson, withRoleNote } from "../dist-electron/agent-brief.js";
import { noDaemonCommand } from "../dist-electron/codex-daemon.js";
import { readLaunchConfig } from "../dist-electron/launch-config.js";
import { launchMode, teamLaunch, withLaunchArgs } from "../dist-electron/launch-mode.js";
import { withCliFirst } from "../dist-electron/pane-command.js";
import { ownSessionCommand } from "../dist-electron/opencode-session.js";

const FULL_NEVER = ["-s", "danger-full-access", "-a", "never"];
// The role note Codex takes as a config override (pane-brief.ts), after everything else.
const CODEX_NOTE = ["-c", 'developer_instructions="You are the reviewer."'];

function world() {
  const root = mkdtempSync(join(tmpdir(), "aya-compose-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  const repo = join(root, "repo");
  for (const dir of [bin, join(home, ".codex"), join(repo, ".git")]) mkdirSync(dir, { recursive: true });
  for (const name of ["codex", "opencode", "claude"]) {
    writeFileSync(
      join(bin, name),
      `#!${process.execPath}\nconsole.log(JSON.stringify({ argv: process.argv.slice(2), content: process.env.OPENCODE_CONFIG_CONTENT ?? null, config: process.env.OPENCODE_CONFIG ?? null }));\n`,
    );
    chmodSync(join(bin, name), 0o755);
  }
  return { root, bin, home, repo, socket: join(root, "aya.sock"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const composeTest = (name, ...args) => {
  const fn = args.pop();
  test(name, async () => {
    const w = await world(...args);
    try {
      await fn(w);
    } finally {
      w.cleanup();
    }
  });
};

/** The spawn pipeline of pty.ts on `command`, then the stub run with what the shell would see. */
async function compose(w, { command, agent, env = {}, sessions = [], dev = false }) {
  const penv = { HOME: w.home, ...env };
  let cmd = command;
  // The role note of pane-brief.ts: the pane's own channel, whatever the user's shell already sets.
  const plan = withRoleNote(agent, cmd, "You are the reviewer.", {
    noteFile: join(w.root, "brief.json"),
    userConfig: env.OPENCODE_CONFIG,
    userConfigContent: env.OPENCODE_CONFIG_CONTENT,
  });
  if ("command" in plan) {
    cmd = plan.command;
    writeFileSync(join(w.root, "brief.md"), "You are the reviewer.\n");
    writeFileSync(join(w.root, "brief.json"), opencodeConfigJson(join(w.root, "brief.md")));
  }
  if (dev) cmd = withCliFirst(cmd, "/opt/aya/bin");
  cmd = await ownSessionCommand(cmd, w.repo, async () => sessions);
  cmd = await noDaemonCommand(cmd, async () => true);
  const launch = teamLaunch(cmd, await readLaunchConfig(cmd, w.repo, penv, w.socket));
  const final = "args" in launch ? withLaunchArgs(cmd, launch.args) : cmd;
  const mode = launchMode(final, await readLaunchConfig(final, w.repo, penv, w.socket));
  const shellEnv = { PATH: `${w.bin}:/usr/bin:/bin`, HOME: w.home, ...env };
  const ran = JSON.parse(execFileSync("/bin/sh", ["-c", final.replace("/opt/aya/bin", w.bin)], { cwd: w.repo, env: shellEnv, encoding: "utf8" }));
  return { final, mode, launch, ...ran };
}

composeTest("Codex: full access, --no-daemon and the resume subcommand reach the binary once each", async (w) => {
  const plain = await compose(w, { command: "codex", agent: "codex" });
  assert.deepEqual(plain.argv, [...FULL_NEVER, "--no-daemon", ...CODEX_NOTE]);
  assert.equal(plain.mode.reach, "reaches");
  const resumed = await compose(w, { command: "codex resume --last", agent: "codex" });
  assert.deepEqual(resumed.argv, [...FULL_NEVER, "--no-daemon", "resume", "--last", ...CODEX_NOTE]);
  assert.equal(resumed.mode.reach, "reaches");
  const own = await compose(w, { command: "codex -c model_reasoning_effort=high -p team", agent: "codex" });
  assert.deepEqual(own.argv, [...FULL_NEVER, "--no-daemon", "-c", "model_reasoning_effort=high", "-p", "team", ...CODEX_NOTE]);
  const dev = await compose(w, { command: "codex", agent: "codex", dev: true });
  assert.deepEqual(dev.argv, [...FULL_NEVER, "--no-daemon", ...CODEX_NOTE]);
  assert.match(dev.final, /^PATH='\/opt\/aya\/bin':"\$PATH" codex -s danger-full-access /);
  assert.equal(dev.mode.reach, "reaches");
});

composeTest("Codex: a read-only preset is refused, not escalated, and its command is left as it was", async (w) => {
  writeFileSync(join(w.home, ".codex", "config.toml"), 'sandbox_mode = "read-only"\n');
  const got = await compose(w, { command: "codex", agent: "codex" });
  assert.match(got.launch.refused, /read-only blocks the socket/);
  assert.deepEqual(got.argv, ["--no-daemon", ...CODEX_NOTE]);
  assert.equal(got.mode.reach, "blocked");
});

composeTest("OpenCode: the OPENCODE_CONFIG file carries instructions only, the resumed session comes through", async (w) => {
  const got = await compose(w, {
    command: "opencode --continue",
    agent: "opencode",
    sessions: [{ id: "ses_1", directory: realpathSync(w.repo), updated: 1 }],
  });
  assert.deepEqual(got.argv, ["--session", "ses_1"]);
  assert.deepEqual(JSON.parse(readFileSync(got.config, "utf8")), { instructions: [join(w.root, "brief.md")] });
  assert.equal(got.mode.reach, "reaches");
});

composeTest("OpenCode: the user's own OPENCODE_CONFIG_CONTENT with the plan agent gets --agent build, and is not overwritten", async (w) => {
  const content = '{"default_agent":"plan"}';
  const got = await compose(w, { command: "opencode", agent: "opencode", env: { OPENCODE_CONFIG_CONTENT: content } });
  assert.deepEqual(got.argv, ["--agent", "build"]);
  assert.equal(got.content, content);
  assert.equal(got.mode.reach, "reaches");
  const inline = await compose(w, { command: `OPENCODE_CONFIG_CONTENT='{"default_agent":"plan"}' opencode --continue`, agent: "opencode" });
  assert.deepEqual(inline.argv, ["--agent", "build"]);
  assert.equal(inline.mode.reach, "reaches");
});

composeTest("Claude: the sandbox allow-list, the brief and the resume flag all reach the binary", async (w) => {
  mkdirSync(join(w.home, ".claude"));
  writeFileSync(join(w.home, ".claude", "settings.json"), JSON.stringify({ sandbox: { enabled: true } }));
  const got = await compose(w, { command: "claude --continue", agent: "claude" });
  assert.equal(got.argv[0], "--settings");
  assert.deepEqual(JSON.parse(got.argv[1]).sandbox.network.allowUnixSockets.length, 1);
  assert.deepEqual(got.argv.slice(2), ["--continue", "--append-system-prompt", "You are the reviewer."]);
  assert.equal(got.mode.reach, "reaches");
  const own = await compose(w, { command: `claude --settings '{"model":"x"}'`, agent: "claude" });
  assert.match(own.launch.refused, /sandbox is on/);
  assert.equal(own.mode.reach, "blocked");
});

composeTest("Claude: a plan default mode in the settings is refused for a role's pane", async (w) => {
  mkdirSync(join(w.home, ".claude"));
  writeFileSync(join(w.home, ".claude", "settings.json"), JSON.stringify({ permissions: { defaultMode: "plan" } }));
  const got = await compose(w, { command: "claude", agent: "claude" });
  assert.match(got.launch.refused, /plan mode/);
  assert.equal(got.mode.reach, "blocked");
});
