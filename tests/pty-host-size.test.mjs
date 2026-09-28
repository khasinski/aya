// `aya pane read` renders a pane at the size it actually has, which only the
// pty host knows. A host from an older build cannot answer; the client must
// then say "unknown" so the read falls back to the raw buffer.
//
// Own AYA_HOME (socket namespace): the fake old host and the real one take
// turns on the same socket path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP_AYA_HOME = mkdtempSync(join(tmpdir(), "aya-size-"));
process.env.AYA_HOME = TMP_AYA_HOME;

const { PtyHostClient } = await import("../dist-electron/pty-host-client.js");
const { PTY_HOST_SOCKET_PATH } = await import("../dist-electron/paths.js");

const HOST_SCRIPT = join(process.cwd(), "dist-electron", "pty-host.js");

async function waitFor(predicate, ms = 4000, step = 25) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await predicate();
    if (v) return v;
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error(`waitFor timed out after ${ms}ms`);
}

test("a host that predates the size request reads as an unknown size", async () => {
  const requests = [];
  const server = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        const { id, type } = JSON.parse(line);
        requests.push(type);
        socket.write(`${JSON.stringify({ id, ok: false, error: "unknown request" })}\n`);
      }
    });
  });
  await new Promise((r) => server.listen(PTY_HOST_SOCKET_PATH, r));
  const client = new PtyHostClient(HOST_SCRIPT);
  try {
    assert.equal(await client.getSize("any"), null);
    assert.deepEqual(requests, ["size"]);
  } finally {
    client.restart().catch(() => {});
    await new Promise((r) => server.close(r));
  }
});

test("the host reports a live pane's size, following resizes", async (t) => {
  const client = new PtyHostClient(HOST_SCRIPT);
  t.after(async () => {
    await client.kill("size-1").catch(() => {});
    await client.shutdown().catch(() => {});
  });
  await client.spawn({ ptyId: "size-1", command: "cat", cwd: TMP_AYA_HOME, cols: 91, rows: 33 });
  await waitFor(() => client.getSize("size-1"));
  assert.deepEqual(await client.getSize("size-1"), { cols: 91, rows: 33 });
  await client.resize("size-1", 120, 40);
  assert.deepEqual(await client.getSize("size-1"), { cols: 120, rows: 40 });
  assert.equal(await client.getSize("no-such-pane"), null);
});
