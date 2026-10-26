import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testHome = mkdtempSync(join(tmpdir(), "aya-update-spawn-"));
const oldHome = process.env.HOME;
const oldAyaHome = process.env.AYA_HOME;
process.env.HOME = testHome;
process.env.AYA_HOME = join(testHome, "aya");

const { UPDATE_SPAWN_REFUSAL, userFacingSpawnError } = await import("../dist-electron/update-spawn.js");
const { UPDATE_SPAWN_REFUSAL: rendererRefusal, displayIpcError } = await import("../dist-test/update-spawn.js");
const { registerPtyIpc } = await import("../dist-electron/ipc/pty-ipc.js");
const { createSpawnGate } = await import("../dist-electron/spawn-gate.js");
const { createUpdates } = await import("../dist-electron/updates.js");

test.after(() => {
  rmSync(testHome, { recursive: true, force: true });
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldAyaHome === undefined) delete process.env.AYA_HOME;
  else process.env.AYA_HOME = oldAyaHome;
});

test("the pane shows only the friendly update refusal", () => {
  assert.equal(rendererRefusal, UPDATE_SPAWN_REFUSAL);
  assert.equal(displayIpcError(new Error(`Error invoking remote method 'pty:spawn': Error: ${UPDATE_SPAWN_REFUSAL}`)), UPDATE_SPAWN_REFUSAL);
});

const sources = [
  ["New terminal", { ptyId: "new-terminal" }],
  ["remote pane", { ptyId: "remote-pane", projectSlug: "remote-project" }],
  ["team pane", { ptyId: "team-pane", teamLaunch: true }],
  // A restart is another explicit pty:spawn for the existing terminal id.
  ["Restart", { ptyId: "restart-existing" }],
];

function registeredSpawner({ isPreparing = () => false, prepareSpawn = async (req) => req } = {}) {
  const handlers = new Map();
  const panes = new Set();
  const sends = [];
  registerPtyIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    host: {
      write: async () => true, resize: async () => {}, kill: async (id) => panes.delete(id),
      getBuffer: async () => "", getCwd: async () => null, search: async () => [], getSize: async (id) => panes.has(id) ? { cols: 80, rows: 24 } : null,
    },
    gate: createSpawnGate(),
    prepareSpawn,
    assertSpawnAllowed: () => {
      if (isPreparing()) throw new Error(UPDATE_SPAWN_REFUSAL);
    },
    sendSpawn: async (req) => {
      sends.push(req.projectSlug === "remote-project" ? "remote" : "local");
      panes.add(req.ptyId);
      return true;
    },
    forgetBrief: async () => {}, noteTyping: async () => {}, confirmRestartPane: async () => true,
    restartHost: async () => {}, stopOtherHosts: async () => [], waiting: () => [],
  });
  return {
    panes,
    sends,
    spawn(request) { return handlers.get("pty:spawn")({}, { command: "claude", cwd: "/project", cols: 80, rows: 24, ...request }); },
  };
}

function updatePreparation() {
  let settle;
  const preparation = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  const updater = Object.assign(new EventEmitter(), {
    checkForUpdates: async () => {},
    quitAndInstall: () => {},
  });
  const window = { isDestroyed: () => false, webContents: { send: () => {} } };
  const updates = createUpdates({
    app: { isPackaged: true, getVersion: () => "0.12.0", quit: () => {} },
    autoUpdater: () => updater,
    isDev: false,
    platform: "darwin",
    env: {},
    eachAyaWindow: (visit) => visit(window),
    diagnosticsLog: { append: () => {} },
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    shell: { openExternal: async () => {} },
    notifications: { isSupported: () => false, create: () => ({ show: () => {} }) },
    relaunchDeps: {
      file: join(testHome, "relaunch-notes.json"), panes: async () => [], agentOf: async () => "claude",
      screen: async () => "", pid: async () => 1, command: async () => "claude", busy: async () => false, foreground: async () => null,
    },
    askRestart: async () => true,
    preparePlannedUpdate: () => preparation,
  });
  updates.configureAutoUpdates(window);
  updater.emit("update-downloaded", { version: "0.13.0" });
  return {
    updates,
    install: () => updates.install(),
    settle,
    isPreparing: () => updates.getUpdateStatus().preparingUpdate === true,
  };
}

