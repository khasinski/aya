// App-wide updates against a lazy stand-in updater and native UI; recovery files stay in a temporary home.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "aya-updates-"));
const oldHome = process.env.HOME;
const oldAyaHome = process.env.AYA_HOME;
process.env.HOME = root;
process.env.AYA_HOME = join(root, "aya");
const { createUpdates, updateVersion, UPDATE_AUTO_CHECK_DELAY_MS } = await import("../dist-electron/updates.js");
const { PENDING_UPDATE_FILE, SHIPIT_CACHE_DIR, readPendingUpdate, clearPendingUpdate } = await import("../dist-electron/update-recovery.js");

test.after(() => {
  rmSync(root, { recursive: true, force: true });
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldAyaHome === undefined) delete process.env.AYA_HOME;
  else process.env.AYA_HOME = oldAyaHome;
});
test.beforeEach(async () => { await clearPendingUpdate(); });

function setup(over = {}) {
  const log = [];
  const windows = [0, 1].map((id) => ({
    isDestroyed: () => false,
    webContents: { send: (channel, status) => log.push(["status", id, channel, status]) },
  }));
  let touches = 0;
  let version = "0.12.0";
  const updater = Object.assign(new EventEmitter(), {
    autoRunAppAfterInstall: true,
    checkForUpdates: async () => { updater.emit("update-not-available", { version }); },
    quitAndInstall: (silent, runAfter) => {
      log.push(["install", silent, runAfter, updater.autoRunAppAfterInstall, JSON.parse(readFileSync(PENDING_UPDATE_FILE, "utf8"))]);
    },
  });
  const deps = {
    app: { isPackaged: true, getVersion: () => version, quit: () => log.push(["quit"]) },
    autoUpdater: () => { touches++; return updater; },
    isDev: false,
    platform: "darwin",
    env: {},
    eachAyaWindow: (fn) => windows.filter((w) => !w.isDestroyed()).forEach(fn),
    diagnosticsLog: { append: (ev, fields) => log.push(["diagnostics", ev, fields, existsSync(PENDING_UPDATE_FILE)]) },
    dialog: { showMessageBox: async (...args) => { log.push(["dialog", ...args]); return { response: 1 }; } },
    shell: { openExternal: async (url) => log.push(["open", url]) },
    notifications: {
      isSupported: () => true,
      create: (opts) => ({ show: () => log.push(["notification", opts]) }),
    },
    relaunchDeps: {
      file: join(root, "relaunch-notes.json"),
      panes: async () => [],
      agentOf: async () => "codex",
      screen: async () => "1 background terminal running /ps to view",
      pid: async () => 100,
      command: async () => "codex resume",
      busy: async () => false,
      foreground: async () => null,
    },
    askRestart: async (yes, text) => { log.push(["ask", yes, text]); return true; },
    ...over,
  };
  const updates = createUpdates(deps);
  return { updates, updater, windows, log, deps, touches: () => touches, version: (next) => { version = next; } };
}

function writePending(targetVersion, attempts = 1, requestedAt = "2020-01-01T00:00:00.000Z") {
  mkdirSync(process.env.AYA_HOME, { recursive: true });
  writeFileSync(PENDING_UPDATE_FILE, JSON.stringify({ targetVersion, attempts, requestedAt }));
}

const broadcasts = (s) => s.log.filter(([what]) => what === "status");
const latest = (s) => broadcasts(s).at(-1)?.[3];
const downloaded = (s, info = { version: "0.13.0" }) => {
  s.updates.configureAutoUpdates(s.windows[0]);
  s.updater.emit("update-downloaded", info);
};

test("support checks and construction leave the platform updater untouched", async () => {
  for (const [over, supported, message] of [
    [{}, true, undefined],
    [{ isDev: true }, false, "Updates are disabled in development builds."],
    [{ app: { isPackaged: false, getVersion: () => "dev", quit() {} } }, false, "Updates are disabled in development builds."],
    [{ platform: "linux" }, false, "Automatic install is only available for the AppImage build on Linux."],
    [{ platform: "linux", env: { APPIMAGE: "/tmp/aya.AppImage" } }, true, undefined],
    [{ platform: "win32" }, false, "Automatic updates are not supported on this platform."],
  ]) {
    const s = setup(over);
    const status = s.updates.getUpdateStatus();
    assert.equal(status.supported, supported);
    assert.equal(status.message, message);
    assert.equal(status.phase, supported ? "idle" : "unsupported");
    assert.equal(s.touches(), 0);
    if (!supported) {
      s.updates.configureAutoUpdates(s.windows[0]);
      assert.deepEqual(await s.updates.checkForUpdates(), status);
      assert.equal(s.touches(), 0);
      assert.deepEqual(s.updater.eventNames(), []);
    }
  }
  assert.equal(UPDATE_AUTO_CHECK_DELAY_MS, 12_000);
});

