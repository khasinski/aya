// Main evaluates a fresh mirror; unavailable or malformed snapshots never permit a team message.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PtyHostClient, PANE_HOLD_UNKNOWN, PANE_HOLD_INVALID_SNAPSHOT } from "../dist-electron/pty-host-client.js";
import { openVtPane, writeVtPane, vtSnapshot, closeVtPane } from "../dist-electron/vt-mirror.js";
import { HOLD_NOT_RUNNING, HOLD_STARTING } from "../dist-electron/pane-holds.js";

function clientAnswering(answer) {
  const client = new PtyHostClient("/nonexistent/pty-host.js"), requests = [];
  client.request = async (request) => { requests.push(request); return answer(request); };
  return { client, requests };
}
async function shown(id, text, agent) {
  openVtPane(id, 80, 24, () => {}, agent);
  writeVtPane(id, text);
  const snapshot = await vtSnapshot(id);
  closeVtPane(id);
  return snapshot;
}
test("hold evaluates the host's snapshot in main, and sends no pasted text to the host", async () => {
  const snapshot = await shown("approval", "Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n", "claude");
  const { client, requests } = clientAnswering(() => snapshot);
  assert.equal(await client.holdReason("pane-1", "hello there"), "shows an approval prompt");
  assert.deepEqual(requests, [{ id: 0, type: "snapshot", ptyId: "pane-1" }]);
});
test("gone and starting are explicit; malformed answers fail closed", async () => {
  assert.equal(await clientAnswering(() => null).client.holdReason("p"), HOLD_NOT_RUNNING);
  assert.equal(await clientAnswering(() => "starting").client.holdReason("p"), HOLD_STARTING);
  for (const value of [5, true, {}, { rows: [] }])
    assert.equal(await clientAnswering(() => value).client.holdReason("p"), PANE_HOLD_INVALID_SNAPSHOT);
});
test("an older host without snapshot support holds the message and busy fails open", async () => {
  const { client } = clientAnswering(() => { throw new Error("unknown request"); });
  assert.equal(await client.holdReason("p"), PANE_HOLD_UNKNOWN);
  assert.equal(await client.paneBusy("p"), false);
});
test("busy evaluates the same applied Claude rule and unknown answers fail open", async () => {
  const snapshot = await shown("busy", "Working (esc to interrupt)\r\n", "claude");
  const { client, requests } = clientAnswering(() => snapshot);
  assert.equal(await client.paneBusy("pane-1"), true);
  assert.deepEqual(requests, [{ id: 0, type: "snapshot", ptyId: "pane-1" }]);
  assert.equal(await clientAnswering(() => "yes").client.paneBusy("p"), false);
});
