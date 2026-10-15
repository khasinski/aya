// A surviving main client caches edges, but a new/reloaded renderer needs the current dialog again on replay.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PtyHostClient } from "../dist-electron/pty-host-client.js";
import { openVtPane, writeVtPane, closeVtPane, vtSnapshot } from "../dist-electron/vt-mirror.js";
import { HOLD_ACCOUNT_SETTING } from "../dist-electron/pane-holds.js";
const sink = () => {
  const events = [];
  return { events, isDestroyed: () => false, send: (_channel, event) => events.push(event) };
};
for (const [name, text, dialog] of [
  ["approval", "Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No", undefined],
  ["account setting", " Allow this read outside the working directories?\r\n ❯ 1. Yes, and keep allowing any reads outside the working directories\r\n   2. No, and block reads outside the working directories from now on\r\n   3. No, and ask again next time", HOLD_ACCOUNT_SETTING],
]) {
  test(`replay restores a quiet ${name} to a new sink on the same main client`, async () => {
    const id = name;
    openVtPane(id, 160, 24, () => {}, "claude");
    writeVtPane(id, text);
    const snapshot = await vtSnapshot(id);
    closeVtPane(id);
    const client = new PtyHostClient("/nonexistent/pty-host.js"), first = sink(), reloaded = sink();
    client.attachWebContents(first);
    const receive = (replay = false) => client.onData(JSON.stringify({
      type: "snapshot", ptyId: id, snapshot, ...(replay ? { replay: true } : {}),
    }) + "\n");
    receive();
    receive();
    assert.equal(first.events.length, 1, "live snapshots still deduplicate unchanged edges");
    client.detachWebContents(first);
    client.attachWebContents(reloaded);
    receive(true);
    assert.deepEqual(reloaded.events, [{ type: "vt-status", ptyId: id, waiting: true, ...(dialog ? { dialog } : {}) }]);
  });
}
