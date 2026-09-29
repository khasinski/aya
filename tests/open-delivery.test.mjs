// An "open this project" request must reach a page that can hear it: a loading
// page drops IPC, so delivery waits for its load and fails loudly otherwise.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const { deliverOpenProject } = await import("../dist-electron/open-delivery.js");

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