for (const [source, request] of sources) {
  for (const outcome of ["preparation active", "failed", "cancelled", "proceeding"]) {
    test(`${source}: pty:spawn refuses during update preparation (${outcome})`, async () => {
      const update = updatePreparation();
      const active = registeredSpawner({ isPreparing: update.isPreparing });
      const installing = update.install();
      assert.equal(update.isPreparing(), true, "the real update installer marks preparation active before awaiting handover");
      const before = active.panes.size;
      await assert.rejects(async () => active.spawn(request), (error) => error.message === UPDATE_SPAWN_REFUSAL);
      assert.equal(active.panes.size, before, "no local or remote PTY was created while update preparation was active");
      assert.deepEqual(active.sends, [], "the request was refused before the route dispatcher, including the remote route");

      if (outcome === "failed") {
        update.settle.reject(new Error("handover preparation failed"));
        await assert.rejects(installing, /handover preparation failed/);
        assert.equal(update.isPreparing(), false, "a failed preparation re-enables new terminals");
        await active.spawn(request);
        assert.equal(active.panes.size, before + 1, "one explicit retry creates one PTY after the update is no longer preparing");
        assert.deepEqual(active.sends, [request.projectSlug === "remote-project" ? "remote" : "local"]);
      } else if (outcome === "cancelled") {
        update.settle.resolve(false);
        await installing;
        assert.equal(update.isPreparing(), false, "a cancelled preparation re-enables new terminals");
        await active.spawn(request);
        assert.equal(active.panes.size, before + 1, "one explicit retry creates one PTY after cancellation");
        assert.deepEqual(active.sends, [request.projectSlug === "remote-project" ? "remote" : "local"]);
      } else if (outcome === "proceeding") {
        // A successful preparation keeps the flag set while Aya proceeds to
        // quit, so there is no spawn window between handover and install.
        update.settle.resolve(true);
        await installing;
        assert.equal(update.isPreparing(), true, "a proceeding update keeps new terminals disabled");
        await assert.rejects(async () => active.spawn(request), (error) => error.message === UPDATE_SPAWN_REFUSAL);
        assert.equal(active.panes.size, before);
        assert.deepEqual(active.sends, []);
      } else {
        // Release the preparation so the fixture leaves no pending promise.
        update.settle.resolve(false);
        await installing;
        assert.equal(update.isPreparing(), false);
      }
    });
  }
}

test("a remote spawn already preparing is refused if update preparation starts before dispatch", async () => {
  let releasePreparation;
  const pending = new Promise((resolve) => { releasePreparation = resolve; });
  let preparing = false;
  const active = registeredSpawner({ prepareSpawn: () => pending, isPreparing: () => preparing });
  const spawn = active.spawn({ ptyId: "remote-in-flight", projectSlug: "remote-project" });
  await new Promise((resolve) => setImmediate(resolve));
  preparing = true;
  releasePreparation({
    ptyId: "remote-in-flight", projectSlug: "remote-project", command: "claude", cwd: "/project", cols: 80, rows: 24,
  });
  await assert.rejects(spawn, (error) => error.message === UPDATE_SPAWN_REFUSAL);
  assert.equal(active.panes.size, 0);
  assert.deepEqual(active.sends, [], "the post-preparation guard stops the request before remote dispatch");
});

test("unrelated spawn failures retain their original explanation", () => {
  const error = new Error("The selected terminal preset is unavailable.");
  assert.equal(userFacingSpawnError(error), error);
});
