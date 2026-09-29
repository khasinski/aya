// holdReason must never fail a team send: a host from an older build rejects
// the "hold" request, and that reads as "nothing holds the pane".

import { test } from "node:test";
import assert from "node:assert/strict";
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

test("holdReason is null when the host holds nothing or answers something else", async () => {
  assert.equal(await clientAnswering(() => null).client.holdReason("p"), null);
  assert.equal(await clientAnswering(() => 5).client.holdReason("p"), null);
});

test("holdReason holds the message when the host cannot answer (fails closed)", async () => {
  const { PANE_HOLD_UNKNOWN } = await import("../dist-electron/pty-host-client.js");
  const { client } = clientAnswering(() => {
    throw new Error("unknown request");
  });
  assert.equal(await client.holdReason("p"), PANE_HOLD_UNKNOWN);
});
