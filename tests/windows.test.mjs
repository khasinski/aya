// Window creation and lifecycle against Electron and host stand-ins; no files or sockets are opened.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createAyaWindows } from "../dist-electron/windows.js";
import { createWindowProjectState } from "../dist-electron/window-slices.js";
import { deliverOpenProject } from "../dist-electron/open-delivery.js";

const initial = { x: 100, y: 200, width: 1000, height: 700, isFullScreen: false, isMaximized: false };
const disk = { version: 1, order: ["a", "b"], open: ["a", "b"], recent: [], activeProject: "a" };

function setup(over = {}) {
  const log = [];
  const made = [];
  let focused = null;
  let quitting = false;
  class Contents extends EventEmitter {
    constructor(id) { super(); this.id = id; this.zoom = 0; }
    on(event, fn) { log.push(["contents-listener", this.id, event]); return super.on(event, fn); }
    send(...args) { log.push(["send", this.id, ...args]); }
    isLoading() { return false; }
    getZoomLevel() { return this.zoom; }
    setZoomLevel(value) { this.zoom = value; log.push(["zoom", this.id, value]); }
    setWindowOpenHandler(fn) { this.openHandler = fn; log.push(["open-handler", this.id]); }
    openDevTools(options) { log.push(["devtools", this.id, options]); }
  }
  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.id = made.length + 1;
      this.options = options;
      this.contents = new Contents(this.id);
      this.destroyed = false;
      this.fullScreen = false;
      this.maximized = false;
      made.push(this);
      log.push(["create", this.id]);
    }
    static getFocusedWindow() { return focused; }
    get webContents() { if (this.destroyed) throw new Error("closed window getter"); return this.contents; }
    on(event, fn) { log.push(["window-listener", this.id, event]); return super.on(event, fn); }
    isDestroyed() { return this.destroyed; }
    getBounds() { return { x: this.options.x ?? 0, y: this.options.y ?? 0, width: this.options.width, height: this.options.height }; }
    getNativeWindowHandle() { return Buffer.from([this.id]); }
    setWindowButtonVisibility(value) { log.push(["buttons", this.id, value]); }
    isFullScreen() { return this.fullScreen; }
    setFullScreen(value) { this.fullScreen = value; log.push(["fullscreen", this.id, value]); }
    isMaximized() { return this.maximized; }
    maximize() { this.maximized = true; log.push(["maximize", this.id]); }
    show() { log.push(["show", this.id]); }
    loadURL(url) { log.push(["url", this.id, url]); }
    loadFile(file) { log.push(["file", this.id, file]); }
    close() { this.destroyed = true; this.emit("closed"); }
  }
  const projects = createWindowProjectState({
    listProjectState: async () => disk,
    saveProjectState: async (state) => { log.push(["save-projects", state]); },
    quitting: () => quitting,
  });
  const deps = {
    BrowserWindow: Window,
    ptyHost: {
      attachWebContents: (contents) => log.push(["attach", contents.id]),
      detachWebContents: (contents) => log.push(["detach", contents.id]),
    },
    platform: "linux",
    mainDirname: "/stand-in/electron",
    windowTitle: "Aya",
    darkBackground: "#0d1117",
    isDev: false,
    isE2eHeadless: false,
    devServerUrl: "http://localhost:5183",
    rendererIndexPath: "/stand-in/dist/index.html",
    maxKeyboardProjects: 9,
    loadWindowState: async () => { log.push(["load-state"]); return initial; },
    trackWindowState: (win) => log.push(["track", win.id]),
    startConfigWatcher: (win) => { log.push(["watch", win.id]); return () => log.push(["stop-watch", win.id]); },
    openExternalUrl: async (url) => { log.push(["external", url]); },
    claimBootWindow: projects.claimBootWindow,
    releaseWindowSlices: projects.releaseWindowSlices,
    quitting: () => quitting,
    loadMacOsWindowHack: () => { log.push(["load-hack"]); return { apply: (handle) => log.push(["hack", handle[0]]) }; },
    ...over,
  };
  const windows = createAyaWindows(deps);
  return { windows, projects, log, made, deps, focus: (win) => { focused = win; }, quit: () => { quitting = true; } };
}

function input(win, values) {
  let prevented = 0;
  win.contents.emit("before-input-event", { preventDefault: () => prevented++ }, {
    type: "keyDown", key: "t", code: "KeyT", control: false, meta: false, alt: false, shift: false, ...values,
  });
  return prevented;
}

