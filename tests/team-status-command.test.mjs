// A team's "## Status command": run in the project for a running local team, bounded in time and size, its output
// one line for the lead's round. Table: the command's outcome x what the section says; then the gates and the CLI.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { isolateHome } from "./helpers/isolate-home.mjs";
import { envWithoutAya } from "./helpers/env.mjs";

const root = mkdtempSync(join(tmpdir(), "aya-status-cmd-"));
isolateHome(root);
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const { runStatusCommand, statusRun, statusSection, statusCommandEnv, capOutput, STATUS_OUTPUT_MAX_BYTES } = await import("../dist-electron/team-status-command.js");
const { TEAM_FILES } = await import("../dist-electron/team-records.js");

let n = 0;
const projectDir = () => {
  const dir = join(root, `project-${(n += 1)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const RUNNING = { paused: false, running: true };
const team = (command, { directory = projectDir(), state = RUNNING, remote, dir = join(root, `team-${(n += 1)}`) } = {}) => ({
  project: { directory, ...(remote ? { remote } : {}) },
  store: { dir, state: async () => state },
  team: command === undefined ? {} : { statusCommand: command },
});

const CASES = [
  { name: "exit 0, stdout", command: "printf 'a\\nb\\n'", output: "a\nb", failure: null, section: "Status (from the team's command): a | b" },
  { name: "exit 0, no output", command: "true", output: "", failure: null, section: "Status (from the team's command): no output" },
  { name: "non-zero exit keeps stdout and stderr", command: "echo out; echo err >&2; exit 2", output: "out\nstderr:\nerr", failure: "status command failed: exit 2", section: "Status (from the team's command): out | stderr: | err | status command failed: exit 2" },
  { name: "stderr on success is kept", command: "echo warn >&2", output: "stderr:\nwarn", failure: null, section: "Status (from the team's command): stderr: | warn" },
  { name: "ESC sequences and CR do not reach the composer", command: "printf '\\033[31mred\\033[0m\\r\\nok\\007\\n'", output: "red\nok", failure: null, section: "Status (from the team's command): red | ok" },
  { name: "no stdin: a reader gets EOF at once", command: "cat; echo done", output: "done", failure: null, section: "Status (from the team's command): done" },
  { name: "a command that is not there", command: "aya-no-such-command-xyz", output: /stderr:\n.*not found/, failure: "status command failed: exit 127", section: /status command failed: exit 127$/ },
];

for (const c of CASES) {
  test(`run: ${c.name}`, async () => {
    const t = team(c.command);
    const run = await statusRun(t);
    if (c.output instanceof RegExp) assert.match(run.output, c.output);
    else assert.equal(run.output, c.output);
    assert.equal(run.failure, c.failure);
    const section = await statusSection(t);
    if (c.section instanceof RegExp) assert.match(section, c.section);
    else assert.equal(section, c.section);
  });
}

test("timeout: reported as one line, and what the shell started is killed with it", async () => {
  const dir = projectDir();
  const started = Date.now();
  const run = await runStatusCommand("sleep 30 & echo $! > child.pid; echo partial; wait", dir, 1000);
  assert.ok(Date.now() - started < 5000, "returned at the timeout, not when sleep ended");
  assert.equal(run.failure, "status command timed out after 1 s");
  assert.equal(run.output, "partial");
  const pid = Number(readFileSync(join(dir, "child.pid"), "utf8"));
  await new Promise((r) => setTimeout(r, 200));
  assert.throws(() => process.kill(pid, 0), "the background sleep was killed with its group");
});

test("huge output is cut at the cap, on a character boundary, and says so", async () => {
  const run = await runStatusCommand("yes ąą | head -c 200000", projectDir());
  assert.equal(run.failure, null);
  const note = `\n(cut at ${STATUS_OUTPUT_MAX_BYTES} bytes)`;
  assert.ok(run.output.endsWith(note), run.output.slice(-40));
  const body = run.output.slice(0, -note.length);
  assert.ok(Buffer.byteLength(body) <= STATUS_OUTPUT_MAX_BYTES);
  assert.ok(Buffer.byteLength(body) > STATUS_OUTPUT_MAX_BYTES - 4, "cut at the cap, not well before it");
  assert.doesNotMatch(body, /�/);
  assert.equal(capOutput("short"), "short");
});

test("cwd is the project directory", async () => {
  const dir = projectDir();
  assert.equal((await statusRun(team("pwd -P", { directory: dir }))).output, realpathSync(dir));
});

test("env: no pane identity and no agent session markers, the rest kept", async () => {
  const env = statusCommandEnv({ PATH: "/usr/bin:/bin", AYA_TERMINAL_ID: "pane-1", AYA_PRESET_ID: "claude", AYA_PROJECT_SLUG: "game", AYA_PROJECT_DIR: "/x", AYA_HOME: "/h", CLAUDECODE: "1", MINE: "kept" });
  assert.deepEqual(env, { PATH: "/usr/bin:/bin", AYA_HOME: "/h", MINE: "kept" });
  const saved = process.env.AYA_TERMINAL_ID;
  process.env.AYA_TERMINAL_ID = "pane-leak";
  try {
    assert.equal((await statusRun(team('echo "[$AYA_TERMINAL_ID]"'))).output, "[]");
  } finally {
    if (saved === undefined) delete process.env.AYA_TERMINAL_ID;
    else process.env.AYA_TERMINAL_ID = saved;
  }
});

test("calls made while one runs share it; the next call after it runs again", async () => {
  const directory = projectDir();
  const dir = join(root, "team-shared");
  const t = team("echo x >> count; sleep 0.3; wc -l < count", { directory, dir });
  const [a, b] = await Promise.all([statusRun(t), statusRun(t)]);
  assert.equal(a, b, "one run, one result");
  assert.equal(readFileSync(join(directory, "count"), "utf8"), "x\n");
  await statusRun(t);
  assert.equal(readFileSync(join(directory, "count"), "utf8"), "x\nx\n");
  // Another team's run is not held up by, nor shared with, this one.
  const other = team("echo other", { directory, dir: join(root, "team-other") });
  const [c, d] = await Promise.all([statusRun(t), statusRun(other)]);
  assert.notEqual(c, d);
  assert.equal(d.output, "other");
});

const GATES = [
  { name: "paused", opts: { state: { paused: true, running: false } } },
  { name: "not started", opts: { state: { paused: false, running: false } } },
  { name: "remote project", opts: { remote: { hostId: "h" } } },
];
for (const g of GATES) {
  test(`not run: ${g.name}`, async () => {
    const directory = projectDir();
    const t = team("touch ran", { directory, ...g.opts });
    assert.equal(await statusRun(t), null);
    assert.equal(await statusSection(t), null);
    assert.equal(existsSync(join(directory, "ran")), false);
  });
}
test("not run: the team has no status command (absent or blank)", async () => {
  assert.equal(await statusSection(team(undefined)), null);
  assert.equal(await statusSection(team("   ")), null);
  // The control: the same team with a command does run.
  assert.equal(await statusSection(team("echo y")), "Status (from the team's command): y");
});

test("never throws into the runner: a state read that fails becomes a failure line", async () => {
  const t = { ...team("echo y"), store: { dir: join(root, "team-throws"), state: async () => Promise.reject(new Error("state.json torn")) } };
  assert.equal(await statusSection(t), "Status (from the team's command): status command failed: state.json torn");
});

// The real CLI: aya team stats prints the block from the saved definition, on a temp AYA_HOME.
const SAVED = (command) => `# crew

## Role: lead
Sends to: tester
Must not: skip a round

## Role: tester
Sends to: lead
Must not: skip a round

## Lead
lead
${command ? `\n## Status command\n${command}\n` : ""}`;

function statsHome({ command, state, project = true }) {
  const h = mkdtempSync(join(root, "cli-"));
  const dir = join(h, "aya", "teams", "game", "crew");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, TEAM_FILES.saved), SAVED(command));
  writeFileSync(join(dir, TEAM_FILES.state), JSON.stringify(state));
  const directory = join(h, "game");
  mkdirSync(directory);
  if (project) {
    mkdirSync(join(h, "aya", "projects"), { recursive: true });
    writeFileSync(join(h, "aya", "projects", "game.json"), JSON.stringify({ name: "game", directory, tabs: [] }));
  }
  return { h, directory };
}
const stats = (h, json) =>
  spawnSync("/bin/sh", [resolve("bin/aya"), "team", "stats", "crew", ...(json ? ["--json"] : [])], {
    env: { ...envWithoutAya(), HOME: h, AYA_HOME: join(h, "aya") },
    encoding: "utf8",
    timeout: 30000,
  });

const STATS_CASES = [
  { name: "running: the output, run in the project", command: "pwd -P; exit 3", state: { started: true }, out: (d) => `\nStatus (from the team's command)\n  command: pwd -P; exit 3\n  ${d}\n  status command failed: exit 3\n` },
  { name: "paused: not run", command: "touch ran", state: { started: true, paused: true }, out: () => "\nStatus (from the team's command)\n  command: touch ran\n  not run: the team is paused; it runs only for a running team\n" },
  { name: "not started: not run", command: "touch ran", state: {}, out: () => "\nStatus (from the team's command)\n  command: touch ran\n  not run: the team is not started; it runs only for a running team\n" },
  { name: "no project file: not run", command: "touch ran", state: { started: true }, project: false, out: () => "\nStatus (from the team's command)\n  command: touch ran\n  not run: project game is not in Aya's projects\n" },
  { name: "no status command: no block", command: null, state: { started: true }, out: null },
];
for (const c of STATS_CASES) {
  test(`aya team stats: ${c.name}`, () => {
    const { h, directory } = statsHome(c);
    const r = stats(h);
    assert.equal(r.status, 0, r.stderr);
    if (c.out === null) assert.doesNotMatch(r.stdout, /Status \(from/);
    else assert.ok(r.stdout.endsWith(c.out(realpathSync(directory))), r.stdout.slice(-300));
    assert.equal(existsSync(join(directory, "ran")), false);
    const json = JSON.parse(stats(h, true).stdout);
    assert.equal(json.statusCommand?.command ?? null, c.command);
  });
}
