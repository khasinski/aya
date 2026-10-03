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

const { runStatusCommand, statusRun, statusSection, statusCommandEnv, capOutput, STATUS_OUTPUT_MAX_BYTES, STATUS_COMMAND_TIMEOUT_MS } = await import("../dist-electron/team-status-command.js");
const { TEAM_FILES } = await import("../dist-electron/team-records.js");

// The timeout case: a 1 s limit on a 30 s sleep must return well before the sleep ends.
const SHORT_TIMEOUT_MS = 1_000;
const RETURNED_WITHIN_MS = 5_000;
const KILL_SETTLE_MS = 200;
const UTF8_MAX_CHAR_BYTES = 4;
const CLI_TIMEOUT_MS = 30_000;

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
  { name: "ESC sequences, CR and Ctrl-U do not reach the composer", command: "printf '\\033[31mred\\033[0m\\r\\nok\\007\\025 a\\rb\\n'", output: "red\nok ab", failure: null, section: "Status (from the team's command): red | ok ab" },
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
  const run = await runStatusCommand("sleep 30 & echo $! > child.pid; echo partial; wait", dir, SHORT_TIMEOUT_MS);
  assert.ok(Date.now() - started < RETURNED_WITHIN_MS, "returned at the timeout, not when sleep ended");
  assert.equal(run.failure, "status command timed out after 1 s");
  assert.equal(run.output, "partial");
  const pid = Number(readFileSync(join(dir, "child.pid"), "utf8"));
  await new Promise((r) => setTimeout(r, KILL_SETTLE_MS));
  assert.throws(() => process.kill(pid, 0), "the background sleep was killed with its group");
});

test("huge output is cut at the cap, on a character boundary, and says so", async () => {
  const run = await runStatusCommand(`yes ąą | head -c ${STATUS_OUTPUT_MAX_BYTES * 100}`, projectDir());
  assert.equal(run.failure, null);
  const note = `\n(cut at ${STATUS_OUTPUT_MAX_BYTES} bytes)`;
  assert.ok(run.output.endsWith(note), run.output.slice(-40));
  const body = run.output.slice(0, -note.length);
  assert.ok(Buffer.byteLength(body) <= STATUS_OUTPUT_MAX_BYTES);
  assert.ok(Buffer.byteLength(body) > STATUS_OUTPUT_MAX_BYTES - UTF8_MAX_CHAR_BYTES, "cut at the cap, not well before it");
  assert.doesNotMatch(body, /�/);
  assert.equal(capOutput("short"), "short");
  const atCap = "a".repeat(STATUS_OUTPUT_MAX_BYTES);
  assert.equal(capOutput(atCap), atCap, "exactly the cap is not cut");
  assert.equal(capOutput(`${atCap}b`), `${atCap}\n(cut at ${STATUS_OUTPUT_MAX_BYTES} bytes)`);
});

test("output in many small writes is kept up to the cap, not only the first writes", async () => {
  const writes = 30;
  const each = Math.ceil((STATUS_OUTPUT_MAX_BYTES * 1.5) / writes);
  const run = await runStatusCommand(`i=0; while [ $i -lt ${writes} ]; do head -c ${each} /dev/zero | tr '\\0' a; sleep 0.01; i=$((i+1)); done`, projectDir());
  assert.equal(run.output, `${"a".repeat(STATUS_OUTPUT_MAX_BYTES)}\n(cut at ${STATUS_OUTPUT_MAX_BYTES} bytes)`);
});

test("the default limit is 20 s: long enough for a GPU or model-server query, short enough for a round", () => {
  assert.equal(STATUS_COMMAND_TIMEOUT_MS, 20_000);
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

// The round records each run in the team's status.json; aya team stats only reads that, never runs the command.
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

function statsHome({ command, state = { started: true } }) {
  const h = mkdtempSync(join(root, "cli-"));
  const dir = join(h, "aya", "teams", "game", "crew");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, TEAM_FILES.saved), SAVED(command));
  writeFileSync(join(dir, TEAM_FILES.state), JSON.stringify(state));
  const directory = join(h, "game");
  mkdirSync(directory);
  mkdirSync(join(h, "aya", "projects"), { recursive: true });
  writeFileSync(join(h, "aya", "projects", "game.json"), JSON.stringify({ name: "game", directory, tabs: [] }));
  return { h, dir, directory };
}
const stats = (h, json) =>
  spawnSync("/bin/sh", [resolve("bin/aya"), "team", "stats", "crew", ...(json ? ["--json"] : [])], {
    env: { ...envWithoutAya(), HOME: h, AYA_HOME: join(h, "aya") },
    encoding: "utf8",
    timeout: CLI_TIMEOUT_MS,
  });
