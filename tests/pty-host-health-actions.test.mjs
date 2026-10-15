// Host health and stale-host actions against stand-in hosts, dialogs, menus and process operations.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const home = mkdtempSync(join(tmpdir(), "aya-health-actions-"));
const oldHome = process.env.AYA_HOME;
process.env.AYA_HOME = home;
after(() => {
  if (oldHome === undefined) delete process.env.AYA_HOME;
  else process.env.AYA_HOME = oldHome;
  rmSync(home, { recursive: true, force: true });
});
const { createPtyHostHealth } = await import("../dist-electron/pty-host-health.js");

const EXPECTED = { version: "0.13.0", scriptHash: "a".repeat(64) };
const OLD = { version: "0.12.0", scriptHash: "b".repeat(64) };
const record = (pid) => ({ pid, startTime: `start-${pid}`, version: EXPECTED.version });

function setup(t, over = {}) {
  const dir = mkdtempSync(join(home, "case-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const mainDirname = join(dir, "dist-electron");
  mkdirSync(mainDirname);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: EXPECTED.version }));
  const log = [];
  const item = { icon: "initial" };
  const state = {
    expected: EXPECTED, identity: EXPECTED, connected: true, socketExists: true, socketPid: 100,
    records: [record(100)], parent: null, response: 0, restartAnswer: true,
    confirmAnswer: true, askAnswer: true, menuInstalled: true,
    owner: { pid: 99, incompatible: false, disconnected: [] },
  };
  const d = {
    app: { getVersion: () => (log.push(["app-version"]), "electron-version") },
    mainDirname,
    ptyHost: {
      expectedHostIdentity: (version) => (log.push(["expected", version]), { ...state.expected, version }),
      isConnected: () => state.connected,
      hostStatus: async () => (log.push(["status"]), { identity: state.identity, ptyCount: 3, pid: 100, ...(state.owner ? { owner: state.owner } : {}) }),
      restart: async () => {
        log.push(["restart"]);
        state.identity = EXPECTED;
        return state.restartAnswer;
      },
    },
    relaunchDeps: {
      file: join(dir, "relaunch-notes.json"),
      panes: async () => [],
      agentOf: async () => "claude",
      screen: async () => `${"\u2500".repeat(8)}\n1 monitor`,
      pid: async () => 123,
      command: async () => "claude --resume",
      busy: async () => false,
      foreground: async () => null,
    },
    askRestart: async (yes, text) => (log.push(["ask-restart", yes, text]), state.askAnswer),
    confirmLosingWork: async (action, yes) => (log.push(["confirm", action, yes]), state.confirmAnswer),
    focusedAyaWindow: () => state.parent,
    dialog: { showMessageBox: async (...args) => (log.push(["dialog", ...args]), { response: state.response }) },
    Menu: { getApplicationMenu: () => state.menuInstalled ? {
      getMenuItemById: (id) => (assert.equal(id, "restart-aya"), item),
    } : null },
    nativeImage: { createEmpty: () => (log.push(["empty-icon"]), "empty") },
    setStaleMenuIcon: () => { log.push(["stale-icon"]); if (state.menuInstalled) item.icon = "stale"; },
    socketExists: async () => (log.push(["socket-exists"]), state.socketExists),
    probeSocket: async () => (log.push(["probe"]), state.socketPid),
    liveRecords: () => (log.push(["records"]), state.records),
    kill: (pid, signal) => { log.push(["kill", pid, signal]); state.records = state.records.filter((r) => r.pid !== pid); },
    waitForExit: async (pid, ms) => (log.push(["wait", pid, ms]), true),
    ...over,
  };
  return { d, dir, log, state, item, actions: createPtyHostHealth(d) };
}

const operations = (log) => log.filter(([op]) => ["dialog", "kill", "wait", "restart", "ask-restart", "confirm"].includes(op));

