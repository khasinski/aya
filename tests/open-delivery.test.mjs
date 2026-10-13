// An "open this project" request must reach a page that can hear it: a loading
// page drops IPC, so delivery waits for its load and fails loudly otherwise.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const { deliverOpenProject, dispatchOpenProject, findDirInArgv, logOpenFailure } = await import("../dist-electron/open-delivery.js");

/** A BrowserWindow stand-in: emits "closed", its webContents emits load events. */
function fakeWindow({ loading = false, destroyed = false } = {}) {
  const win = new EventEmitter();
  const sent = [];
  win.webContents = new EventEmitter();
  win.webContents.isLoading = () => loading;
  win.webContents.send = (channel, dir) => sent.push([channel, dir]);
  win.isDestroyed = () => destroyed;
  return {
    win,
    sent,
    finishLoad() {
      loading = false;
      win.webContents.emit("did-finish-load");
    },
    close() {
      destroyed = true;
      win.emit("closed");
    },
  };
}

function listenerTotal(win) {
  return (
    win.listenerCount("closed") +
    win.webContents.listenerCount("did-finish-load") +
    win.webContents.listenerCount("did-fail-load") +
    win.webContents.listenerCount("render-process-gone")
  );
}

test("a loaded page gets the open at once", async () => {
  const { win, sent } = fakeWindow();
  await deliverOpenProject(win, "/p");
  assert.deepEqual(sent, [["open-project", "/p"]]);
});

test("a loading page gets the open on did-finish-load, not before", async () => {
  const w = fakeWindow({ loading: true });
  let settled = false;
  const delivery = deliverOpenProject(w.win, "/p").then(() => (settled = true));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(w.sent, []);
  assert.equal(settled, false);
  w.finishLoad();
  await delivery;
  assert.deepEqual(w.sent, [["open-project", "/p"]]);
  assert.equal(listenerTotal(w.win), 0);
});

test("did-finish-load delivers even if isLoading() still reads true there", async () => {
  const w = fakeWindow({ loading: true });
  const delivery = deliverOpenProject(w.win, "/p");
  w.win.webContents.emit("did-finish-load");
  await delivery;
  assert.deepEqual(w.sent, [["open-project", "/p"]]);
});

test("a window closed before its page loaded rejects, sending nothing", async () => {
  const w = fakeWindow({ loading: true });
  const delivery = deliverOpenProject(w.win, "/p");
  w.close();
  await assert.rejects(delivery, /window closed before it loaded/);
  assert.deepEqual(w.sent, []);
  assert.equal(listenerTotal(w.win), 0);
});

test("a main-frame load failure rejects with its description", async () => {
  const w = fakeWindow({ loading: true });
  const delivery = deliverOpenProject(w.win, "/p");
  w.win.webContents.emit("did-fail-load", {}, -6, "ERR_FILE_NOT_FOUND", "file:///x", true);
  await assert.rejects(delivery, /page failed to load: ERR_FILE_NOT_FOUND/);
  assert.equal(listenerTotal(w.win), 0);
});

test("a subframe load failure is ignored", async () => {
  const w = fakeWindow({ loading: true });
  const delivery = deliverOpenProject(w.win, "/p");
  w.win.webContents.emit("did-fail-load", {}, -3, "ERR_ABORTED", "about:blank", false);
  w.finishLoad();
  await delivery;
  assert.deepEqual(w.sent, [["open-project", "/p"]]);
});

test("an aborted main-frame load keeps waiting for the load that replaced it", async () => {
  const w = fakeWindow({ loading: true });
  let settled = false;
  const delivery = deliverOpenProject(w.win, "/p").then(() => (settled = true));
  w.win.webContents.emit("did-fail-load", {}, -3, "ERR_ABORTED", "http://localhost:5173/", true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false);
  w.finishLoad();
  await delivery;
  assert.deepEqual(w.sent, [["open-project", "/p"]]);
  assert.equal(listenerTotal(w.win), 0);
});

test("a renderer gone before the load rejects, sending nothing", async () => {
  const w = fakeWindow({ loading: true });
  const delivery = deliverOpenProject(w.win, "/p");
  w.win.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
  await assert.rejects(delivery, /renderer is gone: crashed/);
  assert.deepEqual(w.sent, []);
  assert.equal(listenerTotal(w.win), 0);
});

test("a destroyed window rejects at once", async () => {
  const { win, sent } = fakeWindow({ destroyed: true });
  await assert.rejects(deliverOpenProject(win, "/p"), /window closed before it loaded/);
  assert.deepEqual(sent, []);
});

