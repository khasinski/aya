// Aya Web settings IPC (electron/ipc/aya-web-ipc.ts) against stand-ins for the config owner in main.ts.

import { test } from "node:test";
import assert from "node:assert/strict";

const { registerAyaWebIpc } = await import("../dist-electron/ipc/aya-web-ipc.js");
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

test("two changes at once both stay: each reads the config the other saved, through a serial queue", async () => {
  // A real one-after-another queue, as main.ts's inWebQueue is, and a save that takes a while.
  let tail = Promise.resolve();
  const inQueue = (change) => {
    const run = tail.then(change);
    tail = run.catch(() => undefined);
    return run;
  };
  let live = { enabled: false, port: 7683, host: "127.0.0.1", user: "me", ...webCredentials("first", true) };
  const handlers = new Map();
  registerAyaWebIpc({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    inQueue,
    config: async () => live,
    save: async (next) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      live = next;
    },
    apply: async () => {},
    status: () => live,
  });
  const configure = (req) => handlers.get("web:configure")({}, req);
  await Promise.all([configure({ port: 9000 }), configure({ host: "100.64.0.7" })]);
  assert.equal(live.port, 9000);
  assert.equal(live.host, "100.64.0.7");
});
