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
    "pty-host:retry-recovery",
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
  assert.deepEqual(log.slice(-2), [["kill", "c"], ["forget", "c"]]);
});
test("a refused kill keeps its live pane and brief record", async () => {
  const { call, log, host, panes } = setup();
  await call("pty:spawn", spawnReq("kept"));
  host.kill = async () => { throw new Error("owner identity could not be confirmed"); };
  await assert.rejects(call("pty:kill", "kept"), /identity could not be confirmed/);
  assert.equal(panes.has("kept"), true);
  assert.equal(log.some(([op]) => op === "forget"), false);
});

test("successful kill and explicit fresh spawn invalidate only their pane's display",async()=>{
  const forgotten=[];
  const {call,host}=setup({forgetDisplay:id=>forgotten.push(id)});
  await call('pty:spawn',spawnReq('p'));
  assert.deepEqual(forgotten,['p']);forgotten.length=0;
  await call('pty:spawn',{...spawnReq('p'),attachOnly:true});
  await call('pty:spawn',{...spawnReq('p'),attachIfReused:true});
  await call('pty:spawn',{...spawnReq('p'),replayAfter:{generation:'g',offset:0,token:'t'}});
  assert.deepEqual(forgotten,[],'reattach preserves unapplied display');
  await call('pty:kill','p');assert.deepEqual(forgotten,['p']);forgotten.length=0;
  host.kill=async()=>{throw Error('refused');};
  await assert.rejects(call('pty:kill','kept'),/refused/);
  assert.deepEqual(forgotten,[],'refused stop retains its display');
});
for(const attachOnly of [true,false])test(`closing an ended restored pane during ${attachOnly?'attach':'fresh'} main preparation still releases its host record`,async()=>{
 let release;
 const displays=new Set(['ended']);
 const {call,log}=setup({hasDisplay:id=>displays.has(id),forgetDisplay:id=>displays.delete(id),prepareSpawn:req=>new Promise(resolve=>{release=()=>resolve(req);})});
 const spawn=call('pty:spawn',{...spawnReq('ended'),attachOnly});
 assert.equal(displays.has('ended'),true,'preparation retains cleanup authority');
 await call('pty:kill','ended');release();await spawn;
 assert.ok(log.some(([operation,id])=>operation==='kill'&&id==='ended'));
 assert.equal(log.some(([operation])=>operation==='send'),false);
 assert.equal(displays.has('ended'),false);
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

test("writes to one pane keep their order behind a slow check; another pane does not wait", async () => {
  let releaseFirst;
  const { call, log } = setup({
    noteTyping: async (id, text) => {
      log.push(["typed", id, text]);
      // The Enter that may answer a waiting agent: its check takes a while.
      if (text === "\r") await new Promise((resolve) => (releaseFirst = resolve));
    },
  });
  const enter = call("pty:write", "p", "\r");
  const next = call("pty:write", "p", "ls");
  const other = call("pty:write", "q", "x");
  await other;
  assert.deepEqual(log.filter(([what]) => what === "write"), [["write", "q", "x"]], "the other pane went ahead");
  releaseFirst();
  await Promise.all([enter, next]);
  assert.deepEqual(
    log.filter(([what, id]) => what === "write" && id === "p").map(([, , text]) => text),
    ["\r", "ls"],
    "the keys typed after the Enter did not overtake it",
  );
});

 test('manual crash retry reaches the main-owned supervisor and defaults to refusal when unavailable',async()=>{
  let attempts=0;const fixture=setup({retryRecovery:async()=>{attempts++;return true;}});
  assert.equal(await fixture.call('pty-host:retry-recovery'),true);assert.equal(attempts,1);
  assert.equal(await setup().call('pty-host:retry-recovery'),false);
 });
