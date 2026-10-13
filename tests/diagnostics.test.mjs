// Diagnostics report and GPU recovery against config, host, log and window stand-ins.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "aya-diagnostics-"));
const previousAyaHome = process.env.AYA_HOME;
process.env.AYA_HOME = home;
after(() => {
  if (previousAyaHome === undefined) delete process.env.AYA_HOME;
  else process.env.AYA_HOME = previousAyaHome;
  rmSync(home, { recursive: true, force: true });
});

const { diagnosticsReport, createGpuDeathHandler } = await import("../dist-electron/diagnostics.js");
const { pathExists } = await import("../dist-electron/path-exists.js");

const paths = {
  ayaHome: home,
  controlSocketPath: join(home, "control.sock"),
  remoteSocketPath: join(home, "remote.sock"),
  ptyHostSocketPath: join(home, "pty-host.sock"),
};
// Existence is all the report asks for; no sockets need to listen.
writeFileSync(paths.controlSocketPath, "");
writeFileSync(paths.ptyHostSocketPath, "");

function reportSetup(over = {}) {
  const log = [];
  const presets = [
    { id: "c1", name: "Claude", agent: "claude", command: "claude", configDir: join(home, "claude"), autoResume: false, unsafeMode: true, agentBrief: true, ignored: "private" },
    { id: "c2", name: "Claude two", agent: "claude", command: "claude", configDir: "", autoResume: "yes", unsafeMode: 1, agentBrief: false },
    { id: "x", name: "Codex", agent: "codex", command: "codex", autoResume: true, unsafeMode: false },
    { id: "s", name: "Shell", agent: "shell", command: "sh" },
  ];
  const cli = { installed: true, path: join(home, "bin/aya"), installDir: join(home, "bin"), installable: true };
  const adoption = [{ agent: "claude", panesLaunched: 3, panesThatCalledAya: 2, panesThatRanCapabilities: 1 }];
  const health = {
    expected: { version: "0.12.0", scriptHash: "new" },
    identity: { version: "0.11.0", scriptHash: "old" },
    ptyCount: 8,
    stale: true,
    pid: 123,
    socket: { exists: true, pid: 456 },
    otherHosts: [{ pid: 789, startTime: "yesterday", version: "0.10.0" }],
    warnings: ["warning verbatim"],
  };
  const entries = Array.from({ length: 45 }, (_, i) => join(home, `bin-${i}`));
  const read = (name, value) => async () => (log.push(name), value);
  const deps = {
    ...paths,
    app: { getVersion: () => (log.push("version"), "0.12.0") },
    isDev: true,
    listPresets: read("presets", presets),
    listProjects: read("projects", [{}, { remote: {} }, { remote: false }]),
    listProjectState: read("state", { open: ["a", "b"], recent: ["c"] }),
    usageHookStatus: read("hook", { installed: true, scriptPath: join(home, "hook.sh") }),
    cliStatus: read("cli", cli),
    hostHealth: read("health", health),
    cliAdoption: { summary: read("adoption", adoption) },
    pathExists: async (file) => (log.push(file), pathExists(file)),
    pathEntries: () => (log.push("path"), entries),
    ...over,
  };
  return { deps, log, presets, cli, health, adoption, entries };
}

function shellEnv(t, value) {
  const previous = process.env.SHELL;
  if (value === undefined) delete process.env.SHELL;
  else process.env.SHELL = value;
  t.after(() => {
    if (previous === undefined) delete process.env.SHELL;
    else process.env.SHELL = previous;
  });
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("report preserves metadata, host facts, preset projection, counts and the first 40 PATH entries", async (t) => {
  shellEnv(t, "/test/shell");
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 13) });
  const { deps, log, cli, adoption, health, entries } = reportSetup();
  const report = await diagnosticsReport(deps);
  assert.deepEqual(report, {
    generatedAt: "2026-10-13T00:00:00.000Z",
    app: { version: "0.12.0", mode: "development", platform: process.platform, arch: process.arch, pid: process.pid, cwd: process.cwd() },
    paths: {
      ayaHome: home,
      controlSocket: paths.controlSocketPath,
      remoteSocket: paths.remoteSocketPath,
      ptyHostSocket: paths.ptyHostSocketPath,
      controlSocketExists: true,
      remoteSocketExists: false,
      ptyHostSocketExists: true,
    },
    shell: { shell: "/test/shell", pathEntries: entries.slice(0, 40) },
    cli,
    cliAdoption: adoption,
    ptyHost: {
      expected: health.expected, actual: health.identity, ptyCount: 8, stale: true,
      pid: 123, socket: health.socket, otherHosts: health.otherHosts, warnings: health.warnings,
    },
    presets: [
      { id: "c1", name: "Claude", agent: "claude", command: "claude", configDir: join(home, "claude"), autoResume: false, unsafeMode: true, agentBrief: true },
      { id: "c2", name: "Claude two", agent: "claude", command: "claude" },
      { id: "x", name: "Codex", agent: "codex", command: "codex", autoResume: true, unsafeMode: false },
      { id: "s", name: "Shell", agent: "shell", command: "sh" },
    ],
    projects: { total: 3, open: 2, recent: 1, remote: 1 },
    usage: { claudeAccounts: 2, codexAccounts: 1, hookInstalled: true, hookScriptPath: join(home, "hook.sh") },
  });
  assert.equal(entries.length, 45, "the source PATH entries are not truncated");
  assert.deepEqual(log, ["presets", "projects", "state", "hook", "cli", "health", "adoption", "version", paths.controlSocketPath, paths.remoteSocketPath, paths.ptyHostSocketPath, "path"]);
});

