// A pane's life as main sees it x what a team asks of it (hold, alive).

import { test } from "node:test";
import assert from "node:assert/strict";

const { createSpawnGate } = await import("../dist-electron/spawn-gate.js");
const { withSpawnHolds, withLaunchHolds } = await import("../dist-electron/team-control.js");
const { paneAliveOf } = await import("../dist-electron/team-panes.js");
const { HOLD_NOT_RUNNING, HOLD_STARTING } = await import("../dist-electron/pane-holds.js");

const never = () => new Promise(() => {});

/** The host as pty-host.ts answers: a pty it holds reads its screen, one in its own preflight is starting, any other is not running. */
function host() {
  const h = { ptys: new Set(), preflight: new Set() };
  h.hold = async (id) => (h.preflight.has(id) ? HOLD_STARTING : h.ptys.has(id) ? null : HOLD_NOT_RUNNING);
  h.size = async (id) => (h.ptys.has(id) ? { cols: 80, rows: 24, alt: false } : null);
  return h;
}

/** Each state of the pane `p`; `enter` drives the real gate and the fake host into it. */
const STATES = {
  "tab not opened": { hold: HOLD_NOT_RUNNING, alive: false, enter: () => {} },
  "spawn in main (brief, lookup, host connect)": { hold: HOLD_STARTING, alive: true, enter: (h, gate) => void gate.spawn("p", never) },
  "spawn in the host's preflight": { hold: HOLD_STARTING, alive: true, enter: (h) => h.preflight.add("p") },
  running: { hold: null, alive: true, enter: (h) => h.ptys.add("p") },
  exited: { hold: HOLD_NOT_RUNNING, alive: false, enter: (h) => (h.ptys.add("p"), h.ptys.delete("p")) },
  "respawned after exiting": { hold: HOLD_STARTING, alive: true, enter: (h, gate) => (h.ptys.add("p"), h.ptys.delete("p"), void gate.spawn("p", never)) },
};

function chain(state) {
  const h = host();
  const gate = createSpawnGate();
  STATES[state].enter(h, gate);
  const hold = withLaunchHolds(withSpawnHolds(h.hold, (id) => gate.spawning(id)), async () => null);
  return { h, gate, hold, alive: paneAliveOf(h.size, hold) };
}

for (const state of Object.keys(STATES)) {
  test(`hold and alive | ${state}`, async () => {
    const w = chain(state);
    assert.equal(await w.hold("p"), STATES[state].hold);
    assert.equal(await w.alive("p"), STATES[state].alive);
  });
}

test("a spawn that settles (the pane exited meanwhile or never started) is no longer starting", async () => {
  const gate = createSpawnGate();
  await gate.spawn("p", async () => {});
  await gate.afterSpawn("p");
  assert.equal(gate.spawning("p"), false);
  const hold = withSpawnHolds(host().hold, (id) => gate.spawning(id));
  assert.equal(await hold("p"), HOLD_NOT_RUNNING);
});

test("only the pane whose spawn is in main is starting; its neighbour is not", async () => {
  const gate = createSpawnGate();
  void gate.spawn("p", never);
  const hold = withSpawnHolds(host().hold, (id) => gate.spawning(id));
  assert.deepEqual([await hold("p"), await hold("q")], [HOLD_STARTING, HOLD_NOT_RUNNING]);
});

test("a running pane whose spawn promise is still unsettled keeps reading its screen", async () => {
  const h = host();
  h.ptys.add("p");
  const gate = createSpawnGate();
  void gate.spawn("p", never);
  assert.equal(await withSpawnHolds(h.hold, (id) => gate.spawning(id))("p"), null);
});
