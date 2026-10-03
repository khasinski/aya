// holdReason must never throw into a team send: a host from an older build rejects
// the "hold" request, and that reads as PANE_HOLD_UNKNOWN (fails closed; its text says how to fix it).

import { test } from "node:test";
import assert from "node:assert/strict";
import { PTY_HOST_UNKNOWN_REQUEST } from "../dist-electron/constants.js";
import { PtyHostClient } from "../dist-electron/pty-host-client.js";

function clientAnswering(answer) {
  const client = new PtyHostClient("/nonexistent/pty-host.js");
  const requests = [];
  client.request = async (request) => {
    requests.push(request);
    return answer();
  };
  return { client, requests };
}

test("holdReason passes the host's reason through", async () => {
  const { client, requests } = clientAnswering(() => "shows an approval prompt");
  assert.equal(await client.holdReason("pane-1"), "shows an approval prompt");
  assert.deepEqual(requests, [{ id: 0, type: "hold", ptyId: "pane-1" }]);
});

test("holdReason tells the host what was pasted, so the host can ignore it", async () => {
  const { client, requests } = clientAnswering(() => null);
  await client.holdReason("pane-1", "hello there");
  assert.deepEqual(requests, [{ id: 0, type: "hold", ptyId: "pane-1", pasted: "hello there" }]);
});

test("holdReason is null when the host holds nothing or answers something else", async () => {
  assert.equal(await clientAnswering(() => null).client.holdReason("p"), null);
  assert.equal(await clientAnswering(() => 5).client.holdReason("p"), null);
});

test("holdReason holds the message when the host cannot answer (fails closed)", async () => {
  const { PANE_HOLD_UNKNOWN } = await import("../dist-electron/pty-host-client.js");
  const { client } = clientAnswering(() => {
    throw new Error(PTY_HOST_UNKNOWN_REQUEST);
  });
  assert.equal(await client.holdReason("p"), PANE_HOLD_UNKNOWN);
});

test("paneBusy asks the host, and an old host that rejects the request reads as not busy", async () => {
  const { client, requests } = clientAnswering(() => true);
  assert.equal(await client.paneBusy("pane-1"), true);
  assert.deepEqual(requests, [{ id: 0, type: "busy", ptyId: "pane-1" }]);
  assert.equal(await clientAnswering(() => "yes").client.paneBusy("p"), false);
  const old = clientAnswering(() => {
    throw new Error(PTY_HOST_UNKNOWN_REQUEST);
  });
  assert.equal(await old.client.paneBusy("p"), false);
});
