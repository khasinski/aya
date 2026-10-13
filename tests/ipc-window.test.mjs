// Window IPC handlers (electron/ipc/window-ipc.ts) against stand-in windows.

import { test } from "node:test";
import assert from "node:assert/strict";

const { registerWindowIpc } = await import("../dist-electron/ipc/window-ipc.js");

function fakeWindow(id, over = {}) {
  const log = [];
  return {
    id,
    log,
    destroyed: false,
    maximized: false,
    minimized: false,
    visible: true,
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    isDestroyed() { return this.destroyed; },
    isVisible() { return this.visible; },
    isMaximized() { return this.maximized; },
    isMinimized() { return this.minimized; },
    getBounds() { return this.bounds; },
    minimize() { log.push("minimize"); },
    maximize() { this.maximized = true; log.push("maximize"); },
    unmaximize() { this.maximized = false; log.push("unmaximize"); },
    restore() { this.minimized = false; log.push("restore"); },
    focus() { log.push("focus"); },
    close() { log.push("close"); },
    ...over,
  };
}

function setup() {
  const handlers = new Map();
  const listeners = new Map();
  const a = fakeWindow(1);
  const b = fakeWindow(2, { bounds: { x: 200, y: 0, width: 100, height: 100 } });
  const gone = fakeWindow(3);
  gone.destroyed = true;
  const opened = [];
  const confirmed = [];
  const fullScreen = new Map();
  const created = fakeWindow(9);
  registerWindowIpc({
    ipcMain: {
      handle: (channel, fn) => handlers.set(channel, fn),
      on: (channel, fn) => listeners.set(channel, fn),
    },
    senderWindow: (e) => e.win ?? null,
    windows: () => [a, b, gone],
    activeProjectOf: (id) => `project-${id}`,
    openNewWindow: async (at) => ((created.at = at), created),
    openProjectIn: (win, dir) => opened.push([win.id, dir]),
    confirmOpen: (sender, dir) => confirmed.push([sender, dir]),
    isFullScreen: (win) => fullScreen.get(win.id) ?? false,
    setFullScreen: (win, value) => fullScreen.set(win.id, value),
  });
  const call = (channel, e, ...args) => handlers.get(channel)(e, ...args);
  return { handlers, listeners, call, a, b, created, opened, confirmed, fullScreen };
}

test("registers the window channels and the open-project handshake", () => {
  const { handlers, listeners } = setup();
  assert.deepEqual([...handlers.keys()].sort(), [
    "app:close",
    "app:is-fullscreen",
    "app:is-maximized",
    "app:minimize",
    "app:set-fullscreen",
    "app:toggle-maximize",
    "window:reload",
    "windows:adopt-project",
    "windows:list-others",
    "windows:resolve-drop",
  ]);
  assert.deepEqual([...listeners.keys()], ["open-project:done"]);
});

test("other windows: live ones but the caller, with their active project", async () => {
  const { call, a } = setup();
  assert.deepEqual(await call("windows:list-others", { win: a }), [{ id: 2, activeProject: "project-2" }]);
});

test("a dropped tab lands on the window under the point; bad coordinates are refused", async () => {
  const { call, a } = setup();
  assert.deepEqual(await call("windows:resolve-drop", { win: a }, 250, 50), { kind: "window", id: 2 });
  assert.deepEqual(await call("windows:resolve-drop", { win: a }, 50, 50), { kind: "self" });
  assert.deepEqual(await call("windows:resolve-drop", { win: a }, 900, 900), { kind: "new" });
  await assert.rejects(call("windows:resolve-drop", { win: a }, "1", 2), /x\/y must be numbers/);
});

test("adopting a project: into a new window at the drop point, or a named live one, focused", async () => {
  const { call, b, created, opened } = setup();
  await call("windows:adopt-project", {}, "/p/one", "new", { x: 5, y: 6 });
  assert.deepEqual(created.at, { x: 5, y: 6 });
  assert.ok(created.log.includes("focus"));
  b.minimized = true;
  await call("windows:adopt-project", {}, "/p/two", 2);
  assert.deepEqual(b.log, ["restore", "focus"]);
  assert.deepEqual(opened, [[9, "/p/one"], [2, "/p/two"]]);
  await assert.rejects(call("windows:adopt-project", {}, "/p/x", 3), /target window not found/);
});

test("window chrome acts on the sender only, and is a no-op without one", async () => {
  const { call, a, fullScreen } = setup();
  await call("app:toggle-maximize", { win: a });
  await call("app:toggle-maximize", { win: a });
  await call("app:minimize", { win: a });
  await call("app:close", { win: a });
  assert.deepEqual(a.log, ["maximize", "unmaximize", "minimize", "close"]);
  await call("app:set-fullscreen", { win: a }, 1);
  assert.equal(await call("app:is-fullscreen", { win: a }), true);
  assert.equal(fullScreen.get(1), true);
  assert.equal(await call("app:is-maximized", {}), false);
  assert.equal(await call("app:is-fullscreen", {}), false);
  await call("app:minimize", {});
  let reloaded = 0;
  await call("window:reload", { sender: { reload: () => reloaded++ } });
  await call("window:reload", { sender: null });
  assert.equal(reloaded, 1);
});

test("open-project:done confirms only a directory string", () => {
  const { listeners, confirmed } = setup();
  const sender = {};
  listeners.get("open-project:done")({ sender }, "/p/one");
  listeners.get("open-project:done")({ sender }, 7);
  assert.deepEqual(confirmed, [[sender, "/p/one"]]);
});