test("install preparation is announced immediately and stays active only after a successful handover", async () => {
  for (const outcome of ["succeeds", "fails", "cancelled"]) {
    let settle;
    const preparation = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    const s = setup({ preparePlannedUpdate: () => preparation });
    downloaded(s);
    const installing = s.updates.install();
    assert.equal(s.updates.getUpdateStatus().preparingUpdate, true, `${outcome}: preparation starts before awaiting`);
    assert.equal(latest(s).preparingUpdate, true, `${outcome}: all windows receive the disabled state`);
    if (outcome === "succeeds") {
      settle.resolve(true);
      await installing;
      assert.equal(s.updates.getUpdateStatus().preparingUpdate, true, "successful handover remains active until Aya quits");
      assert.equal(s.log.some(([what]) => what === "install"), true);
    } else if (outcome === "fails") {
      settle.reject(new Error("checkpoint failed"));
      await assert.rejects(installing, /checkpoint failed/);
      assert.equal(s.updates.getUpdateStatus().preparingUpdate, undefined);
    } else {
      settle.resolve(false);
      await installing;
      assert.equal(s.updates.getUpdateStatus().preparingUpdate, undefined);
      assert.equal(s.log.some(([what]) => what === "install"), false);
    }
  }
});

test("configuration runs once, sets updater flags and broadcasts every event to live windows", () => {
  const s = setup();
  s.updates.configureAutoUpdates(s.windows[0]);
  s.updates.configureAutoUpdates(s.windows[1]);
  assert.equal(s.updater.autoDownload, true);
  assert.equal(s.updater.autoInstallOnAppQuit, false);
  assert.equal(s.updater.allowPrerelease, false);
  for (const event of ["checking-for-update", "update-available", "update-not-available", "download-progress", "update-downloaded", "error"]) {
    assert.equal(s.updater.listenerCount(event), 1);
  }
  s.updater.emit("checking-for-update");
  assert.deepEqual(broadcasts(s).map((row) => row.slice(1, 3)), [[0, "updates:status"], [1, "updates:status"]]);
  assert.deepEqual(latest(s), { supported: true, currentVersion: "0.12.0", phase: "checking", message: "Checking for updates." });
  s.updater.emit("update-available", { version: "0.13.0" });
  assert.equal(latest(s).phase, "available");
  assert.equal(latest(s).availableVersion, "0.13.0");
  assert.equal(latest(s).message, "Update found. Downloading in the background.");
  assert.ok(!Number.isNaN(Date.parse(latest(s).checkedAt)));
  s.updater.emit("update-not-available", { version: "0.12.0" });
  assert.equal(latest(s).phase, "not-available");
  assert.equal(latest(s).message, "Aya is up to date.");
  assert.equal(latest(s).availableVersion, "0.12.0");
  s.windows[0].isDestroyed = () => true;
  s.log.length = 0;
  s.updater.emit("checking-for-update");
  assert.deepEqual(broadcasts(s).map((row) => row[1]), [1]);
  s.version("0.12.1");
  assert.equal(s.updates.getUpdateStatus().currentVersion, "0.12.1");
});

test("download progress clamps numbers and replaces the earlier status", () => {
  const s = setup();
  s.updates.configureAutoUpdates(s.windows[0]);
  s.updater.emit("update-available", { version: "0.13.0" });
  for (const [percent, expected] of [[-5, 0], [35, 35], [105, 100], ["35", undefined]]) {
    s.updater.emit("download-progress", { percent });
    assert.deepEqual(latest(s), { supported: true, currentVersion: "0.12.0", phase: "downloading", percent: expected, message: "Downloading update." });
  }
});

test("download completion broadcasts before showing a notification, with and without a version", () => {
  const s = setup();
  downloaded(s);
  assert.equal(latest(s).message, "Aya 0.13.0 is ready to install.");
  assert.equal(latest(s).downloadedVersion, "0.13.0");
  assert.deepEqual(s.log.map((row) => row[0]), ["status", "status", "notification"]);
  assert.deepEqual(s.log.at(-1), ["notification", { title: "Aya update ready", body: "Restart Aya to install the update." }]);
  s.deps.notifications.isSupported = () => false;
  s.log.length = 0;
  s.updater.emit("update-downloaded", { version: 13 });
  assert.equal(latest(s).message, "Update is ready to install.");
  assert.equal(latest(s).downloadedVersion, undefined);
  assert.deepEqual(s.log.map((row) => row[0]), ["status", "status"]);
});

test("version extraction accepts only an object's string version", () => {
  for (const value of [null, undefined, "0.13.0", 13, {}, { version: 13 }]) assert.equal(updateVersion(value), undefined);
  assert.equal(updateVersion({ version: "0.13.0" }), "0.13.0");
  assert.equal(updateVersion({ version: "" }), "");
});

