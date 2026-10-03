// The real `aya` CLI against the real process table: a command under the pane's process is accepted, one whose parent
// chain left the pane (a daemon's command) is refused, whatever AYA_TERMINAL_ID says.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { startControlServerOn } = await import("../dist-electron/control.js");
const { readProcessTable } = await import("../dist-electron/caller-proof.js");

const AYA = join(process.cwd(), "bin", "aya");
const DIR = realpathSync(tmpdir());
const PROJECTS = [{ slug: "p", name: "p", directory: DIR, tabs: [{ id: "pane-a", presetId: "codex", name: "a" }] }];
// The scripts are files so no quoting depends on how deep the shell nesting goes; the exit line
// makes "the CLI ran" visible even when it prints nothing.
const SCRIPTS = mkdtempSync(join(tmpdir(), "aya-ask-"));
process.on("exit", () => rmSync(SCRIPTS, { recursive: true, force: true }));
const scriptFor = (name, command) => {
  const file = join(SCRIPTS, name);
  writeFileSync(file, `${command} > "$OUT" 2>&1\necho "exit=$?" >> "$OUT"\n`);
  return `sh ${file}`;
};
const ASK = scriptFor("ask.sh", "$AYA team whoami");
const SAY = scriptFor("say.sh", '$AYA team send reviewer "codex app-server reproduced"');

/** Runs `script` in a shell; `paneOf` says which pid Aya believes is pane-a's process. */
async function run(script, paneOf, projects = PROJECTS) {
  const home = mkdtempSync(join(tmpdir(), "aya-proof-cli-"));
  const socket = join(home, "s.sock");
  const out = join(home, "out");
  let shellPid = 0;
  const stop = startControlServerOn(socket, {
    getWindow: () => null,
    openProject: () => {},
    listProjects: async () => projects,
    panePid: async () => paneOf(shellPid),
  });
  try {
    const shell = spawn("sh", ["-c", script], {
      cwd: DIR,
      env: { PATH: process.env.PATH, HOME: home, AYA_SOCKET: socket, AYA_TERMINAL_ID: "pane-a", OUT: out, AYA },
      stdio: "ignore",
    });
    shellPid = shell.pid;
    // The exit line is the script's last write: waiting for it, not for a pause, means the CLI is done.
    const finished = () => (existsSync(out) ? readFileSync(out, "utf8") : "");
    const started = Date.now();
    while (!/exit=\d+\n$/.test(finished()) && Date.now() - started < 10000) await new Promise((r) => setTimeout(r, 20));
    assert.ok(/exit=\d+\n$/.test(finished()), `the CLI never finished: ${script}`);
    return finished();
  } finally {
    stop();
    rmSync(home, { recursive: true, force: true });
  }
}

const refused = /^aya: the identity of this command \(AYA_TERMINAL_ID=pane-a\) cannot be proven[^\n]*\nexit=1\n$/;
// Past the proof, this stand-in server has no team deps and says so: that is what "accepted" looks like here.
const accepted = /^aya: teams are not available\nexit=1\n$/;

test("the process table lists this process under its parent", async () => {
  assert.equal((await readProcessTable())?.get(process.pid)?.ppid, process.ppid);
});

test("aya run directly by the pane's process is accepted", async () => {
  assert.match(await run(ASK, (shell) => shell), accepted);
});

test("aya run several processes below the pane's process is accepted", async () => {
  assert.match(await run(`sh -c '${ASK}'`, (shell) => shell), accepted);
});

test("aya run by a background job that outlived the pane's process is refused", async () => {
  assert.match(await run(`(sleep 0.5; ${ASK}) &`, (shell) => shell), refused);
});

test("aya run under another process than the pane's is refused", async () => {
  const other = spawn("sleep", ["30"]);
  try {
    assert.match(await run(ASK, () => other.pid), refused);
  } finally {
    other.kill();
  }
});

// A stand-in `codex`: a node process whose argv is `node .../codex.js <args>` that runs the ask below it.
const FAKE_BIN = mkdtempSync(join(tmpdir(), "aya-fake-codex-"));
writeFileSync(join(FAKE_BIN, "codex.js"), `require("node:child_process").spawnSync("sh", ["-c", ${JSON.stringify(ASK)}], { stdio: "ignore" });\n`);
const CODEX = `node ${FAKE_BIN}/codex.js`;
process.on("exit", () => rmSync(FAKE_BIN, { recursive: true, force: true }));

test("aya run by the Codex app-server a TUI in the pane started is refused", async () => {
  assert.match(await run(`${CODEX} app-server; true`, (shell) => shell), refused);
});

test("aya run by a hand-started `codex app-server &` in the pane's shell is refused", async () => {
  assert.match(await run(`${CODEX} app-server & wait`, (shell) => shell), refused);
});

test("aya run by another Codex process under the pane (no app-server) is accepted", async () => {
  assert.match(await run(`${CODEX} exec; true`, (shell) => shell), accepted);
});

test("aya whose own argv says `codex app-server` (a message) is accepted", async () => {
  assert.match(await run(SAY, (shell) => shell), accepted);
});

// Caller proof must never turn "Aya is still starting / the pane is coming up" into a hard refusal.

test("boot gap: the project list is not loaded yet and the host has no process for the pane: not refused", async () => {
  assert.match(await run(ASK, () => null, []), accepted);
});

test("the host cannot say what the pane runs (unreachable, or an old host): not refused", async () => {
  assert.match(await run(ASK, () => undefined), accepted);
  assert.match(await run(ASK, () => undefined, []), accepted);
});

test("a pane's own command while the host lists its process as a parent is accepted even with the project list empty", async () => {
  assert.match(await run(ASK, (shell) => shell, []), accepted);
});

test("a tab that exists with no process is refused for a command that really ran (a leftover job)", async () => {
  assert.match(await run(`(sleep 0.5; ${ASK}) &`, () => null), /^aya: pane-a is not running; the command comes from a leftover[^\n]*\nexit=1\n$/);
});