test("an open the page never confirmed is sent again after its next load, a confirmed one is not", async () => {
  const { confirmOpen, replayOpensOnLoad } = await import("../dist-electron/open-delivery.js");
  const w = fakeWindow();
  replayOpensOnLoad(w.win);
  await deliverOpenProject(w.win, "/a");
  await deliverOpenProject(w.win, "/b");
  await deliverOpenProject(w.win, "/a");
  confirmOpen(w.win.webContents, "/a");
  w.sent.length = 0;
  w.finishLoad();
  assert.deepEqual(w.sent, [["open-project", "/b"], ["open-project", "/a"]]);
  confirmOpen(w.win.webContents, "/b");
  confirmOpen(w.win.webContents, "/a");
  w.sent.length = 0;
  w.finishLoad();
  assert.deepEqual(w.sent, []);
});

test("the first load replays nothing: the waiting open sends itself once", async () => {
  const { replayOpensOnLoad } = await import("../dist-electron/open-delivery.js");
  const w = fakeWindow({ loading: true });
  replayOpensOnLoad(w.win);
  const delivery = deliverOpenProject(w.win, "/p");
  w.finishLoad();
  await delivery;
  assert.deepEqual(w.sent, [["open-project", "/p"]]);
});

test("confirming an open never sent keeps the others to replay", async () => {
  const { confirmOpen, replayOpensOnLoad } = await import("../dist-electron/open-delivery.js");
  const w = fakeWindow();
  replayOpensOnLoad(w.win);
  await deliverOpenProject(w.win, "/a");
  confirmOpen(w.win.webContents, "/never-sent");
  w.sent.length = 0;
  w.finishLoad();
  assert.deepEqual(w.sent, [["open-project", "/a"]]);
});

test("argv opening skips the executable, flags, Electron paths, files and missing paths, then takes the first directory", (t) => {
  const root = mkdtempSync(join(tmpdir(), "aya-open-argv-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = join(root, "first");
  const second = join(root, "second");
  const main = join(root, "main.js");
  const electron = join(root, "node_modules/electron");
  for (const dir of [first, second, main, electron]) mkdirSync(dir, { recursive: true });
  const file = join(root, "file");
  writeFileSync(file, "not a directory");
  assert.equal(findDirInArgv([root]), null, "argv[0] is never a project");
  assert.equal(findDirInArgv(["aya", "", "--debug", main, electron, file, join(root, "missing"), relative(process.cwd(), first), second]), first);
  assert.equal(findDirInArgv(["aya", file, join(root, "missing")]), null);
});

test("a dot in argv uses Aya's cwd; a cwd failure keeps searching", (t) => {
  const root = mkdtempSync(join(tmpdir(), "aya-open-cwd-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.mock.method(process, "cwd", () => root);
  assert.equal(findDirInArgv(["aya", "."]), root);
  t.mock.method(process, "cwd", () => { throw new Error("cwd is gone"); });
  assert.equal(findDirInArgv(["aya", ".", root]), root);
});

test("dispatching without a window or a directory resolves without a renderer send", async () => {
  const w = fakeWindow();
  await dispatchOpenProject({ window: null }, "/p");
  await dispatchOpenProject({ window: w.win }, null);
  await dispatchOpenProject({ window: w.win }, "");
  assert.deepEqual(w.sent, []);
  assert.equal(listenerTotal(w.win), 0);
});

test("dispatching waits for the page to load and sends the project once", async () => {
  const w = fakeWindow({ loading: true });
  let done = false;
  const delivery = dispatchOpenProject({ window: w.win }, "/project").then(() => (done = true));
  await Promise.resolve();
  assert.equal(done, false);
  assert.deepEqual(w.sent, []);
  w.finishLoad();
  await delivery;
  assert.deepEqual(w.sent, [["open-project", "/project"]]);
});

test("dispatching propagates a delivery failure to the original open warning", async (t) => {
  const warned = [];
  t.mock.method(console, "warn", (...args) => warned.push(args));
  const w = fakeWindow({ destroyed: true });
  const failed = dispatchOpenProject({ window: w.win }, "/closed");
  await assert.rejects(failed, { message: "the window closed before it loaded" });
  await failed.catch(logOpenFailure("/closed"));
  assert.equal(warned.length, 1);
  assert.equal(warned[0][0], "[aya] could not open /closed:");
  const err = { message: "not an Error" };
  logOpenFailure(null)(err);
  assert.deepEqual(warned[1], ["[aya] could not open null:", err]);
});
