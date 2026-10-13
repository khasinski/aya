// Aya Web settings IPC and server state (electron/ipc/aya-web-ipc.ts) against stand-ins.

import { test } from "node:test";
import assert from "node:assert/strict";

const { createAyaWeb, registerAyaWebIpc } = await import("../dist-electron/ipc/aya-web-ipc.js");
const { webCredentials, verifyWebPassword } = await import("../dist-electron/web-config.js");

function setup(over = {}) {
  const handlers = new Map();
  let live = { enabled: false, port: 7683, host: "127.0.0.1", user: "me", ...webCredentials("first", true) };
  const log = [];
  registerAyaWebIpc({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    inQueue: async (change) => {
      log.push("queued");
      return change();
    },
    config: async () => live,
    save: async (next) => {
      log.push("save");
      live = next;
    },
    apply: async () => void log.push("apply"),
    status: () => ({ host: live.host, port: live.port, user: live.user, enabled: live.enabled }),
    ...over,
  });
  return { handlers, log, live: () => live, call: (channel, ...args) => handlers.get(channel)({}, ...args) };
}

test("registers exactly the web channels, and each runs in the queue", async () => {
  const { handlers, call, log } = setup();
  assert.deepEqual([...handlers.keys()].sort(), ["web:configure", "web:regenerate-password", "web:status"]);
  await call("web:status");
  assert.deepEqual(log, ["queued"]);
});

test("configure saves, then applies, then answers the new status", async () => {
  const { call, log, live } = setup();
  const status = await call("web:configure", { enabled: true, port: 9000, host: " 100.64.0.7 ", user: " you " });
  assert.deepEqual(log, ["queued", "save", "apply"]);
  assert.deepEqual(status, { host: "100.64.0.7", port: 9000, user: "you", enabled: true });
  assert.equal(live().generatedPassword, "first", "no password change asked: the generated one stays");
});

test("a custom password is stored as a hash only, without the generated plaintext", async () => {
  const { call, live } = setup();
  await call("web:configure", { password: "secret" });
  assert.equal(live().generatedPassword, undefined);
  assert.equal(verifyWebPassword(live(), "secret"), true);
});

test("a bad request or listen address is refused before anything is saved", async () => {
  const { call, log } = setup();
  await assert.rejects(call("web:configure", null), /request must be an object/);
  await assert.rejects(call("web:configure", { host: "localhost" }), /host must be an IP address/);
  assert.deepEqual(log.filter((x) => x !== "queued"), []);
});

test("a failed save leaves the server alone", async () => {
  const { call, log } = setup({ save: async () => { throw new Error("disk full"); } });
  await assert.rejects(call("web:configure", { enabled: true }), /disk full/);
  assert.equal(log.includes("apply"), false);
});

test("a regenerated password replaces the old one and is shown again", async () => {
  const { call, live } = setup();
  const before = live().passwordHash;
  await call("web:regenerate-password");
  assert.notEqual(live().passwordHash, before);
  assert.ok(live().generatedPassword && verifyWebPassword(live(), live().generatedPassword));
});