test("production report preserves empty values, an absent shell and a disconnected host", async (t) => {
  shellEnv(t, undefined);
  const { deps } = reportSetup({
    isDev: false,
    listPresets: async () => [],
    listProjects: async () => [],
    listProjectState: async () => ({ open: [], recent: [] }),
    usageHookStatus: async () => ({ installed: false, scriptPath: "" }),
    pathEntries: () => [],
    hostHealth: async () => ({ expected: { version: "v", scriptHash: "h" }, identity: null, ptyCount: 0, stale: false, pid: null, socket: { exists: false, pid: null }, otherHosts: [], warnings: [] }),
  });
  const report = await diagnosticsReport(deps);
  assert.equal(report.app.mode, "production");
  assert.deepEqual(report.shell, { shell: null, pathEntries: [] });
  assert.deepEqual(report.presets, []);
  assert.deepEqual(report.projects, { total: 0, open: 0, recent: 0, remote: 0 });
  assert.deepEqual(report.usage, { claudeAccounts: 0, codexAccounts: 0, hookInstalled: false, hookScriptPath: "" });
  assert.deepEqual(report.ptyHost, { expected: { version: "v", scriptHash: "h" }, actual: null, ptyCount: 0, stale: false, pid: null, socket: { exists: false, pid: null }, otherHosts: [], warnings: [] });
});

test("all seven readers start together; socket checks wait for them and then run in order", async () => {
  const { deps, log } = reportSetup();
  const releases = [];
  const hold = (read) => () => {
    const value = read();
    return new Promise((resolve) => releases.push(() => resolve(value)));
  };
  for (const key of ["listPresets", "listProjects", "listProjectState", "usageHookStatus", "cliStatus", "hostHealth"]) deps[key] = hold(deps[key]);
  deps.cliAdoption.summary = hold(deps.cliAdoption.summary);
  const sockets = [];
  deps.pathExists = (file) => {
    log.push(file);
    return new Promise((resolve) => sockets.push(resolve));
  };
  const pending = diagnosticsReport(deps);
  assert.deepEqual(log, ["presets", "projects", "state", "hook", "cli", "health", "adoption"]);
  assert.equal(releases.length, 7);
  for (const release of releases.slice(1).reverse()) release();
  await flush();
  assert.equal(sockets.length, 0, "the final reader still blocks socket checks");
  releases[0]();
  await flush();
  assert.deepEqual(log.slice(7), ["version", paths.controlSocketPath]);
  sockets[0](true);
  await flush();
  assert.deepEqual(log.slice(7), ["version", paths.controlSocketPath, paths.remoteSocketPath]);
  sockets[1](false);
  await flush();
  assert.deepEqual(log.slice(7), ["version", paths.controlSocketPath, paths.remoteSocketPath, paths.ptyHostSocketPath]);
  sockets[2](true);
  await pending;
  assert.equal(log.at(-1), "path");
});

test("reader and socket failures propagate without continuing report side effects", async () => {
  const failure = new Error("host failed");
  const { deps, log } = reportSetup({ hostHealth: async () => { throw failure; } });
  await assert.rejects(diagnosticsReport(deps), (err) => err === failure);
  assert.deepEqual(log, ["presets", "projects", "state", "hook", "cli", "adoption"]);
  const socketFailure = new Error("socket check failed");
  const broken = reportSetup({ pathExists: async (file) => { assert.equal(file, paths.controlSocketPath); throw socketFailure; } });
  await assert.rejects(diagnosticsReport(broken.deps), (err) => err === socketFailure);
  assert.equal(broken.log.at(-1), "version");
});