test("overlapping checks share one request; a later check runs again", async () => {
  const s = setup();
  s.updates.configureAutoUpdates(s.windows[0]);
  let release;
  let calls = 0;
  s.updater.checkForUpdates = () => { calls++; return new Promise((resolve) => { release = resolve; }); };
  const a = s.updates.checkForUpdates();
  const b = s.updates.checkForUpdates();
  assert.equal(calls, 1);
  assert.equal(broadcasts(s).length, 2);
  s.updater.emit("update-not-available", { version: "0.12.0" });
  release();
  assert.deepEqual(await a, await b);
  assert.equal((await a).phase, "not-available");
  const c = s.updates.checkForUpdates();
  assert.equal(calls, 2);
  release();
  await c;
});

test("rejected checks publish errors and release the in-flight check", async () => {
  const s = setup();
  for (const error of [new Error("check failed"), "plain failure"]) {
    s.updater.checkForUpdates = async () => { throw error; };
    const status = await s.updates.checkForUpdates();
    assert.equal(status.phase, "error");
    assert.equal(status.message, error instanceof Error ? error.message : error);
    assert.ok(!Number.isNaN(Date.parse(status.checkedAt)));
    assert.deepEqual(latest(s), status);
  }
});

test("a synchronous check failure retains the existing cached-result behavior", async () => {
  const s = setup();
  let calls = 0;
  s.updater.checkForUpdates = () => { calls++; throw new Error("synchronous failure"); };
  const first = await s.updates.checkForUpdates();
  s.updater.checkForUpdates = async () => { calls++; };
  assert.deepEqual(await s.updates.checkForUpdates(), first);
  assert.equal(calls, 1);
});

test("install writes the marker before handoff; an async error keeps it and releases the latch", async () => {
  const s = setup();
  downloaded(s);
  await s.updates.install();
  await s.updates.install();
  assert.equal(s.log.filter(([what]) => what === "install").length, 1);
  assert.deepEqual(s.log.at(-1).slice(0, 4), ["install", false, true, true]);
  assert.equal(s.log.at(-1)[4].targetVersion, "0.13.0");
  s.updater.emit("error", new Error("handoff failed"));
  assert.equal(latest(s).message, "handoff failed");
  assert.equal((await readPendingUpdate()).targetVersion, "0.13.0");
  s.updater.emit("update-downloaded", { version: "0.13.0" });
  await s.updates.install();
  assert.equal(s.log.filter(([what]) => what === "install").length, 2);
  assert.equal((await readPendingUpdate()).attempts, 2);
  s.updater.emit("error", "plain failure");
  assert.equal(latest(s).message, "plain failure");
});

test("a synchronous handoff failure clears its marker and publishes the existing error text", async () => {
  const s = setup();
  await assert.rejects(s.updates.install(), /No downloaded update is ready to install\./);
  downloaded(s);
  s.updater.quitAndInstall = () => { throw new Error("ShipIt missing"); };
  await s.updates.install();
  assert.equal(await readPendingUpdate(), null);
  assert.equal(latest(s).message, "Couldn't start the update: ShipIt missing");
});

test("background work uses the same Restart to update prompt and honors cancellation", async () => {
  const s = setup({ askRestart: async (yes, text) => { s.log.push(["ask", yes, text]); return false; } });
  s.deps.relaunchDeps.panes = async () => [{ id: "a", name: "agent" }];
  downloaded(s);
  await s.updates.install();
  const ask = s.log.findLast(([what]) => what === "ask");
  assert.equal(ask[1], "Restart to update");
  assert.match(ask[2], /^Restarting to update stops what these panes are doing \(agent: 1 background terminal\)/);
  assert.equal(s.updates.getUpdateStatus().preparingUpdate, undefined);
  assert.equal(await readPendingUpdate(), null);
  assert.equal(s.log.some(([what]) => what === "install"), false);
});

test("ordinary quit installs without relaunch, marks synchronously and keeps the 15 s fallback", async (t) => {
  const s = setup();
  const timers = [];
  t.mock.method(globalThis, "setTimeout", (callback, ms) => ({ unref: () => timers.push({ callback, ms }) }));
  assert.equal(s.updates.beforeQuit({ preventDefault() { assert.fail("idle quit was held"); } }), null);
  downloaded(s);
  let prevented = 0;
  const held = s.updates.beforeQuit({ preventDefault: () => prevented++ });
  assert.equal(prevented, 1);
  await held;
  assert.deepEqual(s.log.at(-1).slice(0, 4), ["install", false, false, false]);
  assert.equal(s.log.at(-1)[4].targetVersion, "0.13.0");
  assert.equal(s.updates.beforeQuit({ preventDefault() { assert.fail("second quit was held"); } }), null);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 15_000);
  timers[0].callback();
  assert.deepEqual(s.log.at(-1), ["quit"]);
});

