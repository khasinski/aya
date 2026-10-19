// The one account of the terminal host's state behind Aya's launch check, the Restart Aya red dot and Diagnostics:
// what it reports, the warnings it gives, and that probing the socket never starts a host.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { gatherHostHealth, hostWarnings, probeSocketPid } = await import("../dist-electron/pty-host-health.js");
const { liveHostRecords } = await import("../dist-electron/pty-host-registry.js");

const EXPECTED = { version: "0.13.0", scriptHash: "a".repeat(64) };
const OLD = { version: "0.12.0", scriptHash: "b".repeat(64) };
const record = (pid, extra = {}) => ({
  pid,
  pgid: pid,
  version: EXPECTED.version,
  scriptHash: EXPECTED.scriptHash,
  startTime: `start-${pid}`,
  nonce: "n",
  ...extra,
});

function deps(over = {}) {
  let statusCalls = 0;
  const d = {
    expected: EXPECTED,
    connected: () => true,
    status: async () => {
      statusCalls += 1;
      return { identity: EXPECTED, ptyCount: 3, pid: 100 };
    },
    socketExists: async () => true,
    probeSocket: async () => 100,
    liveRecords: () => [record(100)],
    ...over,
  };
  return { d, calls: () => statusCalls };
}

test("a current host on its own socket with no other host: no warnings", async () => {
  const health = await gatherHostHealth(deps().d);
  assert.deepEqual(health.warnings, []);
  assert.equal(health.pid, 100);
  assert.equal(health.stale, false);
  assert.deepEqual(health.socket, { exists: true, pid: 100 });
  assert.deepEqual(health.otherHosts, []);
});

test("a host with no pty-host.sock is the 2026-10-13 state: warned, with what the next start would do", async () => {
  const health = await gatherHostHealth(deps({ socketExists: async () => false, probeSocket: async () => 999 }).d);
  assert.equal(health.socket.exists, false);
  assert.equal(health.socket.pid, null, "no probe without a socket file");
  assert.equal(health.warnings.length, 1);
  assert.match(health.warnings[0], /pid 100\) has no pty-host\.sock: the next Aya start will start a second host/);
});

test("a socket that leads to another host is named", async () => {
  const health = await gatherHostHealth(deps({ probeSocket: async () => 200, liveRecords: () => [record(100), record(200)] }).d);
  assert.deepEqual(health.otherHosts, [], "the host on the socket is not an orphan");
  assert.match(health.warnings.join("\n"), /leads to another terminal host \(pid 200\) than the one this Aya uses \(pid 100\)/);
});

test("running hosts nobody uses are listed and warned about, with the button to press", async () => {
  const health = await gatherHostHealth(deps({ liveRecords: () => [record(100), record(300), record(301)] }).d);
  assert.deepEqual(
    health.otherHosts.map((h) => h.pid),
    [300, 301],
  );
  assert.equal(health.otherHosts[0].startTime, "start-300");
  assert.match(health.warnings.join("\n"), /2 other terminal hosts still run \(pid 300, 301\): their terminals show in no window\. Stop them with Stop other hosts\./);
  const one = await gatherHostHealth(deps({ liveRecords: () => [record(100), record(300)] }).d);
  assert.match(one.warnings.join("\n"), /^1 other terminal host still runs \(pid 300\): its terminals show in no window\. Stop it with Stop other hosts\.$/m);
});

test("a stale host is warned about with its version, and drives the red dot", async () => {
  const health = await gatherHostHealth(deps({ status: async () => ({ identity: OLD, ptyCount: 1, pid: 100 }) }).d);
  assert.equal(health.stale, true);
  assert.match(health.warnings[0], /different PTY code or runtime \(0\.12\.0\)/);
});

test("no connection and no socket: the host is not asked, so none is started, and nothing is stale", async () => {
  const { d, calls } = deps({ connected: () => false, socketExists: async () => false, liveRecords: () => [] });
  const health = await gatherHostHealth(d);
  assert.equal(calls(), 0, "status() would have started a host");
  assert.equal(health.pid, null);
  assert.equal(health.stale, false);
  assert.deepEqual(health.warnings, []);
});