test("creation preserves chrome, sandbox options, side effects and every listener's order", () => {
  const { windows, log } = setup();
  const win = windows.createWindow({ ...initial, isMaximized: true, isFullScreen: true });
  assert.deepEqual(win.options, {
    x: 100, y: 200, width: 1000, height: 700, minWidth: 800, minHeight: 500,
    title: "Aya", frame: false, roundedCorners: false, backgroundColor: "#0d1117", show: false,
    webPreferences: { preload: "/stand-in/electron/preload.bundle.js", contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  assert.deepEqual(log, [
    ["create", 1], ["maximize", 1], ["fullscreen", 1, true], ["send", 1, "app:fullscreen", true],
    ["track", 1], ["window-listener", 1, "focus"], ["attach", 1], ["watch", 1],
    ["window-listener", 1, "ready-to-show"], ["window-listener", 1, "closed"],
    ["window-listener", 1, "enter-full-screen"], ["window-listener", 1, "leave-full-screen"],
    ["window-listener", 1, "maximize"], ["window-listener", 1, "unmaximize"],
    ["contents-listener", 1, "did-finish-load"], ["contents-listener", 1, "did-finish-load"],
    ["open-handler", 1], ["contents-listener", 1, "will-navigate"], ["contents-listener", 1, "will-frame-navigate"],
    ["contents-listener", 1, "before-input-event"], ["contents-listener", 1, "before-input-event"],
    ["file", 1, "/stand-in/dist/index.html"],
  ]);
  win.emit("ready-to-show");
  win.emit("ready-to-show");
  assert.equal(log.filter(([what]) => what === "show").length, 1);
});

test("dev and headless windows keep load order, devtools and background throttling options", () => {
  const { windows, log } = setup({ isDev: true, isE2eHeadless: true, platform: "win32" });
  const win = windows.createWindow(initial);
  assert.equal(win.options.frame, undefined);
  assert.equal(win.options.titleBarStyle, undefined);
  assert.equal(win.options.webPreferences.backgroundThrottling, false);
  assert.deepEqual(log.slice(-2), [["url", 1, "http://localhost:5183"], ["devtools", 1, { mode: "detach" }]]);
  win.emit("ready-to-show");
  assert.equal(log.some(([what]) => what === "show"), false);
});

test("the window owner follows focus, supports live getter/setter access and filters destroyed windows", () => {
  const { windows, focus } = setup();
  assert.equal(windows.focusedAyaWindow(), null);
  const first = windows.createWindow(initial);
  const second = windows.createWindow(initial);
  assert.equal(windows.mainWindow, second);
  focus(first);
  assert.equal(windows.focusedAyaWindow(), first);
  focus({ id: 99 });
  assert.equal(windows.focusedAyaWindow(), second);
  first.emit("focus");
  assert.equal(windows.mainWindow, first);
  windows.mainWindow = second;
  assert.equal(windows.focusedAyaWindow(), second);
  second.destroyed = true;
  assert.equal(windows.focusedAyaWindow(), null);
  const live = [];
  windows.eachAyaWindow((win) => live.push(win));
  assert.deepEqual(live, [first]);
  assert.deepEqual([...windows.ayaWindows], [first, second]);
  assert.equal(windows.startupWindowCreated, false);
  windows.startupWindowCreated = true;
  assert.equal(windows.startupWindowCreated, true);
});

test("closing uses captured webContents, removes the window first and trims its slice after host/watcher cleanup", async () => {
  const s = setup();
  const first = s.windows.createWindow(initial);
  const second = s.windows.createWindow(initial);
  s.projects.projectStateForWindow(disk, first.id);
  s.projects.projectStateForWindow(disk, second.id);
  s.projects.windowSlices.mergeSave({ ...disk, open: ["c"] }, second.id, disk);
  assert.equal(s.log.filter(([what]) => what === "track").length, 1);
  s.deps.ptyHost.detachWebContents = (contents) => {
    assert.equal(s.windows.ayaWindows.has(second), false);
    assert.equal(s.windows.mainWindow, contents.id === second.id ? first : null);
    s.log.push(["detach", contents.id]);
  };
  s.log.length = 0;
  second.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(s.log, [
    ["detach", 2], ["stop-watch", 2], ["save-projects", { ...disk, open: ["a", "b"], recent: ["c"] }],
  ]);
  first.close();
  assert.equal(s.windows.mainWindow, null);
});

test("a cleanup failure still leaves the dead window absent from the registry", () => {
  const s = setup({ ptyHost: { attachWebContents() {}, detachWebContents() { throw new Error("detach failed"); } } });
  const win = s.windows.createWindow(initial);
  assert.throws(() => win.close(), /detach failed/);
  assert.equal(s.windows.ayaWindows.size, 0);
  assert.equal(s.windows.mainWindow, null);
});

test("extra windows cascade from the focused bounds or clamp tear-out coordinates, without restoring maximized/fullscreen", async () => {
  const { windows, log } = setup();
  const first = windows.createWindow({ ...initial, isMaximized: true, isFullScreen: true });
  const cascaded = await windows.openNewWindow();
  assert.deepEqual(cascaded.getBounds(), { x: 128, y: 228, width: 1000, height: 700 });
  assert.equal(cascaded.fullScreen, false);
  assert.equal(cascaded.maximized, false);
  const torn = await windows.openNewWindow({ x: 60, y: 10 });
  assert.deepEqual(torn.getBounds(), { x: 0, y: 0, width: 1000, height: 700 });
  windows.mainWindow = first;
  const placed = await windows.openNewWindow({ x: 400, y: 600 });
  assert.deepEqual(placed.getBounds(), { x: 320, y: 580, width: 1000, height: 700 });
  assert.equal(log.some(([what]) => what === "load-state"), false);
});

test("an extra window with no anchor inherits saved size and drops saved position and flags", async () => {
  const { windows, log } = setup({ loadWindowState: async () => ({ ...initial, isFullScreen: true, isMaximized: true }) });
  const win = await windows.openNewWindow();
  assert.equal(win.options.x, undefined);
  assert.equal(win.options.y, undefined);
  assert.equal(win.options.width, 1000);
  assert.equal(win.options.height, 700);
  assert.equal(log.some(([what]) => what === "maximize" || what === "fullscreen"), false);
});

test("outside opens and activate share one pending creation, reuse live windows and refuse creation while quitting", async () => {
  let release;
  let loads = 0;
  const s = setup({ loadWindowState: () => { loads++; return new Promise((resolve) => { release = () => resolve(initial); }); } });
  const opens = [s.windows.windowForOpen(), s.windows.windowForOpen(), s.windows.createWindowOnce()];
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loads, 1);
  release();
  const wins = await Promise.all(opens);
  assert.ok(wins.every((win) => win === wins[0]));
  assert.equal(s.made.length, 1);
  assert.equal(await s.windows.windowForOpen(), wins[0]);
  s.quit();
  await assert.rejects(s.windows.windowForOpen(), /Aya is quitting; run it again once it has quit/);
  await assert.rejects(s.windows.createWindowOnce(), /quitting/);
  assert.equal(loads, 1);
});

test("fullscreen setters broadcast the actual state, toggle live windows and ignore absent or destroyed windows", () => {
  const { windows, log } = setup();
  const win = windows.createWindow(initial);
  log.length = 0;
  win.setFullScreen = (value) => log.push(["requested", value]);
  windows.setAyaFullScreen(win, true);
  assert.deepEqual(log, [["requested", true], ["send", 1, "app:fullscreen", false]]);
  win.fullScreen = true;
  log.length = 0;
  windows.toggleAyaFullScreen(win);
  assert.deepEqual(log, [["requested", false], ["send", 1, "app:fullscreen", true]]);
  win.destroyed = true;
  log.length = 0;
  windows.setAyaFullScreen(win, true);
  windows.toggleAyaFullScreen(win);
  windows.toggleAyaFullScreen(null);
  assert.deepEqual(log, []);
});

test("macOS hides window buttons, caches the native hack, and reapplies it after exactly 250ms", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { windows, log } = setup({ platform: "darwin" });
  const win = windows.createWindow(initial);
  assert.equal(win.options.titleBarStyle, "hidden");
  assert.deepEqual(log.slice(0, 4), [["create", 1], ["buttons", 1, false], ["load-hack"], ["hack", 1]]);
  log.length = 0;
  win.emit("enter-full-screen");
  assert.deepEqual(log, [["send", 1, "app:fullscreen", true], ["hack", 1]]);
  t.mock.timers.tick(249);
  assert.equal(log.length, 2);
  t.mock.timers.tick(1);
  assert.deepEqual(log.at(-1), ["hack", 1]);
  win.emit("leave-full-screen");
  assert.deepEqual(log.slice(-2), [["send", 1, "app:fullscreen", false], ["hack", 1]]);
  windows.createWindow(initial);
  assert.equal(log.some(([what]) => what === "load-hack"), false);
  win.emit("enter-full-screen");
  win.destroyed = true;
  log.length = 0;
  t.mock.timers.tick(250);
  assert.deepEqual(log, []);
});

test("a missing native hack is tried once and warned about only in dev; a failing apply is retried", (t) => {
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args));
  for (const isDev of [false, true]) {
    let loads = 0;
    const s = setup({ platform: "darwin", isDev, loadMacOsWindowHack: () => { loads++; throw new Error("missing"); } });
    const win = s.windows.createWindow(initial);
    s.windows.applyMacOsWindowHack(win);
    assert.equal(loads, 1);
    assert.equal(warnings.length, isDev ? 1 : 0);
  }
  assert.equal(warnings[0][0], "macOS window hack unavailable");
  let applies = 0;
  const s = setup({ platform: "darwin", isDev: true, loadMacOsWindowHack: () => ({ apply() { applies++; throw new Error("apply failed"); } }) });
  const win = s.windows.createWindow(initial);
  s.windows.applyMacOsWindowHack(win);
  assert.equal(applies, 2);
  assert.deepEqual(warnings.slice(1).map(([message]) => message), ["macOS window hack failed", "macOS window hack failed"]);
});