test("ordinary quit with unreadable running work quits without touching the installer or marker", async () => {
  const s = setup();
  s.deps.relaunchDeps.panes = async () => [{ id: "a", name: "agent" }];
  s.deps.relaunchDeps.screen = async () => null;
  downloaded(s);
  s.log.length = 0;
  const touches = s.touches();
  await s.updates.beforeQuit({ preventDefault: () => s.log.push(["prevent"]) });
  assert.deepEqual(s.log, [["prevent"], ["quit"]]);
  assert.equal(s.touches(), touches);
  assert.equal(await readPendingUpdate(), null);
});

test("a missing or grace-window marker is left alone; an applied update clears it quietly", async () => {
  const s = setup();
  await s.updates.reconcilePendingUpdate(null);
  assert.deepEqual(s.log, []);
  writePending("0.13.0", 1, new Date().toISOString());
  await s.updates.reconcilePendingUpdate(null);
  assert.equal((await readPendingUpdate()).targetVersion, "0.13.0");
  assert.deepEqual(s.log, []);
  writePending("0.12.0");
  await s.updates.reconcilePendingUpdate(null);
  assert.equal(await readPendingUpdate(), null);
  assert.deepEqual(s.log, []);
  assert.equal(s.touches(), 0);
});

test("rollback clears the marker before logging, warns with its live parent and stays sticky across checks", async () => {
  const s = setup({ dialog: { showMessageBox: async (...args) => { s.log.push(["dialog", ...args]); return { response: 0 }; } } });
  writePending("0.13.0");
  await s.updates.reconcilePendingUpdate(s.windows[0]);
  const notice = "The update to 0.13.0 didn't install - still on 0.12.0. Try the DMG from the releases page.";
  assert.equal(await readPendingUpdate(), null);
  assert.deepEqual(s.log[0], ["diagnostics", "update-rolled-back", { target: "0.13.0", current: "0.12.0", attempts: 1 }, false]);
  assert.deepEqual(s.log.map((row) => row[0]), ["diagnostics", "status", "status", "dialog", "open"]);
  assert.equal(latest(s).rollbackNotice, notice);
  assert.equal(latest(s).message, notice);
  assert.equal(latest(s).phase, "error");
  assert.equal(s.log[3][1], s.windows[0]);
  assert.deepEqual(s.log[3][2], {
    type: "warning", buttons: ["Open releases page", "Later"], defaultId: 0, cancelId: 1,
    message: "Update to 0.13.0 didn't apply",
    detail: "Aya is still on 0.12.0. The in-app update failed to install and rolled back to the current version. You can install the latest release manually.",
  });
  assert.deepEqual(s.log.at(-1), ["open", "https://github.com/khasinski/aya/releases/latest"]);
  s.updates.configureAutoUpdates(s.windows[0]);
  await s.updates.checkForUpdates();
  assert.equal(s.updates.getUpdateStatus().phase, "not-available");
  assert.equal(s.updates.getUpdateStatus().rollbackNotice, notice);
  writePending("0.12.0");
  await s.updates.reconcilePendingUpdate(null);
  // The existing stored status retains the notice until another status write replaces it.
  assert.equal(s.updates.getUpdateStatus().rollbackNotice, notice);
  s.updater.emit("checking-for-update");
  assert.equal(s.updates.getUpdateStatus().rollbackNotice, undefined);
});

test("rollback uses an unparented dialog for a missing or destroyed window and Later opens nothing", async () => {
  for (const parent of [null, { isDestroyed: () => true }]) {
    const s = setup();
    writePending("0.13.0");
    await s.updates.reconcilePendingUpdate(parent);
    assert.equal(s.log.find(([what]) => what === "dialog").length, 2);
    assert.equal(s.log.some(([what]) => what === "open"), false);
  }
});

test("ShipIt cache cleanup waits for a repeat failure and only removes the temporary home cache", async () => {
  assert.ok(SHIPIT_CACHE_DIR.startsWith(root + "/"));
  const sentinel = join(SHIPIT_CACHE_DIR, "sentinel");
  mkdirSync(SHIPIT_CACHE_DIR, { recursive: true });
  writeFileSync(sentinel, "poisoned state");
  const s = setup();
  writePending("0.13.0", 1);
  await s.updates.reconcilePendingUpdate(null);
  assert.equal(existsSync(sentinel), true);
  writePending("0.13.0", 2);
  await s.updates.reconcilePendingUpdate(null);
  assert.equal(existsSync(sentinel), process.platform !== "darwin");
});
