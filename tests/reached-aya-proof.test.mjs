// The pane id in a command's env is only a claim: only an aya call the process table shows under the pane's
// process settles its "may not reach Aya" note. The real `aya` CLI against the real process table.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { startControlServerOn } = await import("../dist-electron/control.js");
const { reachedAyaPanes } = await import("../dist-electron/reached-aya.js");

const AYA = join(process.cwd(), "bin", "aya");
const DIR = realpathSync(tmpdir());
const PROJECTS = [{ slug: "p", name: "p", directory: DIR, tabs: [{ id: "pane-a", presetId: "codex", name: "a" }] }];
const SCRIPTS = mkdtempSync(join(tmpdir(), "aya-reach-"));
process.on("exit", () => rmSync(SCRIPTS, { recursive: true, force: true }));
const STATUS = join(SCRIPTS, "status.sh");
writeFileSync(STATUS, '$AYA capabilities > "$OUT" 2>&1\necho "exit=$?" >> "$OUT"\n');

/** Runs aya with AYA_TERMINAL_ID=pane-a in a shell; `paneOf` says which pid is pane-a's process (the shell's, another's,
 *  or null: not running). Returns whether the call settled pane-a. */
async function reached(paneOf) {
  const home = mkdtempSync(join(tmpdir(), "aya-reach-cli-"));
  const socket = join(home, "s.sock");
  const out = join(home, "out");
  const other = spawn("sleep", ["30"], { stdio: "ignore" });
  let shellPid = 0;
  const panePid = async (id) => (id === "pane-a" ? paneOf(shellPid, other.pid) : null);
  const panes = reachedAyaPanes({ panePid });
  const stop = startControlServerOn(socket, {
    getWindow: () => null,
    openProject: () => {},
    listProjects: async () => PROJECTS,
    panePid,
    onRequest: (_request, caller) => panes.called(caller),
  });
  try {
    const shell = spawn("sh", [STATUS], { cwd: DIR, env: { PATH: process.env.PATH, HOME: home, AYA_SOCKET: socket, AYA_TERMINAL_ID: "pane-a", OUT: out, AYA }, stdio: "ignore" });
    shellPid = shell.pid;
    const finished = () => (existsSync(out) ? readFileSync(out, "utf8") : "");
    const started = Date.now();
    while (!/exit=\d+\n$/.test(finished()) && Date.now() - started < 10000) await new Promise((r) => setTimeout(r, 20));
    assert.match(finished(), /exit=0\n$/, "the CLI ran");
    return await panes.has("pane-a");
  } finally {
    other.kill();
    stop();
    rmSync(home, { recursive: true, force: true });
  }
}

test("aya run by the pane's own process settles its note", async () => {
  assert.equal(await reached((shell) => shell), true);
});

test("aya run by another process with the pane's id borrowed does not settle it", async () => {
  assert.equal(await reached((_shell, other) => other), false);
});

test("aya with the id of a pane that has no process does not settle it", async () => {
  assert.equal(await reached(() => null), false);
});

test("a call that proves nothing (no pid: an older CLI) does not settle a note", async () => {
  const panes = reachedAyaPanes({ panePid: async () => process.pid });
  await panes.called({ terminalId: "pane-a" });
  assert.equal(await panes.has("pane-a"), false);
});

test("a caller the process table does not list (gone, or ps silent) does not settle a note", async () => {
  for (const table of [new Map([[process.ppid, { ppid: 1, command: "sh" }]]), null]) {
    const panes = reachedAyaPanes({ panePid: async () => process.ppid, processTable: async () => table });
    await panes.called({ terminalId: "pane-a", pid: process.pid });
    assert.equal(await panes.has("pane-a"), false);
  }
});

test("a respawned pane needs its proof again", async () => {
  let panePid = process.ppid;
  const panes = reachedAyaPanes({ panePid: async () => panePid, processTable: async () => new Map([[process.pid, { ppid: process.ppid, command: "node" }], [process.ppid, { ppid: 1, command: "sh" }]]) });
  await panes.called({ terminalId: "pane-a", pid: process.pid });
  assert.equal(await panes.has("pane-a"), true, "a process under the pane's process");
  panePid = process.ppid + 1;
  assert.equal(await panes.has("pane-a"), false);
});