test("expected version is read once from the host's package, with Electron's version only as a fallback", (t) => {
  const { d, dir, log, actions } = setup(t);
  assert.equal(actions.EXPECTED_HOST_VERSION, EXPECTED.version);
  assert.deepEqual(log, [], "Electron's version is not the development host version");
  for (const contents of ['{"version":42}', "not json", "null"]) {
    writeFileSync(join(dir, "package.json"), contents);
    assert.equal(createPtyHostHealth(d).EXPECTED_HOST_VERSION, "electron-version");
  }
  rmSync(join(dir, "package.json"));
  assert.equal(createPtyHostHealth(d).EXPECTED_HOST_VERSION, "electron-version");
  assert.equal(actions.EXPECTED_HOST_VERSION, EXPECTED.version, "the initial version stays fixed");
  assert.equal(log.length, 4);
});

test("health preserves probe order and the menu getter follows stale and current reports", async (t) => {
  const { actions, state, log, item } = setup(t);
  const getter = actions.staleHostDetected;
  assert.equal(getter(), false);
  state.identity = OLD;
  const health = await actions.hostHealth();
  assert.equal(health.stale, true);
  assert.deepEqual(log, [["expected", EXPECTED.version], ["socket-exists"], ["status"], ["probe"], ["records"], ["stale-icon"]]);
  assert.equal(getter(), true);
  assert.equal(item.icon, "stale");
  state.identity = EXPECTED;
  await actions.hostHealth();
  assert.equal(getter(), false);
  assert.equal(item.icon, "empty");
});

test("launch without a connection or socket starts no host, and tolerates a menu not installed yet", async (t) => {
  const { actions, state, log } = setup(t);
  Object.assign(state, { connected: false, socketExists: false, records: [], menuInstalled: false });
  await actions.handleStaleHost();
  assert.deepEqual(log, [["expected", EXPECTED.version], ["socket-exists"], ["records"]]);
  assert.equal(actions.staleHostDetected(), false);
});

test("launch stops unreachable hosts before the stale connected host, then checks health again", async (t) => {
  const { actions, state, log, item } = setup(t);
  state.identity = OLD;
  state.records.push(record(300));
  await actions.handleStaleHost();
  assert.deepEqual(operations(log), [
    ["dialog", {
      type: "warning", buttons: ["Stop", "Cancel"], defaultId: 1, cancelId: 1,
      message: "Stop the other terminal host?",
      detail: "Aya found another terminal host still running from before. Their terminals show in no window, and Aya would resume those agents again in its own host. Stopping ends them.",
    }],
    ["kill", 300, "SIGTERM"], ["wait", 300, 5000], ["restart"],
  ]);
  assert.equal(log.filter(([op]) => op === "status").length, 3);
  assert.equal(actions.staleHostDetected(), false);
  assert.equal(item.icon, "empty");
});

test("launch asks before stopping background work and a refusal keeps the host and red dot", async (t) => {
  const { actions, d, state, log } = setup(t);
  state.identity = OLD;
  state.askAnswer = false;
  d.relaunchDeps.panes = async () => [{ id: "pane", name: "Agent" }];
  await actions.handleStaleHost();
  const ops = operations(log);
  assert.equal(ops.length, 1);
  assert.equal(ops[0][0], "ask-restart");
  assert.equal(ops[0][1], "Restart terminals");
  assert.equal(ops[0][2], "Restarting the terminals for Aya's updated terminal host stops what these panes are doing (Agent: 1 monitor). An agent cannot carry its background tasks into the new process; Aya tells a team agent resumed afterwards to start again the ones it still needs.");
  assert.equal(actions.staleHostDetected(), true);
});