test("load replays pending opens before initial fullscreen/maximize state, and the initial broadcast runs once", async () => {
  const { windows, log } = setup();
  const win = windows.createWindow({ ...initial, isFullScreen: true, isMaximized: true });
  await deliverOpenProject(win, "/stand-in/project");
  log.length = 0;
  win.contents.emit("did-finish-load");
  assert.deepEqual(log, [["send", 1, "open-project", "/stand-in/project"], ["send", 1, "app:fullscreen", true], ["send", 1, "app:maximized", true]]);
  log.length = 0;
  win.contents.emit("did-finish-load");
  assert.deepEqual(log, [["send", 1, "open-project", "/stand-in/project"]]);
  log.length = 0;
  win.emit("maximize");
  win.emit("unmaximize");
  assert.deepEqual(log, [["send", 1, "app:maximized", true], ["send", 1, "app:maximized", false]]);
  win.destroyed = true;
  log.length = 0;
  win.emit("maximize");
  win.emit("leave-full-screen");
  assert.deepEqual(log, []);
});

test("main and frame navigation keep internal pages, prevent external navigation and open safe URLs once", () => {
  for (const isDev of [false, true]) {
    const { windows, log } = setup({ isDev });
    const win = windows.createWindow(initial);
    for (const eventName of ["will-navigate", "will-frame-navigate"]) {
      let prevented = 0;
      const emit = (url) => win.contents.emit(eventName, { preventDefault: () => prevented++ }, eventName === "will-navigate" ? url : { url });
      log.length = 0;
      emit(isDev ? "http://localhost:5183/page" : "file:///stand-in/dist/index.html#tab");
      assert.equal(prevented, 0);
      emit("https://example.test/path");
      emit("javascript:alert(1)");
      assert.equal(prevented, 2);
      assert.deepEqual(log, [["external", "https://example.test/path"]]);
    }
    log.length = 0;
    assert.deepEqual(win.contents.openHandler({ url: "https://example.test/new" }), { action: "deny" });
    assert.deepEqual(win.contents.openHandler({ url: "javascript:alert(1)" }), { action: "deny" });
    assert.deepEqual(log, [["external", "https://example.test/new"]]);
  }
});

