// Local servers an agent started (electron/agent-servers.ts): parsers and decisions against injected ps/lsof/ss
// output, then once for real against a tiny HTTP server this test process starts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

const { descendantsOf, parseLsofListeners, parseSsListeners, listAgentServers, stopAgentServer, localServerUrl, batchedServerLister, isShellCommand } = await import(
  "../dist-electron/agent-servers.js"
);
const { parseProcesses } = await import("../dist-electron/caller-proof.js");
const { registerAgentServersIpc } = await import("../dist-electron/ipc/agent-servers-ipc.js");

// 100 is the agent; 200 its Bash tool shell; 300 a dev server under it, with a worker 301; 400 an unrelated server.
const PS = [
  "    1     0 /sbin/launchd",
  "  100     1 claude --input-format stream-json",
  "  200   100 /bin/zsh -c npm run dev",
  "  300   200 node /work/node_modules/.bin/vite --port 5173",
  "  301   300 node worker.js",
  "  400     1 postgres -D /usr/local/var/postgres",
].join("\n");
const LSOF = "p300\nf20\nn*:5173\nf21\nn[::1]:5173\nf22\nn127.0.0.1:24678\np301\nf3\nn127.0.0.1:9229\n";

function fakeDeps(over = {}) {
  const log = [];
  const alive = new Set([100, 200, 300, 301, 400]);
  return {
    log, alive,
    deps: {
      ps: async () => PS,
      lsof: async (pids) => (log.push(["lsof", [...pids].sort((a, b) => a - b)]), LSOF),
      ss: async () => null,
      kill: (pid, sig) => { log.push([sig, pid]); if (sig === "SIGKILL" || over.obeys?.includes(pid)) alive.delete(pid); },
      alive: (pid) => alive.has(pid),
      sleep: async () => {},
      ...over.deps,
    },
  };
}

test("descendantsOf walks the tree below the root, never above or beside it", () => {
  const table = parseProcesses(PS);
  assert.deepEqual(descendantsOf(100, table).sort(), [200, 300, 301]);
  assert.deepEqual(descendantsOf(300, table), [301]);
  assert.deepEqual(descendantsOf(999, table), []);
  // A ppid cycle (a reused pid caught mid-snapshot) ends rather than looping.
  assert.deepEqual(descendantsOf(5, parseProcesses("5 6 a\n6 5 b")).sort(), [6]);
});

test("lsof field output: ports per pid, IPv4, IPv6 and wildcard, each port once", () => {
  assert.deepEqual([...parseLsofListeners(LSOF)], [[300, [5173, 24678]], [301, [9229]]]);
  assert.deepEqual([...parseLsofListeners("")], []);
  assert.deepEqual([...parseLsofListeners("p7\nnnot-a-port\n")], []);
});

test("ss output: ports per pid from the users column", () => {
  const ss = [
    'LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=300,fd=20))',
    'LISTEN 0 511 [::]:3000 [::]:* users:(("node",pid=300,fd=21),("node",pid=301,fd=21))',
    "LISTEN 0 128 127.0.0.1:631 0.0.0.0:*",
  ].join("\n");
  assert.deepEqual([...parseSsListeners(ss)], [[300, [3000]], [301, [3000]]]);
});

test("lists only the agent's descendants that listen, with command and sorted ports; lsof is asked about them only", async () => {
  const { deps, log } = fakeDeps();
  assert.deepEqual(await listAgentServers(100, deps), [
    { pid: 301, command: "node worker.js", ports: [9229] },
    { pid: 300, command: "node /work/node_modules/.bin/vite --port 5173", ports: [5173, 24678] },
  ].sort((a, b) => a.ports[0] - b.ports[0]));
  assert.deepEqual(log, [["lsof", [200, 300, 301]]]);
});

test("no agent, a gone agent or an agent without children lists nothing and runs no lsof", async () => {
  const { deps, log } = fakeDeps();
  assert.deepEqual(await listAgentServers(undefined, deps), []);
  assert.deepEqual(await listAgentServers(4242, deps), []);
  assert.deepEqual(await listAgentServers(400, deps), []);
  assert.deepEqual(await listAgentServers(100, { ...deps, ps: async () => null }), []);
  assert.deepEqual(log, []);
});

test("without lsof (Linux) the listeners come from ss, still filtered to the agent's descendants", async () => {
  const { deps } = fakeDeps({ deps: {
    lsof: async () => null,
    ss: async () => 'LISTEN 0 5 *:8000 *:* users:(("python3",pid=300,fd=3))\nLISTEN 0 5 *:5432 *:* users:(("postgres",pid=400,fd=3))',
  } });
  assert.deepEqual(await listAgentServers(100, deps), [{ pid: 300, command: "node /work/node_modules/.bin/vite --port 5173", ports: [8000] }]);
});

test("Stop sends SIGTERM to the server and its children and stops there when they exit", async () => {
  const { deps, log } = fakeDeps({ obeys: [300, 301] });
  assert.deepEqual(await stopAgentServer(100, 300, deps), { forced: false });
  assert.deepEqual(log, [["SIGTERM", 300], ["SIGTERM", 301]]);
});

test("Stop escalates to SIGKILL for what outlives the grace period", async () => {
  const { deps, log } = fakeDeps({ obeys: [301] });
  assert.deepEqual(await stopAgentServer(100, 300, deps, 300), { forced: true });
  assert.deepEqual(log, [["SIGTERM", 300], ["SIGTERM", 301], ["SIGKILL", 300]]);
});