test("launch acceptance notes background work before restarting and clears the stale flag afterwards", async (t) => {
  const { actions, d, state, log } = setup(t);
  state.identity = OLD;
  d.relaunchDeps.panes = async () => [{ id: "pane", name: "Agent" }];
  const restart = d.ptyHost.restart;
  d.ptyHost.restart = async () => {
    const notes = JSON.parse(readFileSync(d.relaunchDeps.file, "utf8"));
    assert.equal(notes.pane.pid, 123);
    assert.equal(notes.pane.work, "1 monitor");
    return restart();
  };
  await actions.handleStaleHost();
  assert.deepEqual(operations(log).map(([op]) => op), ["ask-restart", "restart"]);
  assert.equal(actions.staleHostDetected(), false);
});

for (const secondIdentity of [EXPECTED, null]) {
  test(`launch re-probes an unknown identity once after 1000 ms: ${secondIdentity ? "current host is kept" : "ancient host is restarted"}`, async (t) => {
    const { actions, d, state, log } = setup(t);
    let calls = 0;
    d.ptyHost.hostStatus = async () => {
      log.push(["status"]);
      return { identity: ++calls === 1 ? null : state.identity, ptyCount: 0, pid: 100 };
    };
    state.identity = secondIdentity;
    const timers = [];
    t.mock.method(globalThis, "setTimeout", (callback, ms) => { timers.push(ms); queueMicrotask(callback); });
    await actions.handleStaleHost();
    assert.deepEqual(timers, [1000]);
    assert.equal(calls, secondIdentity ? 2 : 3);
    assert.equal(operations(log).filter(([op]) => op === "restart").length, secondIdentity ? 0 : 1);
    assert.equal(actions.staleHostDetected(), false);
  });
}

for (const failure of ["restart returned false", "same stale identity still answers"]) {
  test(`launch keeps the red dot when ${failure}`, async (t) => {
    const { actions, d, state, item } = setup(t);
    state.identity = OLD;
    if (failure === "restart returned false") state.restartAnswer = false;
    else d.ptyHost.restart = async () => true;
    await actions.handleStaleHost();
    assert.equal(actions.staleHostDetected(), true);
    assert.equal(item.icon, "stale");
  });
}

test("launch health errors are best effort while an explicit health request still rejects", async (t) => {
  const { actions } = setup(t, { socketExists: async () => { throw new Error("probe failed"); } });
  await actions.handleStaleHost();
  await assert.rejects(actions.hostHealth(), /probe failed/);
});

test("Settings restart cancellation leaves the host alone; acceptance restarts before refreshing health", async (t) => {
  const { actions, state, log } = setup(t);
  state.confirmAnswer = false;
  await assert.rejects(actions.restartHostFromWindow(), { message: "restart cancelled" });
  assert.deepEqual(operations(log), [["confirm", "Restarting the PTY host", "Restart"]]);
  log.length = 0;
  state.confirmAnswer = true;
  await actions.restartHostFromWindow();
  assert.deepEqual(operations(log), [["confirm", "Restarting the PTY host", "Restart"], ["restart"]]);
  assert.ok(log.slice(log.findIndex(([op]) => op === "restart") + 1).some(([op]) => op === "status"));
  assert.equal(actions.staleHostDetected(), false);
});

test("Settings reports a host that did not exit with the unchanged error and red dot", async (t) => {
  const { actions, state, item } = setup(t);
  state.restartAnswer = false;
  await assert.rejects(actions.restartHostFromWindow(), {
    message: "The old terminal host did not exit within 5 s; its terminals may still run. Settings > Diagnostics lists it, with Stop other hosts.",
  });
  assert.equal(actions.staleHostDetected(), true);
  assert.equal(item.icon, "stale");
});

test("Settings with no other hosts does not ask; cancelling a parented plural dialog signals nothing", async (t) => {
  const { actions, state, log } = setup(t);
  assert.deepEqual(await actions.stopOtherHostsFromWindow(), []);
  assert.deepEqual(operations(log), []);
  state.parent = { id: 7 };
  state.response = 1;
  state.records.push(record(300), record(301));
  assert.deepEqual(await actions.stopOtherHostsFromWindow(), []);
  assert.deepEqual(operations(log), [["dialog", state.parent, {
    type: "warning", buttons: ["Stop", "Cancel"], defaultId: 1, cancelId: 1,
    message: "Stop 2 other terminal hosts?",
    detail: "Settings found 2 other terminal hosts still running from before. Their terminals show in no window, and Aya would resume those agents again in its own host. Stopping ends them.",
  }]]);
});