function ownedSetup(over = {}) {
  const handlers = new Map();
  const log = [];
  const starts = [];
  const servers = [];
  let persisted = { enabled: false, port: 7683, host: "127.0.0.1", user: "me", ...webCredentials("first", true) };
  const web = createAyaWeb({
    app: { getVersion: () => "0.12.0" },
    ptyHost: {
      attachWebContents: (sink) => log.push(["attach", sink]),
      detachWebContents: (sink) => log.push(["detach", sink]),
    },
    isDev: true,
    distDir: "/stand-in/dist",
    loadWebConfig: async () => (log.push(["load"]), persisted),
    saveWebConfig: async (next) => {
      log.push(["save", next]);
      persisted = next;
    },
    startWebServer: async (options) => {
      log.push(["start", options.getConfig()]);
      starts.push(options);
      const server = {
        broadcast: (channel, event) => log.push(["broadcast", servers.indexOf(server), channel, event]),
        clientCount: () => 2,
        close: async () => void log.push(["close", servers.indexOf(server)]),
      };
      servers.push(server);
      return server;
    },
    networkInterfaces: () => ({
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      en0: [{ address: "192.168.1.20", family: "IPv4", internal: false }],
      utun4: [{ address: "100.64.0.7", family: "IPv4", internal: false }],
    }),
    ...over,
  });
  registerAyaWebIpc({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    inQueue: web.inWebQueue,
    config: web.config,
    save: web.save,
    apply: web.applyWebServerState,
    status: web.webStatus,
  });
  return { web, log, starts, servers, persisted: () => persisted, call: (channel, ...args) => handlers.get(channel)({}, ...args) };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("status before loading is empty; IPC loads once and reports the disabled config without starting", async () => {
  const { web, call, log } = ownedSetup();
  assert.deepEqual(web.webStatus(), {
    enabled: false, running: false, port: 0, host: "", user: "", generatedPassword: null,
    urls: [], addresses: [], clients: 0, error: null,
  });
  await web.applyWebServerState();
  assert.deepEqual(log, []);
  const status = await call("web:status");
  assert.deepEqual(status, {
    enabled: false, running: false, port: 7683, host: "127.0.0.1", user: "me", generatedPassword: "first",
    urls: ["http://127.0.0.1:7683"],
    addresses: [{ name: "en0", address: "192.168.1.20" }, { name: "utun4", address: "100.64.0.7" }],
    clients: 0, error: null,
  });
  assert.deepEqual(await call("web:status"), status);
  assert.deepEqual(log, [["load"]]);
});

test("configure saves before starting and attaches the PTY sink with the app's server options", async () => {
  const { web, call, log, starts, persisted } = ownedSetup();
  const status = await call("web:configure", { enabled: true, host: "0.0.0.0", port: 9000 });
  assert.deepEqual(log.map(([what]) => what), ["load", "save", "start", "attach"]);
  assert.equal(log.at(-1)[1], web.webPtySink);
  assert.equal(starts[0].appVersion, "0.12.0");
  assert.equal(starts[0].isDev, true);
  assert.equal(starts[0].distDir, "/stand-in/dist");
  assert.equal(starts[0].getConfig(), persisted());
  assert.equal(status.running, true);
  assert.equal(status.clients, 2);
  assert.deepEqual(status.urls, ["http://192.168.1.20:9000", "http://100.64.0.7:9000"]);
});

test("restart detaches and clears the old server before waiting for close, then starts and attaches", async () => {
  const { web, call, log, servers } = ownedSetup();
  await call("web:configure", { enabled: true });
  let releaseClose;
  servers[0].close = () => new Promise((resolve) => {
    log.push(["close", 0]);
    releaseClose = resolve;
  });
  log.length = 0;
  const restart = call("web:configure", { port: 9000 });
  await tick();
  assert.deepEqual(log.map(([what]) => what), ["save", "detach", "close"]);
  assert.equal(log[1][1], web.webPtySink);
  assert.equal(web.webStatus().running, false);
  assert.equal(web.webStatus().clients, 0);
  web.webPtySink.send("pty:event", { duringClose: true });
  web.broadcast("control:status", { duringClose: true });
  assert.equal(log.some(([what]) => what === "broadcast"), false);
  releaseClose();
  assert.equal((await restart).running, true);
  assert.deepEqual(log.map(([what]) => what), ["save", "detach", "close", "start", "attach"]);
});

test("PTY and control status events reach only the current server and stop when disabled", async () => {
  const { web, call, log } = ownedSetup();
  assert.equal(web.webPtySink.isDestroyed(), false);
  web.webPtySink.send("pty:event", "before");
  web.broadcast("control:status", "before");
  await call("web:configure", { enabled: true });
  web.webPtySink.send("pty:event", "first");
  web.broadcast("control:status", "first");
  await call("web:configure", { port: 9000 });
  web.webPtySink.send("pty:event", "second");
  web.broadcast("control:status", "second");
  const disabled = await call("web:configure", { enabled: false });
  web.webPtySink.send("pty:event", "after");
  web.broadcast("control:status", "after");
  assert.deepEqual(log.filter(([what]) => what === "broadcast"), [
    ["broadcast", 0, "pty:event", "first"], ["broadcast", 0, "control:status", "first"],
    ["broadcast", 1, "pty:event", "second"], ["broadcast", 1, "control:status", "second"],
  ]);
  assert.deepEqual(log.slice(-3).map(([what]) => what), ["save", "detach", "close"]);
  assert.equal(disabled.running, false);
  assert.equal(disabled.clients, 0);
});

test("a failed save keeps the live config and running server, and the queue accepts the next change", async () => {
  let failSave = false;
  const { call, web, starts } = ownedSetup({
    saveWebConfig: async () => { if (failSave) throw new Error("disk full"); },
  });
  await call("web:configure", { enabled: true });
  const before = web.webStatus();
  const live = starts[0].getConfig();
  failSave = true;
  const failed = call("web:configure", { port: 9000 });
  const status = call("web:status");
  await assert.rejects(failed, /disk full/);
  assert.deepEqual(await status, before);
  assert.equal(starts[0].getConfig(), live);
  assert.equal(starts.length, 1);
  failSave = false;
  assert.equal((await call("web:configure", { port: 9001 })).port, 9001);
});

test("password regeneration saves without restarting, and the server reads the updated credentials", async () => {
  const { call, log, starts } = ownedSetup();
  await call("web:configure", { enabled: true });
  const old = starts[0].getConfig();
  log.length = 0;
  const status = await call("web:regenerate-password");
  const current = starts[0].getConfig();
  assert.deepEqual(log.map(([what]) => what), ["save"]);
  assert.equal(status.running, true);
  assert.equal(status.generatedPassword, current.generatedPassword);
  assert.notEqual(current.passwordHash, old.passwordHash);
  assert.equal(verifyWebPassword(current, current.generatedPassword), true);
  assert.equal(starts.length, 1);
  await call("web:configure", { password: "custom" });
  assert.equal(starts[0].getConfig().generatedPassword, undefined);
  assert.equal((await call("web:status")).generatedPassword, null);
});

test("start failures are status errors rather than rejected configure requests, and disabling clears them", async () => {
  for (const failure of [new Error("port busy"), "plain failure"]) {
    const { call, log } = ownedSetup({ startWebServer: async () => { throw failure; } });
    const status = await call("web:configure", { enabled: true });
    assert.equal(status.enabled, true);
    assert.equal(status.running, false);
    assert.equal(status.error, failure instanceof Error ? failure.message : failure);
    assert.equal(log.some(([what]) => what === "attach"), false);
    assert.equal((await call("web:configure", { enabled: false })).error, null);
  }
});

test("two changes at once both stay: each reads the config the other saved through the owned queue", async () => {
  let releaseSave;
  let saves = 0;
  const { call, web } = ownedSetup({
    saveWebConfig: async () => {
      if (++saves === 1) await new Promise((resolve) => (releaseSave = resolve));
    },
  });
  const port = call("web:configure", { port: 9000 });
  const host = call("web:configure", { host: "100.64.0.7" });
  await tick();
  assert.equal(saves, 1);
  assert.equal(web.webStatus().port, 7683, "the config changes only after the save finishes");
  releaseSave();
  await Promise.all([port, host]);
  assert.equal(web.webStatus().port, 9000);
  assert.equal(web.webStatus().host, "100.64.0.7");
});

test("a disable queued behind a slow enable waits for its server and then closes it", async () => {
  let releaseStart;
  const log = [];
  const { call, web } = ownedSetup({
    startWebServer: () => new Promise((resolve) => {
      log.push("start");
      releaseStart = () => resolve({ close: async () => void log.push("close"), clientCount: () => 0, broadcast: () => {} });
    }),
  });
  const enable = call("web:configure", { enabled: true });
  const disable = call("web:configure", { enabled: false });
  await tick();
  assert.deepEqual(log, ["start"]);
  assert.equal(web.webStatus().enabled, true);
  releaseStart();
  await enable;
  const status = await disable;
  assert.deepEqual(log, ["start", "close"]);
  assert.equal(status.enabled, false);
  assert.equal(status.running, false);
});

test("startup returns immediately and queues Settings behind its pending load and start", async () => {
  let releaseLoad;
  let loads = 0;
  const { web, call, starts } = ownedSetup({
    loadWebConfig: () => new Promise((resolve) => {
      loads++;
      releaseLoad = () => resolve({ enabled: true, port: 7683, host: "127.0.0.1", user: "boot" });
    }),
  });
  assert.equal(web.start(), undefined);
  assert.equal(loads, 0, "startup's work begins after the current stack");
  const configure = call("web:configure", { port: 9000 });
  await tick();
  assert.equal(loads, 1);
  assert.equal(starts.length, 0);
  releaseLoad();
  assert.equal((await configure).port, 9000);
  assert.equal(loads, 1);
  assert.equal(starts.length, 2);
});

test("startup keeps config already changed by Settings rather than loading it again", async () => {
  const { web, call, log, starts } = ownedSetup();
  await call("web:configure", { port: 9000 });
  web.start();
  await web.inWebQueue(async () => {});
  assert.equal(log.filter(([what]) => what === "load").length, 1);
  assert.equal(starts.length, 0, "disabled config stays disabled");
  assert.equal(web.webStatus().port, 9000);
});

test("startup load failures are recorded in status and do not poison later queued work", async () => {
  for (const failure of [new Error("bad config"), "plain failure"]) {
    let failLoad = true;
    const { web, call } = ownedSetup({
      loadWebConfig: async () => {
        if (failLoad) throw failure;
        return { enabled: false, port: 9000, host: "::1", user: "retry" };
      },
    });
    web.start();
    await web.inWebQueue(async () => {});
    assert.equal(web.webStatus().error, failure instanceof Error ? failure.message : failure);
    failLoad = false;
    const status = await call("web:status");
    assert.equal(status.port, 9000);
    assert.deepEqual(status.urls, ["http://[::1]:9000"]);
    assert.equal((await call("web:configure", { enabled: false })).error, null);
  }
});