function gpuSetup(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const log = [];
  let quitting = false;
  let windows = ["first", "second"];
  const schedule = globalThis.setTimeout;
  const timeouts = t.mock.method(globalThis, "setTimeout", (callback, delay) => {
    log.push(["timer", delay]);
    return schedule(callback, delay);
  });
  const clears = t.mock.method(globalThis, "clearTimeout");
  const handler = createGpuDeathHandler({
    diagnosticsLog: { append: (event, fields) => log.push([event, fields]) },
    appQuitting: () => quitting,
    eachAyaWindow: (fn) => {
      for (const id of windows) fn({ webContents: { send: (...args) => log.push([id, ...args]) } });
    },
  });
  return { handler, log, timeouts, clears, quit: () => { quitting = true; }, windows: (next) => { windows = next; } };
}

const death = (reason = "killed", type = "GPU", exitCode = 9) => ({ type, reason, exitCode });
const nudges = (log) => log.filter((entry) => entry[1] === "gpu:relaunched");

test("non-GPU deaths neither log nor schedule recovery", (t) => {
  const { handler, log } = gpuSetup(t);
  handler.childProcessGone(death("crashed", "Utility"));
  t.mock.timers.tick(5000);
  assert.deepEqual(log, []);
});

test("GPU death logs before scheduling; both exact delays use the windows live at that time", (t) => {
  const { handler, log, windows, clears } = gpuSetup(t);
  handler.childProcessGone(death());
  assert.deepEqual(log, [["gpu-process-gone", { reason: "killed", exitCode: 9 }], ["timer", 1200], ["timer", 3000]]);
  t.mock.timers.tick(1199);
  assert.deepEqual(nudges(log), []);
  t.mock.timers.tick(1);
  assert.deepEqual(nudges(log), [["first", "gpu:relaunched"], ["second", "gpu:relaunched"]]);
  windows(["new"]);
  t.mock.timers.tick(1799);
  assert.equal(nudges(log).length, 2);
  t.mock.timers.tick(1);
  assert.deepEqual(nudges(log).at(-1), ["new", "gpu:relaunched"]);
  handler.clearHealTimers();
  assert.equal(clears.mock.callCount(), 0, "fired timers were removed from the live set");
});

test("a clean GPU exit still heals without logging a death", (t) => {
  const { handler, log } = gpuSetup(t);
  handler.childProcessGone(death("clean-exit", "GPU", 0));
  assert.deepEqual(log, [["timer", 1200], ["timer", 3000]]);
  t.mock.timers.tick(1200);
  t.mock.timers.tick(1800);
  assert.equal(nudges(log).length, 4);
});

test("quitting suppresses nudges even if a timer callback runs", (t) => {
  const { handler, log, quit, clears } = gpuSetup(t);
  handler.childProcessGone(death("oom", "GPU", 137));
  quit();
  t.mock.timers.tick(1200);
  t.mock.timers.tick(1800);
  assert.deepEqual(nudges(log), []);
  assert.deepEqual(log[0], ["gpu-process-gone", { reason: "oom", exitCode: 137 }]);
  handler.clearHealTimers();
  assert.equal(clears.mock.callCount(), 0);
});

test("clearing cancels only pending timers, empties the set and allows later recovery", (t) => {
  const { handler, log, timeouts, clears } = gpuSetup(t);
  handler.childProcessGone(death());
  t.mock.timers.tick(1200);
  handler.clearHealTimers();
  assert.equal(clears.mock.callCount(), 1);
  assert.equal(clears.mock.calls[0].arguments[0], timeouts.mock.calls[1].result);
  handler.clearHealTimers();
  assert.equal(clears.mock.callCount(), 1);
  t.mock.timers.tick(1800);
  assert.equal(nudges(log).length, 2);
  handler.childProcessGone(death("crashed"));
  t.mock.timers.tick(1200);
  t.mock.timers.tick(1800);
  assert.equal(nudges(log).length, 6);
});

test("a burst of GPU deaths preserves the two scheduled nudges per death", (t) => {
  const { handler, log, timeouts, clears } = gpuSetup(t);
  handler.childProcessGone(death());
  handler.childProcessGone(death("crashed"));
  assert.equal(timeouts.mock.callCount(), 4);
  t.mock.timers.tick(1200);
  assert.equal(nudges(log).length, 4);
  handler.clearHealTimers();
  assert.equal(clears.mock.callCount(), 2);
  t.mock.timers.tick(1800);
  assert.equal(nudges(log).length, 4);
});