test("Settings re-verifies hosts after asking, skips failed signals, and waits for every signalled pid", async (t) => {
  const { d, state, log } = setup(t);
  state.socketPid = 200;
  state.records.push(record(200), record(300), record(301), record(302), record(303));
  d.dialog.showMessageBox = async (...args) => {
    log.push(["dialog", ...args]);
    state.records = state.records.filter((r) => r.pid !== 300);
    return { response: 0 };
  };
  d.kill = (pid, signal) => {
    log.push(["kill", pid, signal]);
    if (pid === 301) throw new Error("already gone");
  };
  // kill and wait are captured by the factory, so construct it with these stand-ins.
  const releases = new Map();
  d.waitForExit = (pid, ms) => {
    log.push(["wait", pid, ms]);
    return new Promise((resolve) => releases.set(pid, resolve));
  };
  const wired = createPtyHostHealth(d);
  let finished = false;
  const stopping = wired.stopOtherHostsFromWindow().then((pids) => (finished = true, pids));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(operations(log).filter(([op]) => op !== "dialog"), [
    ["kill", 301, "SIGTERM"], ["kill", 302, "SIGTERM"], ["kill", 303, "SIGTERM"],
    ["wait", 302, 5000], ["wait", 303, 5000],
  ]);
  releases.get(302)(false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  releases.get(303)(true);
  assert.deepEqual(await stopping, [302, 303], "the existing result lists signals sent, even if an exit wait times out");
  assert.equal(wired.staleHostDetected(), false);
});

test("an unreadable expected hash keeps the red dot and never asks, restarts or kills on launch", async (t) => {
  const { actions, state, log, item } = setup(t);
  state.expected = { ...EXPECTED, scriptHash: "unknown" };
  state.identity = OLD;
  state.records.push(record(200));
  await actions.handleStaleHost();
  assert.equal(actions.staleHostDetected(), true);
  assert.equal(item.icon, "stale");
  assert.deepEqual(operations(log), []);
});

for (const migration of ["legacy", "incompatible owner"]) for (const accepted of [false, true]) {
  test(`${migration} asks before stopping processes even without a readable busy screen: ${accepted ? "confirm" : "Cancel"}`, async (t) => {
    const { actions, state, log } = setup(t);
    state.identity = migration === "legacy" ? OLD : EXPECTED;
    state.owner = migration === "legacy" ? undefined : { pid: 99, incompatible: true, disconnected: ["pane"] };
    state.askAnswer = accepted;
    await actions.handleStaleHost();
    const asks = operations(log).filter(([op]) => op === "ask-restart");
    assert.equal(asks.length, 1);
    assert.match(asks[0][2], migration === "legacy" ? /cannot be moved from the older host/ : /stops every terminal it owns/);
    assert.equal(operations(log).filter(([op]) => op === "restart").length, accepted ? 1 : 0);
    if (!accepted) assert.equal(actions.staleHostDetected(), true);
  });
}

test("Settings disconnected-owner recovery asks once and Cancel never sends shutdown", async (t) => {
  const { actions, state, log } = setup(t);
  state.owner = { pid: 99, incompatible: false, disconnected: ["pane"] }; state.askAnswer = false;
  await assert.rejects(actions.restartHostFromWindow(), /restart cancelled/);
  assert.equal(operations(log).filter(([op]) => op === "ask-restart").length, 1);
  assert.equal(operations(log).filter(([op]) => ["confirm", "restart", "kill"].includes(op)).length, 0);
});
