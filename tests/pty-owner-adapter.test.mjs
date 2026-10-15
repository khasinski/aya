import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
fs.mkdirSync("test-results", { recursive: true });
const home = fs.mkdtempSync(path.resolve("test-results/adapter-"));
process.env.AYA_HOME = home;
const { OwnerPty } = await import("../dist-electron/pty-owner-adapter.js");
const { getOwnerRuntime, shutdownOwnerRuntime } = await import("../dist-electron/pty-owner-runtime.js");
const { shellSpec, sleep } = await import("./helpers/pty-owner.mjs");
function spec(id, script) { return { ...shellSpec(home, id), ...(script ? { argv: ["sh", "-c", script] } : {}) }; }
async function waitFor(predicate) { for (let i = 0; i < 5000; i++) { if (predicate()) return; await sleep(2); } assert.fail("Adapter timed out"); }
test("owner adapter preserves UTF-8, ordered input/resize and real exit while retaining the native parent", async () => {
  const p = await OwnerPty.spawn(spec("adapter"));
  let output = ""; p.onData(chunk => { output += chunk; });
  const exited = new Promise(resolve => p.onExit(resolve));
  await waitFor(() => output.includes(`START:${p.pid}`));
  await p.writeAsync("first\n"); p.resize(101, 39); await p.writeAsync("size\nsecond-é\n");
  await waitFor(() => output.includes(`R:${p.pid}:second-é`));
  assert.ok(output.indexOf(`R:${p.pid}:first`) < output.indexOf(`SIZE:${p.pid}:39 101`));
  await p.writeAsync("quit\n"); assert.equal((await exited).exitCode, 23);
  assert.ok(output.includes(`EXIT:${p.pid}`)); await p.closed;
});
test("owner adapter delivers a fast child's output before its real exit event", async () => {
  const p = await OwnerPty.spawn(spec("fast", "printf 'FAST-OUTPUT'; exit 23"));
  const order = []; p.onData(chunk => order.push(chunk));
  const exit = await new Promise(resolve => p.onExit(event => { order.push("EXIT"); resolve(event); }));
  assert.equal(exit.exitCode, 23); assert.equal(order.slice(0, -1).join(""), "FAST-OUTPUT");
  assert.equal(order.at(-1), "EXIT"); await p.closed;
});
test.after(async () => { await shutdownOwnerRuntime(); fs.rmSync(home, { recursive: true, force: true }); });

test("owner adapter excludes duplicate spawn and a second reader, then reports node-pty signal semantics", async () => {
  const attempts = await Promise.allSettled([OwnerPty.spawn(spec("duplicate")), OwnerPty.spawn(spec("duplicate"))]);
  assert.equal(attempts.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(attempts.filter(r => r.status === "rejected").length, 1);
  const p = attempts.find(r => r.status === "fulfilled").value;
  const { OwnerRuntime } = await import("../dist-electron/pty-owner-runtime.js");
  await assert.rejects(OwnerRuntime.open(), /owns the lease/);
  let output = ""; p.onData(chunk => { output += chunk; });
  await waitFor(() => output.includes(`START:${p.pid}`));
  const exited = new Promise(resolve => p.onExit(resolve));
  p.kill("SIGKILL"); const exit = await exited;
  assert.equal(exit.exitCode, 0, "IPty uses exitCode=0 plus signal for a signalled process"); assert.equal(exit.signal, 9);
  await p.closed;
});

test("25 owner adapters release both native masters and JS reader descriptors after kill", async () => {
  const owner = await getOwnerRuntime();
  // Keep the same empty owner alive long enough to compare its FD baseline.
  owner.beginSpawn();
  const count = pid => process.platform === "linux" ? fs.readdirSync(`/proc/${pid}/fd`).length
    : execFileSync("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), "-Ff"], { encoding: "utf8" }).split("\n").filter(line => /^f\d+$/.test(line)).length;
  const panes = [];
  try {
    await sleep(25);
    const nativeBefore = count(owner.record.pid), jsBefore = count(process.pid);
    for (let i = 0; i < 25; i++) { const p = await OwnerPty.spawn(spec(`fd-${i}`)); p.onData(() => {}); panes.push(p); }
    assert.equal(count(owner.record.pid), nativeBefore + 25);
    assert.ok(count(process.pid) >= jsBefore + 25);
    for (const p of panes) p.kill();
    await Promise.all(panes.map(p => p.closed));
    await waitFor(() => count(process.pid) === jsBefore);
    assert.equal(count(owner.record.pid), nativeBefore);
    assert.equal((await owner.client.list()).filter(pane => !pane.acknowledged).length, 0);
  } finally {
    for (const p of panes) p.kill("SIGKILL");
    owner.endSpawn();
  }
});

test("handover aborts a bounded blocked-input drain without stopping another pane or retrying the paste", {timeout: 15000}, async () => {
  const p = await OwnerPty.spawn(spec("drain-barrier", "stty raw -echo; printf 'READY'; while [ ! -f \"$HOME/input-release\" ]; do sleep 0.01; done; dd bs=1 count=1048576 of=/dev/null 2>/dev/null; printf 'DRAINED'; exit 23"));
  const second = await OwnerPty.spawn(spec("drain-peer"));
  let output = "", peerOutput = "";
  p.onData(s => { output += s; }); second.onData(s => { peerOutput += s; });
  const exit = new Promise(resolve => p.onExit(resolve));
  let pending;
  try {
    await waitFor(() => output.includes("READY") && peerOutput.includes(`START:${second.pid}`));
    pending = p.writeAsync("x".repeat(1024 * 1024)); void pending.catch(() => {});
    await assert.rejects(p.freezeForHandover(20), /input did not drain/);
    await second.writeAsync("still\n"); await waitFor(() => peerOutput.includes(`R:${second.pid}:still`));
    assert.equal(output.includes("DRAINED"), false, "the unreleased child still cannot consume the pending input");
    fs.writeFileSync(path.join(home, "input-release"), "go");
    await pending; assert.equal((await exit).exitCode, 23); await p.closed;
    assert.equal(output.split("DRAINED").length - 1, 1);
  } finally {
    p.resumeAfterHandoverAbort(); p.kill("SIGKILL"); second.kill("SIGKILL");
    await Promise.all([p.closed, second.closed]);
  }
});

test("a lost spawn acknowledgement retains an uncertain live pane and blocks retry until explicit shutdown", async (t) => {
  const owner = await getOwnerRuntime(), spawn = owner.client.spawn.bind(owner.client);
  let child;
  t.mock.method(owner.client, "spawn", async request => {
    child = await spawn(request); owner.client.close(); throw new Error("Lost after native spawn, before its acknowledgement");
  });
  await assert.rejects(OwnerPty.spawn(spec("uncertain", "sleep 30")), /Lost after native spawn/);
  assert.equal(owner.incompatible, true); assert.deepEqual(owner.record.uncertain, ["uncertain"]);
  assert.doesNotThrow(() => process.kill(child.pid, 0), "the uncertain process must not be killed by an empty-inventory idle timer");
  await sleep(300); assert.doesNotThrow(() => process.kill(child.pid, 0));
  await assert.rejects(OwnerPty.spawn(spec("uncertain")), /disconnected or incompatible/);
  await owner.shutdown(); assert.throws(() => process.kill(child.pid, 0), /ESRCH/);
});
