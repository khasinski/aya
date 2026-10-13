// Aya Web invokes captured IPC handlers against a stand-in ipcMain, without Electron or a server.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  captureIpcHandlers,
  hasCapturedIpcHandler,
  invokeCapturedIpcHandler,
} from "../dist-electron/ipc/web-capture.js";

test("capture forwards registration with the original receiver and return value", () => {
  const registrations = [];
  const listener = () => "reply";
  const ipcMain = {
    handle(channel, fn) {
      assert.equal(this, ipcMain);
      registrations.push([channel, fn]);
      return "registered";
    },
  };
  captureIpcHandlers(ipcMain);
  assert.equal(ipcMain.handle("capture-test:register", listener), "registered");
  assert.deepEqual(registrations, [["capture-test:register", listener]]);
  assert.equal(hasCapturedIpcHandler("capture-test:register"), true);
});

test("invocation passes a windowless event and unchanged arguments, awaiting the handler", async () => {
  const ipcMain = { handle() {} };
  captureIpcHandlers(ipcMain);
  const payload = { text: "hello" };
  ipcMain.handle("capture-test:invoke", async (event, ...args) => {
    assert.deepEqual(event, { sender: null });
    assert.equal(args[0], payload);
    assert.deepEqual(args.slice(1), [null, 7]);
    return payload;
  });
  assert.equal(await invokeCapturedIpcHandler("capture-test:invoke", [payload, null, 7]), payload);
});

test("unknown channels reject with the existing message", async () => {
  assert.equal(hasCapturedIpcHandler("capture-test:missing"), false);
  await assert.rejects(invokeCapturedIpcHandler("capture-test:missing", []), {
    message: "Unknown channel: capture-test:missing",
  });
});

test("synchronous throws and asynchronous rejections reach the caller unchanged", async () => {
  const ipcMain = { handle() {} };
  captureIpcHandlers(ipcMain);
  const error = new Error("handler failed");
  ipcMain.handle("capture-test:throw", () => { throw error; });
  ipcMain.handle("capture-test:reject", async () => { throw error; });
  for (const channel of ["capture-test:throw", "capture-test:reject"]) {
    await assert.rejects(invokeCapturedIpcHandler(channel, []), (actual) => actual === error);
  }
});

test("later registrations replace a captured handler and all captures share the same map", async () => {
  const first = { handle() {} };
  const second = { handle() {} };
  captureIpcHandlers(first);
  captureIpcHandlers(second);
  first.handle("capture-test:shared", () => "first");
  assert.equal(await invokeCapturedIpcHandler("capture-test:shared", []), "first");
  second.handle("capture-test:shared", () => "second");
  assert.equal(await invokeCapturedIpcHandler("capture-test:shared", []), "second");
});
