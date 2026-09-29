// PtyHostClient.dispose(): once Aya starts quitting, a request must fail
// instead of starting a pty host. A host started that late has no app to
// connect to, never arms its idle exit, and outlives the app (e2e runs leaked
// 2-8 per run). The "host script" here only records that it was started.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { waitFor } from "./helpers/wait-for.mjs";

const TMP_AYA_HOME = mkdtempSync(join(tmpdir(), "aya-dispose-"));
process.env.AYA_HOME = TMP_AYA_HOME;

const { PtyHostClient } = await import("../dist-electron/pty-host-client.js");

const SOCKET_PATH = join(TMP_AYA_HOME, "pty-host.sock");
const STARTED_MARKER = join(TMP_AYA_HOME, "host-started");
const FAKE_HOST = join(TMP_AYA_HOME, "fake-host.cjs");
writeFileSync(
  FAKE_HOST,
  `require("node:fs").writeFileSync(${JSON.stringify(STARTED_MARKER)}, "");`,
);

/** Long enough for the fake host to have written its marker had it started. */
const HOST_START_GRACE_MS = 1000;

test("a request after dispose rejects and starts no host", async () => {
  const client = new PtyHostClient(FAKE_HOST);
  client.dispose();
  await assert.rejects(client.getBuffer("t1"), /disposed/);
  await assert.rejects(client.kill("t1"), /disposed/);
  await new Promise((r) => setTimeout(r, HOST_START_GRACE_MS));
  assert.equal(existsSync(STARTED_MARKER), false);
});

test("a request still connecting when dispose runs starts no host", async () => {
  const client = new PtyHostClient(FAKE_HOST);
  const pending = client.getBuffer("t1");
  client.dispose();
  await assert.rejects(pending, /disposed/);
  await new Promise((r) => setTimeout(r, HOST_START_GRACE_MS));
  assert.equal(existsSync(STARTED_MARKER), false);
});

test("a shutdown issued right before dispose still reaches the host", async () => {
  const received = [];
  const connections = new Set();
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      for (const line of chunk.split("\n").filter(Boolean)) {
        const req = JSON.parse(line);
        received.push(req.type);
        socket.write(`${JSON.stringify({ id: req.id, ok: true, result: null })}\n`);
      }
    });
  });
  await new Promise((r) => server.listen(SOCKET_PATH, r));
  try {
    const client = new PtyHostClient(FAKE_HOST);
    const shutdown = client.shutdown();
    client.dispose();
    await shutdown;
    await waitFor(() => received.includes("shutdown"));
    await assert.rejects(client.getBuffer("t1"), /disposed/);
    assert.deepEqual(received, ["shutdown"]);
  } finally {
    for (const socket of connections) socket.destroy();
    await new Promise((r) => server.close(r));
  }
});