test("keyboard shortcuts keep platform modifiers, actions, reload blocking and modifier exclusions", () => {
  for (const platform of ["linux", "darwin"]) {
    const { windows, log } = setup({ platform });
    const win = windows.createWindow(initial);
    const mod = platform === "darwin" ? { meta: true } : { control: true };
    for (const [key, action] of [["T", "new-shell"], ["w", "close-tab"], [",", "open-settings"], ["[", "prev-tab"], ["]", "next-tab"], ["f", "find-in-pane"], ["k", "search"], ["1", "project-1"], ["9", "project-9"]]) {
      log.length = 0;
      assert.equal(input(win, { ...mod, key }), 1);
      assert.deepEqual(log, [["send", 1, "shortcut", action]]);
    }
    for (const [key, code, action] of [["ArrowLeft", "", "focus-pane-left"], ["ArrowRight", "", "focus-pane-right"], ["ArrowUp", "", "focus-pane-up"], ["ArrowDown", "", "focus-pane-down"], ["\\", "", "split-pane-right"], ["|", "Backslash", "split-pane-right"], ["-", "", "split-pane-below"]]) {
      log.length = 0;
      assert.equal(input(win, { ...mod, alt: true, key, code }), 1);
      assert.deepEqual(log, [["send", 1, "shortcut", action]]);
    }
    log.length = 0;
    assert.equal(input(win, { ...mod, key: "r" }), 1);
    assert.deepEqual(log, []);
    for (const values of [{}, { ...mod, shift: true }, { ...mod, alt: true }, { ...mod, alt: true, shift: true }, { ...mod, type: "keyUp" }, { ...mod, key: "x" }]) {
      assert.equal(input(win, values), 0);
    }
    assert.deepEqual(log, []);
    win.destroyed = true;
    assert.equal(input(win, { ...mod }), 1);
    assert.deepEqual(log, []);
  }
});

test("zoom installs before shortcut handling and still changes Chromium's zoom level", () => {
  const { windows } = setup({ platform: process.platform });
  const win = windows.createWindow(initial);
  const mod = process.platform === "darwin" ? { meta: true } : { control: true };
  assert.equal(input(win, { ...mod, key: "+" }), 1);
  assert.equal(win.contents.zoom, 1);
  input(win, { ...mod, key: "0" });
  assert.equal(win.contents.zoom, 0);
});
