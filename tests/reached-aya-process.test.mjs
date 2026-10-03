// A pane's proof that it reaches Aya belongs to the process that called aya, not to the pane id.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { reachedAyaPanes } = await import("../dist-electron/reached-aya.js");

const OLD = 100;
const NEW = 200;
// The caller (aya, 150) runs under the old process, 250 under the new one.
const TABLE = new Map([[150, { ppid: OLD, command: "aya" }], [250, { ppid: NEW, command: "aya" }], [OLD, { ppid: 1, command: "codex" }], [NEW, { ppid: 1, command: "codex" }]]);

function pane() {
  let pid = OLD;
  const panes = reachedAyaPanes({ panePid: async () => pid, processTable: async () => TABLE });
  return { panes, restart: () => (pid = NEW), stop: () => (pid = null) };
}

test("the proof of a process | a call settles the pane while that process runs, re-mounts included", async () => {
  const { panes } = pane();
  await panes.called({ terminalId: "pane-a", pid: 150 });
  assert.equal(await panes.has("pane-a"), true);
  assert.equal(await panes.has("pane-a"), true, "asked again, as a re-mounted window does");
});

test("the proof of a process | a restarted pane (another process) needs it again, with no one forgetting it", async () => {
  const { panes, restart } = pane();
  await panes.called({ terminalId: "pane-a", pid: 150 });
  restart();
  assert.equal(await panes.has("pane-a"), false);
});

test("the proof of a process | a pane with no process has none", async () => {
  const { panes, stop } = pane();
  await panes.called({ terminalId: "pane-a", pid: 150 });
  stop();
  assert.equal(await panes.has("pane-a"), false);
});

test("the proof of a process | the killed process's call, proven against it, does not settle the restarted pane", async () => {
  let pid = OLD;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const panes = reachedAyaPanes({ panePid: async () => pid, processTable: async () => (await gate, TABLE) });
  const inFlight = panes.called({ terminalId: "pane-a", pid: 150 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  pid = NEW;
  release();
  await inFlight;
  assert.equal(await panes.has("pane-a"), false);
});

// Codex's shared daemon runs every pane's commands under the pane that started it, with that pane's id.
test("the proof of a process | a call through a Codex daemon settles no pane", async () => {
  const table = new Map([
    [340, { ppid: 330, command: "aya" }],
    [330, { ppid: 320, command: "sh" }],
    [320, { ppid: 300, command: "/opt/codex/bin/codex app-server --listen unix://" }],
    [300, { ppid: OLD, command: "node /usr/local/bin/codex" }],
    [OLD, { ppid: 1, command: "zsh" }],
  ]);
  const panes = reachedAyaPanes({ panePid: async () => OLD, processTable: async () => table });
  await panes.called({ terminalId: "pane-a", pid: 340 });
  assert.equal(await panes.has("pane-a"), false);
});

test("the proof of a process | a restarted pane is settled again by its new process's call", async () => {
  const { panes, restart } = pane();
  await panes.called({ terminalId: "pane-a", pid: 150 });
  restart();
  await panes.called({ terminalId: "pane-a", pid: 250 });
  assert.equal(await panes.has("pane-a"), true);
});

// The pty host outlives a quit of Aya, and so does the pane's process.
test("the proof of a process | a relaunch of Aya keeps it while the pane's process lives on, not for a new one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aya-reached-"));
  try {
    const file = join(dir, "reached-aya.json");
    let pid = OLD;
    const life = () => reachedAyaPanes({ panePid: async () => pid, processTable: async () => TABLE, file });
    await life().called({ terminalId: "pane-a", pid: 150 });
    assert.equal(await life().has("pane-a"), true, "the next Aya, same pane process");
    pid = NEW;
    assert.equal(await life().has("pane-a"), false, "the next Aya, the pane restarted meanwhile");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the proof of a process | a settled pane is told once, its process not asked again", async () => {
  let told = 0;
  let asked = 0;
  const panes = reachedAyaPanes({ panePid: async () => OLD, processTable: async () => (asked++, TABLE), onReached: () => told++ });
  await panes.called({ terminalId: "pane-a", pid: 150 });
  await panes.called({ terminalId: "pane-a", pid: 150 });
  assert.deepEqual({ told, asked }, { told: 1, asked: 1 });
});

test("the proof of a process | a saved entry that is not a pid proves nothing, even for a pane with no process", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "aya-reached-"));
  try {
    const file = join(dir, "reached-aya.json");
    writeFileSync(file, JSON.stringify({ "pane-a": null }));
    assert.equal(await reachedAyaPanes({ panePid: async () => null, file }).has("pane-a"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