test("Stop refuses anything that is not, right now, under the agent", async () => {
  const { deps, log } = fakeDeps();
  await assert.rejects(stopAgentServer(100, 400, deps), /no longer running under this agent/);
  await assert.rejects(stopAgentServer(100, 100, deps), /no longer running under this agent/);
  await assert.rejects(stopAgentServer(undefined, 300, deps), /agent is not running/);
  await assert.rejects(stopAgentServer(100, 1, deps), /Invalid process id/);
  await assert.rejects(stopAgentServer(100, Number.NaN, deps), /Invalid process id/);
  assert.deepEqual(log, []);
});

test("Open goes to http://localhost:<port>/, and only for a port number", () => {
  assert.equal(localServerUrl(5173), "http://localhost:5173/");
  for (const bad of [0, 65536, 1.5, "80", "80/evil", null]) assert.throws(() => localServerUrl(bad), /Invalid port/);
});

test("pty:servers lists under the pane's pid, stops through it, and never for a remote pane", async () => {
  const handlers = new Map();
  const { deps, log } = fakeDeps({ obeys: [300, 301] });
  registerAgentServersIpc({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    getPid: async (id) => (id === "pane" ? 100 : null),
    isRemote: (id) => id === "remote",
    system: deps,
  });
  const call = (...args) => handlers.get("pty:servers")({}, ...args);
  assert.deepEqual([...handlers.keys()], ["pty:servers"]);
  assert.equal((await call("pane", "list")).length, 2);
  assert.deepEqual(await call("gone", "list"), []);
  assert.deepEqual(await call("remote", "list"), []);
  await assert.rejects(call("remote", "stop", 300), /remote machine/);
  await assert.rejects(call("gone", "stop", 300), /agent is not running/);
  assert.deepEqual(await call("pane", "stop", 300), { forced: false });
  await assert.rejects(call(42, "list"), /ptyId/);
  assert.deepEqual(log.filter(([kind]) => kind.startsWith("SIG")), [["SIGTERM", 300], ["SIGTERM", 301]]);
});

test("real ps and lsof find a server this process started, and Stop ends it", { skip: process.platform === "win32" }, async () => {
  const child = spawn(process.execPath, ["-e", "require('http').createServer((q,s)=>s.end('ok')).listen(0,'127.0.0.1',function(){process.stdout.write(this.address().port+String.fromCharCode(10))})"], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    const [chunk] = await once(child.stdout, "data");
    const port = Number(String(chunk).trim());
    const servers = await listAgentServers(process.pid);
    const found = servers.find((s) => s.pid === child.pid);
    assert.ok(found, `expected pid ${child.pid} among ${JSON.stringify(servers)}`);
    assert.deepEqual(found.ports, [port]);
    assert.match(found.command, /createServer/);
    const exited = once(child, "exit");
    assert.deepEqual(await stopAgentServer(process.pid, child.pid), { forced: false });
    const [, signal] = await exited;
    assert.equal(signal, "SIGTERM");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

// A pane whose agent could not be exec'd: 500 is the pane's shell, 600 the agent CLI it runs (with its own HTTP
// server), 700 a dev server the agent started.
const SHELL_PS = [
  "  500     1 /bin/zsh -l -i -c cd /w && my-claude-launcher",
  "  600   500 opencode --port 4096",
  "  700   600 node vite",
].join("\n");

test("in a shell-rooted pane the agent CLI itself is never listed or stopped", async () => {
  const log = [];
  const deps = { ...fakeDeps().deps, ps: async () => SHELL_PS, lsof: async (pids) => (log.push([...pids].sort()), "p600\nn*:4096\np700\nn*:5173\n") };
  assert.deepEqual(await listAgentServers(500, deps), [{ pid: 700, command: "node vite", ports: [5173] }]);
  assert.deepEqual(log, [[700]]);
  await assert.rejects(stopAgentServer(500, 600, deps), /no longer running under this agent/);
  assert.equal(isShellCommand("-zsh"), true);
  assert.equal(isShellCommand("/opt/homebrew/bin/fish -c x"), true);
  assert.equal(isShellCommand("claude --resume"), false);
});

test("panes polling together share one ps and one lsof over all their processes", async () => {
  const log = [];
  const deps = { ...fakeDeps().deps, ps: async (fresh) => (log.push(["ps", !!fresh]), `${PS}\n${SHELL_PS}`), lsof: async (pids) => (log.push(["lsof", [...pids].sort((a, b) => a - b)]), `${LSOF}p700\nn*:5173\n`) };
  const list = batchedServerLister(deps, 20);
  const [a, b, none] = await Promise.all([list(100), list(500), list(undefined)]);
  assert.equal(a.length, 2);
  assert.deepEqual(b.map((s) => s.pid), [700]);
  assert.deepEqual(none, []);
  assert.deepEqual(log, [["ps", false], ["lsof", [200, 300, 301, 700]]]);
});

test("Stop reads a fresh process table and counts an unreaped (zombie) process as gone", async () => {
  const { deps, log } = fakeDeps();
  const reads = [];
  const zombieDeps = { ...deps, ps: async (fresh) => (reads.push(!!fresh), PS), zombies: async (pids) => new Set(pids) };
  let slept = 0;
  zombieDeps.sleep = async () => { slept++; };
  assert.deepEqual(await stopAgentServer(100, 300, zombieDeps), { forced: false });
  assert.deepEqual(reads, [true]);
  assert.equal(slept, 0, "no grace wait for exited processes");
  assert.deepEqual(log, [["SIGTERM", 300], ["SIGTERM", 301]]);
});
