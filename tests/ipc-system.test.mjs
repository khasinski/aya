// System IPC handlers (electron/ipc/system-ipc.ts): notification, Dock badge, settings panes, microphone,
// CLI, diagnostics and updates, on macOS and elsewhere.

import { test } from "node:test";
import assert from "node:assert/strict";

const { registerSystemIpc } = await import("../dist-electron/ipc/system-ipc.js");

function setup(platform = "darwin", over = {}) {
  const handlers = new Map();
  const log = [];
  const notifications = [];
  const badges = [];
  registerSystemIpc({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    senderWindow: (e) => e.win ?? null,
    platform,
    notifications: {
      isSupported: () => true,
      create: (options) => {
        const n = { options, listeners: {}, shown: false };
        n.on = (event, fn) => (n.listeners[event] = fn);
        n.show = () => (n.shown = true);
        notifications.push(n);
        return n;
      },
    },
    shell: { openExternal: async (url) => log.push(url) },
    systemPreferences: {
      getMediaAccessStatus: (kind) => `status:${kind}`,
      askForMediaAccess: async (kind) => kind === "microphone",
    },
    dock: { setBadge: (text) => badges.push(text) },
    cliStatus: () => "cli-status",
    installCli: () => "installed",
    diagnosticsReport: () => ({ report: true }),
    updateStatus: () => "update-status",
    checkForUpdates: () => "checked",
    installUpdate: () => "installing",
    ...over,
  });
  const call = (channel, e = {}, ...args) => handlers.get(channel)(e, ...args);
  return { handlers, call, log, notifications, badges };
}

test("registers exactly the system channels", () => {
  assert.deepEqual([...setup().handlers.keys()].sort(), [
    "app:cli-status",
    "app:diagnostics",
    "app:install-cli",
    "app:notify-waiting",
    "app:open-local-network-settings",
    "app:open-notification-settings",
    "app:set-dock-badge",
    "mic:open-settings",
    "mic:request",
    "mic:status",
    "updates:check",
    "updates:install",
    "updates:status",
  ]);
});

test("a waiting notification, once clicked, brings its window forward on that terminal", async () => {
  const sent = [];
  const win = {
    minimized: true,
    isDestroyed: () => false,
    isMinimized() { return this.minimized; },
    restore() { this.minimized = false; },
    focus() { sent.push("focus"); },
    webContents: { send: (channel, payload) => sent.push([channel, payload]) },
  };
  const { call, notifications } = setup();
  await call("app:notify-waiting", { win }, { projectSlug: "p", terminalId: "t", body: "needs you" });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].shown, true);
  notifications[0].listeners.click();
  assert.equal(win.minimized, false);
  assert.deepEqual(sent, ["focus", ["notification:select-terminal", { projectSlug: "p", terminalId: "t" }]]);
  await assert.rejects(call("app:notify-waiting", { win }, { projectSlug: "p", terminalId: "t" }), /\.body/);
});

test("no notification where the system has none", async () => {
  const { call, notifications } = setup("darwin", {
    notifications: { isSupported: () => false, create: () => assert.fail("created") },
  });
  await call("app:notify-waiting", {}, { projectSlug: "p", terminalId: "t", body: "x" });
  assert.equal(notifications.length, 0);
});

test("macOS: settings panes open, the microphone is asked, the badge is set", async () => {
  const { call, log, badges } = setup("darwin");
  await call("app:open-notification-settings");
  await call("app:open-local-network-settings");
  await call("mic:open-settings");
  assert.equal(log.length, 3);
  assert.ok(log.every((url) => url.startsWith("x-apple.systempreferences:")));
  assert.equal(await call("mic:status"), "status:microphone");
  assert.equal(await call("mic:request"), true);
  await call("app:set-dock-badge", {}, "3");
  await call("app:set-dock-badge", {}, "");
  assert.deepEqual(badges, ["3", ""]);
});

test("elsewhere: no settings panes, the microphone is unsupported, no badge", async () => {
  const { call, log, badges } = setup("linux");
  await call("app:open-notification-settings");
  await call("mic:open-settings");
  assert.deepEqual(log, []);
  assert.equal(await call("mic:status"), "unsupported");
  assert.equal(await call("mic:request"), true);
  await call("app:set-dock-badge", {}, "3");
  assert.deepEqual(badges, []);
});

test("CLI, diagnostics and updates answer from their deps", async () => {
  const { call } = setup();
  assert.equal(await call("app:cli-status"), "cli-status");
  assert.equal(await call("app:install-cli"), "installed");
  assert.deepEqual(await call("app:diagnostics"), { report: true });
  assert.equal(await call("updates:status"), "update-status");
  assert.equal(await call("updates:check"), "checked");
  assert.equal(await call("updates:install"), "installing");
});