test("hostWarnings lists every problem at once", () => {
  const warnings = hostWarnings({
    pid: 100,
    identity: OLD,
    expected: EXPECTED,
    ptyCount: 0,
    stale: true,
    socket: { exists: false, pid: null },
    otherHosts: [{ pid: 300, startTime: "s", version: "0.12.0" }],
  });
  assert.equal(warnings.length, 3);
  assert.match(warnings[2], /^1 other terminal host still runs /);
});

test("probeSocketPid reads only kernel peer identity, never unprotected version/status", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aya-probe-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(await probeSocketPid(join(dir, "missing.sock")), null);
  for(const sendsGarbage of [false,true]){
    const endpoint=join(dir,sendsGarbage?"garbage.sock":"silent.sock");let received="";
    const server=net.createServer(socket=>{
      socket.on("data",chunk=>received+=chunk);socket.on("error",()=>{});socket.resume();
      if(sendsGarbage)socket.write("not a trusted version reply\n");
    });
    await new Promise(resolve=>server.listen(endpoint,resolve));
    assert.equal(await probeSocketPid(endpoint),process.pid);
    await new Promise(resolve=>server.close(resolve));
    assert.equal(received,"","discovery sends no RPC, proof or secret");
  }
});

test("liveHostRecords keeps only records whose pid is that host now", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aya-live-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const registry = join(dir, "pty-hosts");
  mkdirSync(registry);
  for (const rec of [record(500), record(501), record(502), record(503)]) {
    writeFileSync(join(registry, `${rec.pid}.json`), JSON.stringify(rec));
  }
  const probe = (pid) =>
    ({
      500: { alive: true, probeFailed: false, startTime: "start-500", command: "Aya /x/pty-host.js" },
      501: { alive: true, probeFailed: false, startTime: "other", command: "Aya /x/pty-host.js" }, // pid reused
      502: { alive: false, probeFailed: false, startTime: null, command: null },
      503: { alive: false, probeFailed: true, startTime: null, command: null },
    })[pid];
  assert.deepEqual(
    liveHostRecords("/app/dist-electron/pty-host.js", registry, probe).map((r) => r.pid),
    [500],
  );
});

test("an unreadable expected hash keeps the host with an indeterminate warning", async () => {
  const health = await gatherHostHealth(deps({ expected: { ...EXPECTED, scriptHash: "unknown" } }).d);
  assert.equal(health.stale, false);
  assert.equal(health.indeterminate, true);
  assert.match(health.warnings[0], /could not read.*running terminals were kept/);
});
test("a version-only change is compatible when the PTY content matches", async () => {
  const health = await gatherHostHealth(deps({ status: async () =>
    ({ identity: { ...EXPECTED, version: "0.1.0" }, ptyCount: 3, pid: 100 }) }).d);
  assert.equal(health.stale, false);
  assert.deepEqual(health.warnings, []);
});

test('disconnected recovery refusal is preserved in Diagnostics without inventing an active host',async()=>{
 const reason='Aya restarted since this terminal host started, so it cannot restart the host for these panes. Processes may still be running.';
 const health=await gatherHostHealth(deps({connected:()=>false,socketExists:async()=>false,ownerExists:()=>true,status:async()=>({identity:null,ptyCount:0,recoveryReason:reason}),probeSocket:async()=>{throw Error('no socket probe');},liveRecords:()=>[]}).d);
 assert.equal(health.pid,null);assert.equal(health.recoveryReason,reason);assert.ok(health.warnings.includes(reason));
});

test("an authentication refusal remains stale with a truthful unknown-inventory warning",async()=>{
 const authentication={required:true,inventoryKnown:false,targetVerified:true,reason:"Aya could not authenticate to the terminal host. Its processes were kept."};
 const health=await gatherHostHealth({expected:EXPECTED,connected:()=>false,status:async()=>({identity:null,pid:1234,ptyCount:0,authentication}),socketExists:async()=>true,probeSocket:async()=>1234,liveRecords:()=>[]});
 assert.equal(health.stale,true);assert.deepEqual(health.authentication,authentication);assert.ok(health.warnings.includes(authentication.reason));assert.ok(health.warnings.some(w=>w.includes("processes are unknown")));assert.ok(!health.warnings.some(w=>w.includes("runs different PTY code")));
});
