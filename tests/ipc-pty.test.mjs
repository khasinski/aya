// Terminal IPC (electron/ipc/pty-ipc.ts) against a stand-in host and the real spawn gate.

import { test } from "node:test";
import assert from "node:assert/strict";

const { registerPtyIpc } = await import("../dist-electron/ipc/pty-ipc.js");
const { createSpawnGate } = await import("../dist-electron/spawn-gate.js");
const { PTY_HOST_NOT_CONNECTED } = await import("../dist-electron/constants.js");

function setup(over = {}) {
  const handlers = new Map();
  const log = [];
  const gate = createSpawnGate();
  const panes = new Set();
  const host = {
    write: async (id, text) => (log.push(["write", id, text]), true),
    resize: async (id, cols, rows) => log.push(["resize", id, cols, rows]),
    kill: async (id) => (panes.delete(id), log.push(["kill", id])),
    getBuffer: async (id) => `buffer of ${id}`,
    getCwd: async (id) => `/cwd/${id}`,
    search: async (q) => [{ q }],
    getSize: async (id) => (panes.has(id) ? { cols: 80, rows: 24 } : null),
  };
  registerPtyIpc({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    host,
    gate,
    prepareSpawn: async (req) => (log.push(["prepare", req.ptyId]), { ...req, command: `${req.command} --prepared` }),
    sendSpawn: async (req) => (panes.add(req.ptyId), log.push(["send", req.ptyId, req.command]), true),
    forgetBrief: async (id) => void log.push(["forget", id]),
    noteTyping: async (id, text) => void log.push(["typed", id, text]),
    confirmRestartPane: async (id) => (log.push(["confirm", id]), true),
    restartHost: async () => void log.push(["restart-host"]),
    stopOtherHosts: async () => [123],
    waiting: () => ["waiting"],
    ...over,
  });
  return { handlers, log, gate, host, panes, call: (channel, ...args) => handlers.get(channel)({}, ...args) };
}

const spawnReq = (ptyId) => ({ ptyId, command: "claude", cwd: "/tmp", cols: 80, rows: 24 });

test("registers exactly the terminal and host channels", () => {
  assert.deepEqual([...setup().handlers.keys()].sort(), [
    "agent:waiting",
    "harness:search",
    "pty-host:restart",
    "pty-host:stop-others",
    "pty:buffer",
    "pty:confirm-restart",
    "pty:cwd",
    "pty:kill",
    "pty:resize",
    "pty:search",
    "pty:spawn",
    "pty:write",
  ]);
});

test("a spawn is prepared, then sent; typing waits for it and is noted before it reaches the pane", async () => {
  const { call, log } = setup();
  const spawned = call("pty:spawn", spawnReq("a"));
  const typed = call("pty:write", "a", "hi\r");
  await Promise.all([spawned, typed]);
  assert.deepEqual(log, [
    ["prepare", "a"],
    ["send", "a", "claude --prepared"],
    ["typed", "a", "hi\r"],
    ["write", "a", "hi\r"],
  ]);
});

test("a pane closed while its spawn is prepared is not sent, and its brief is forgotten", async () => {
  let release;
  const { call, log } = setup({
    prepareSpawn: (req) => new Promise((resolve) => (release = () => resolve(req))),
  });
  const spawned = call("pty:spawn", spawnReq("b"));
  await new Promise((r) => setImmediate(r));
  await call("pty:kill", "b");
  release();
  await spawned;
  assert.equal(log.some(([what]) => what === "send"), false, "nothing sent");
  assert.deepEqual(log.filter(([what]) => what === "forget"), [["forget", "b"], ["forget", "b"]]);
});

test("closing a running pane forgets its brief and kills it", async () => {
  const { call, log } = setup();
  await call("pty:spawn", spawnReq("c"));
  await call("pty:kill", "c");
  assert.deepEqual(log.slice(-2), [["forget", "c"], ["kill", "c"]]);
});

test("buffer, cwd, search and resize go to the host; an unreachable host's buffer reads as empty", async () => {
  const { call, log } = setup();
  assert.equal(await call("pty:buffer", "d"), "buffer of d");
  assert.equal(await call("pty:cwd", "d"), "/cwd/d");
  assert.deepEqual(await call("pty:search", "q"), [{ q: "q" }]);
  await call("pty:resize", "d", 100, 30);
  assert.deepEqual(log.at(-1), ["resize", "d", 100, 30]);
  await assert.rejects(call("pty:resize", "d", 0, 30), /pty:resize\.cols/);
  const offline = setup({});
  offline.host.getBuffer = async () => { throw new Error(`x ${PTY_HOST_NOT_CONNECTED} y`); };
  assert.equal(await offline.call("pty:buffer", "d"), "");
  offline.host.getBuffer = async () => { throw new Error("disk on fire"); };
  await assert.rejects(offline.call("pty:buffer", "d"), /disk on fire/);
});

test("transcript search takes claude or codex only, with text fields", async () => {
  const { call } = setup();
  await assert.rejects(call("harness:search", null), /request must be an object/);
  await assert.rejects(call("harness:search", { agent: "grok", cwd: "/", query: "x" }), /must be 'claude' or 'codex'/);
  await assert.rejects(call("harness:search", { agent: "claude", cwd: 7, query: "x" }), /harness:search\.cwd/);
});

test("restart confirmation, host restart, stopping other hosts and waiting questions go to their deps", async () => {
  const { call, log } = setup();
  assert.equal(await call("pty:confirm-restart", "e"), true);
  await call("pty-host:restart");
  assert.deepEqual(await call("pty-host:stop-others"), [123]);
  assert.deepEqual(await call("agent:waiting"), ["waiting"]);
  assert.deepEqual(log, [["confirm", "e"], ["restart-host"]]);
});
