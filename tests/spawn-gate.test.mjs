// The host drops a write for a pty it has not seen spawn, so a pane's first keystrokes wait for the spawn of
// its own pane (and only it).

import { test } from "node:test";
import assert from "node:assert/strict";

const { createSpawnGate } = await import("../dist-electron/spawn-gate.js");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

test("a write for a pane waits until its spawn has reached the host", async () => {
  const gate = createSpawnGate();
  const hostSeen = [];
  const slow = deferred();
  const spawned = gate.spawn("p1", async () => {
    await slow.promise;
    hostSeen.push("spawn");
  });
  const written = gate.afterSpawn("p1").then(() => hostSeen.push("write"));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(hostSeen, []);
  slow.resolve();
  await Promise.all([spawned, written]);
  assert.deepEqual(hostSeen, ["spawn", "write"]);
});

test("writes keep their order behind one spawn, and a later write does not overtake them", async () => {
  const gate = createSpawnGate();
  const slow = deferred();
  const seen = [];
  void gate.spawn("p1", () => slow.promise);
  const first = gate.afterSpawn("p1").then(() => seen.push(1));
  const second = gate.afterSpawn("p1").then(() => seen.push(2));
  slow.resolve();
  await Promise.all([first, second]);
  await gate.afterSpawn("p1").then(() => seen.push(3));
  assert.deepEqual(seen, [1, 2, 3]);
});

test("another pane's write does not wait, and a failed spawn still lets the write through", async () => {
  const gate = createSpawnGate();
  const slow = deferred();
  const failing = gate.spawn("p1", () => slow.promise);
  let other = false;
  await gate.afterSpawn("p2").then(() => (other = true));
  assert.equal(other, true);
  const after = gate.afterSpawn("p1");
  slow.reject(new Error("boom"));
  await assert.rejects(failing, /boom/);
  await after;
});

test("a pane with no spawn in flight is not held, and the gate forgets a settled spawn", async () => {
  const gate = createSpawnGate();
  await gate.spawn("p1", async () => {});
  await gate.afterSpawn("p1");
  assert.equal(gate.inFlight(), 0);
});

test("a write waiting on a spawn also waits for a respawn of the same pane id that started meanwhile", async () => {
  const gate = createSpawnGate();
  const first = deferred();
  const second = deferred();
  const seen = [];
  void gate.spawn("p1", async () => {
    await first.promise;
    seen.push("spawn 1");
  });
  const written = gate.afterSpawn("p1").then(() => seen.push("write"));
  void gate.spawn("p1", async () => {
    await second.promise;
    seen.push("spawn 2");
  });
  first.resolve();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, ["spawn 1"], "the write is not released while the new flight is in preflight");
  second.resolve();
  await written;
  assert.deepEqual(seen, ["spawn 1", "spawn 2", "write"]);
  assert.equal(gate.inFlight(), 0);
});

test("a write waits for the LAST of several respawns, each started while it was already waiting", async () => {
  const gate = createSpawnGate();
  const flights = [deferred(), deferred(), deferred()];
  const seen = [];
  const tick = () => new Promise((r) => setImmediate(r));
  const start = (n) => void gate.spawn("p1", () => flights[n].promise.then(() => seen.push(`spawn ${n + 1}`)));
  start(0);
  const written = gate.afterSpawn("p1").then(() => seen.push("write"));
  start(1);
  flights[0].resolve();
  await tick();
  start(2);
  flights[1].resolve();
  await tick();
  assert.deepEqual(seen, ["spawn 1", "spawn 2"], "released while the third spawn is in flight");
  flights[2].resolve();
  await written;
  assert.deepEqual(seen, ["spawn 1", "spawn 2", "spawn 3", "write"]);
  assert.equal(gate.inFlight(), 0);
});
