// A tab closed while main still prepares its spawn (a login-shell probe can take 20 s) has nothing to kill yet: nothing
// is sent to the host and the spawn never goes, since the host's kill marker would expire or eat the reopened tab.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = realpathSync(mkdtempSync(join(tmpdir(), "aya-close-spawn-")));
const cwd = join(root, "wt");
mkdirSync(cwd);
mkdirSync(join(root, "home"));
process.env.AYA_HOME = join(root, "aya-home");
process.env.HOME = join(root, "home");
process.env.SHELL = "/bin/sh";

const bin = join(root, "bin");
mkdirSync(bin);
process.env.PATH = `${bin}:${process.env.PATH}`;
let cliCount = 0;
/** A new CLI on PATH, so the host's probe for it is not cached and takes a real shell. */
function unprobedCli() {
  const name = `aya-close-cli-${++cliCount}`;
  writeFileSync(join(bin, name), "#!/bin/sh\nexec sleep \"$@\"\n", { mode: 0o755 });
  return name;
}

const { activePtyCount, getPtySize, killPty, spawnPty } = await import("../dist-electron/pty.js");
const { createSpawnGate, closePane } = await import("../dist-electron/spawn-gate.js");

const sink = { sendPtyEvent() {}, isDestroyed: () => false };
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const tick = () => new Promise((r) => setImmediate(r));
const req = (ptyId, command = "exec sleep 30") => ({ ptyId, command, cwd, cols: 80, rows: 24 });

/** What main does: prepare, then hand the request to the host. */
function world() {
  const gate = createSpawnGate();
  const hostKills = [];
  const host = {
    hasPane: async (id) => getPtySize(id) !== null,
    kill: async (id) => (hostKills.push(id), killPty(id)),
  };
  const open = (id, prep, command) => gate.spawn(id, () => prep.promise.then(() => req(id, command)), (r) => spawnPty(r, sink));
  return { gate, host, hostKills, open, close: (id) => closePane(gate, id, host) };
}

test("closed while main prepares for longer than the host's kill marker lives: no process starts", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const w = world();
    const prep = deferred();
    const spawned = w.open("late-close", prep);
    await w.close("late-close");
    mock.timers.tick(6_000);
    prep.resolve();
    await spawned;
    assert.equal(activePtyCount(), 0, "a closed tab leaves no child");
  } finally {
    mock.timers.reset();
    killPty("late-close");
  }
});

test("closed while main prepares, reopened and prepared first: the reopened tab starts, the closed one never does", async () => {
  const w = world();
  const first = deferred();
  const second = deferred();
  const closed = w.open("reopen-race", first, "echo old; exec sleep 30");
  await w.close("reopen-race");
  const reopened = w.open("reopen-race", second);
  second.resolve();
  await reopened;
  assert.notEqual(getPtySize("reopen-race"), null, "the reopened tab has its process");
  first.resolve();
  await closed;
  assert.equal(activePtyCount(), 1, "only the reopened tab's process");
  killPty("reopen-race");
});

test("closed while main prepares: the host is not asked to kill (its marker would eat the next spawn)", async () => {
  const w = world();
  const prep = deferred();
  const spawned = w.open("no-marker", prep);
  await w.close("no-marker");
  assert.deepEqual(w.hostKills, []);
  prep.resolve();
  await spawned;
  await spawnPty(req("no-marker"), sink);
  assert.notEqual(getPtySize("no-marker"), null, "a later spawn of the id is not dropped");
  killPty("no-marker");
});

const STATES = {
  "tab not opened": { setup: async () => {}, kills: true },
  "preparing in main": { setup: async (w, id) => void w.open(id, deferred()), kills: false },
  running: { setup: async (w, id) => void (await spawnPty(req(id), sink)), kills: true },
  "running, a re-mount preparing": { setup: async (w, id) => (await spawnPty(req(id), sink), void w.open(id, deferred())), kills: true },
};
for (const [state, want] of Object.entries(STATES)) {
  test(`close | ${state}`, async () => {
    const w = world();
    const id = `close-${state.replace(/\W+/g, "-")}`;
    await want.setup(w, id);
    await w.close(id);
    assert.equal(w.hostKills.length > 0, want.kills, "the host is asked to kill only when it may hold something");
    assert.equal(w.gate.spawning(id), false, "a closed pane is not starting");
    assert.equal(getPtySize(id), null, "and not running");
  });
}

test("a spawn already sent to the host is the host's to cancel: close kills it and the process never starts", async () => {
  const w = world();
  const sent = deferred();
  const spawned = w.gate.spawn("sent", async () => req("sent"), (r) => sent.promise.then(() => spawnPty(r, sink)));
  await tick();
  await w.close("sent");
  assert.deepEqual(w.hostKills, ["sent"]);
  sent.resolve();
  await spawned;
  assert.equal(getPtySize("sent"), null, "the closed pane has no process (the host drops a spawn that a kill overtook)");
  assert.equal(activePtyCount(), 0, "and no child is left behind");
});

// Two spawns of one id (the tab's own, then a re-mount: HMR, a React double-mount, a moved tab), each in one
// of its stages, then a close.
const STAGES = {
  "preparing in main": (w, id) => {
    const prep = deferred();
    const done = w.open(id, prep);
    return { sent: false, finish: async () => (prep.resolve(), await done) };
  },
  // A CLI the host has not probed yet: the request sits in the host's login-shell probe.
  "sent, the host in its preflight": async (w, id) => {
    const done = w.gate.spawn(id, async () => req(id, `${unprobedCli()} 30`), (r) => spawnPty(r, sink));
    await tick();
    return { sent: true, finish: async () => void (await done) };
  },
  running: async (_w, id) => (await spawnPty(req(id), sink), { sent: true, finish: async () => {} }),
};
for (const [first, setFirst] of Object.entries(STAGES)) {
  for (const [second, setSecond] of [["no re-mount", null], ...Object.entries(STAGES).filter(([s]) => s !== "running")]) {
    test(`close | ${first}, then ${second}`, async () => {
      const w = world();
      const id = `two-${first}-${second}`.replace(/\W+/g, "-");
      const stages = [await setFirst(w, id)];
      if (setSecond) stages.push(await setSecond(w, id));
      await w.close(id);
      assert.equal(w.hostKills.length > 0, stages.some((s) => s.sent), "the host is asked to kill exactly when something went to it");
      for (const s of stages) await s.finish();
      assert.equal(getPtySize(id), null, "no process of the closed tab is left");
      killPty(id);
    });
  }
}