const hhmm = (iso) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const NOT_RUN_YET = "  not run yet: it runs with the lead's rounds of a running local team\n";

test("a round's run is recorded in status.json: the command, its output, failure and time", async () => {
  const directory = projectDir();
  const dir = join(root, "team-recorded");
  const before = Date.now();
  const run = await statusRun(team("echo athena; exit 3", { directory, dir }));
  const recorded = JSON.parse(readFileSync(join(dir, TEAM_FILES.status), "utf8"));
  assert.deepEqual({ ...recorded, ranAt: undefined }, { command: "echo athena; exit 3", output: "athena", failure: "status command failed: exit 3", ranAt: undefined });
  assert.deepEqual([recorded.output, recorded.failure], [run.output, run.failure]);
  assert.ok(Date.parse(recorded.ranAt) >= before && Date.parse(recorded.ranAt) <= Date.now());
});

test("a run that is not made records nothing", async () => {
  const dir = join(root, "team-not-recorded");
  assert.equal(await statusRun(team("echo x", { dir, state: { paused: true, running: false } })), null);
  assert.equal(existsSync(join(dir, TEAM_FILES.status)), false);
});

// [name, saved command, recorded run (null: none), what the block ends with]
const STATS_CASES = [
  ["running, never run: not run yet", "touch ran", null, () => NOT_RUN_YET],
  ["the last recorded run, with its time", "touch ran", { output: "athena: gemma\nlaptop: idle", failure: "status command failed: exit 3" }, (at) => `  last run ${hhmm(at)}\n  athena: gemma\n  laptop: idle\n  status command failed: exit 3\n`],
  ["a run with no output says so", "touch ran", { output: "", failure: null }, (at) => `  last run ${hhmm(at)}\n  no output\n`],
  ["a run of an older command is not this one's", "touch ran", { command: "echo old", output: "old", failure: null }, () => NOT_RUN_YET],
  ["a torn status.json: not run yet", "touch ran", "torn", () => NOT_RUN_YET],
];
for (const [name, command, recorded, tail] of STATS_CASES) {
  test(`aya team stats: ${name}; it never runs the command`, () => {
    const { h, dir, directory } = statsHome({ command });
    const ranAt = new Date(Date.now() - 5 * 60_000).toISOString();
    if (recorded === "torn") writeFileSync(join(dir, TEAM_FILES.status), "{\"command\":");
    else if (recorded) writeFileSync(join(dir, TEAM_FILES.status), JSON.stringify({ command, ranAt, ...recorded }));
    const r = stats(h);
    assert.equal(r.status, 0, r.stderr);
    const block = `\nStatus (from the team's command)\n  command: ${command}\n${tail(ranAt)}`;
    assert.ok(r.stdout.endsWith(block), r.stdout.slice(-300));
    const json = JSON.parse(stats(h, true).stdout).statusCommand;
    const shown = recorded && recorded !== "torn" && !recorded.command;
    assert.deepEqual(json, { command, ranAt: shown ? ranAt : null, output: shown ? recorded.output : "", failure: shown ? recorded.failure : null });
    assert.equal(existsSync(join(directory, "ran")), false, "stats did not run the command");
  });
}

test("aya team stats: no status command, no block", () => {
  const { h } = statsHome({ command: null });
  const r = stats(h);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /Status \(from/);
  assert.equal(JSON.parse(stats(h, true).stdout).statusCommand, null);
});

test("aya team stats --now: the round's digest ends with the last recorded run too, never a new one", () => {
  const command = "touch ran";
  const { h, dir, directory } = statsHome({ command });
  const ranAt = new Date(Date.now() - 5 * 60_000).toISOString();
  writeFileSync(join(dir, TEAM_FILES.status), JSON.stringify({ command, ranAt, output: "athena: gemma", failure: null }));
  const r = spawnSync("/bin/sh", [resolve("bin/aya"), "team", "stats", "crew", "--now"], { env: { ...envWithoutAya(), HOME: h, AYA_HOME: join(h, "aya") }, encoding: "utf8", timeout: CLI_TIMEOUT_MS });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.endsWith(`\nStatus (from the team's command)\n  command: touch ran\n  last run ${hhmm(ranAt)}\n  athena: gemma\n`), r.stdout);
  assert.equal(r.stdout.split("Status (from the team's command)").length, 2, "the block once");
  assert.equal(existsSync(join(directory, "ran")), false);
});
