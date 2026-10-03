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

const { PTY_HOST_UNKNOWN_REQUEST } = await import("../dist-electron/constants.js");
const { PtyHostClient } = await import("../dist-electron/pty-host-client.js");
const { PTY_HOST_SOCKET_PATH } = await import("../dist-electron/paths.js");
assert.ok(PTY_HOST_SOCKET_PATH.startsWith(TMP_AYA_HOME + "/"), `pty host socket outside the test's home: ${PTY_HOST_SOCKET_PATH}`);

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

/** Ask getSize of a fake host that answers every request with `answer`. */
async function sizeFromFakeHost(answer) {
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
        socket.write(`${JSON.stringify({ id, ...answer })}\n`);
      }
    });
  });
  await new Promise((r) => server.listen(PTY_HOST_SOCKET_PATH, r));
  const client = new PtyHostClient(HOST_SCRIPT);
  try {
    const size = await client.getSize("any");
    return { size, requests: [...requests] };
  } finally {
    client.restart().catch(() => {});
    await new Promise((r) => server.close(r));
  }
}

test("a host that predates the size request reads as an unknown size", async () => {
  const { size, requests } = await sizeFromFakeHost({ ok: false, error: PTY_HOST_UNKNOWN_REQUEST });
  assert.equal(size, null);
  assert.deepEqual(requests, ["size"]);
});

test("a size answer without numeric cols and rows reads as unknown", async () => {
  for (const result of ["80x24", { cols: 80 }, { rows: 24 }, { cols: "80", rows: 24 }]) {
    const { size } = await sizeFromFakeHost({ ok: true, result });
    assert.equal(size, null, JSON.stringify(result));
  }
});

test("the alt-screen flag passes only as a boolean", async () => {
  const alt = async (value) =>
    (await sizeFromFakeHost({ ok: true, result: { cols: 80, rows: 24, alt: value } })).size;
  assert.deepEqual(await alt(true), { cols: 80, rows: 24, alt: true });
  assert.deepEqual(await alt(false), { cols: 80, rows: 24, alt: false });
  assert.deepEqual(await alt("yes"), { cols: 80, rows: 24 });
});

test("the host reports whether a pane holds the alt screen", async (t) => {
  const client = new PtyHostClient(HOST_SCRIPT);
  t.after(async () => {
    await client.kill("alt-1").catch(() => {});
    await client.shutdown().catch(() => {});
  });
  await client.spawn({
    ptyId: "alt-1",
    // One program: the spawn prefixes `exec`, which would end at printf.
    command: `sh -c "printf '\\033[?1049h'; exec cat"`,
    cwd: TMP_AYA_HOME,
    cols: 80,
    rows: 24,
  });
  // A login shell starts first; under a loaded full suite that took over 4 s.
  assert.equal(await waitFor(async () => (await client.getSize("alt-1"))?.alt, 20_000), true);
});

test("the host reports a live pane's size, following resizes", async (t) => {
  const client = new PtyHostClient(HOST_SCRIPT);
  t.after(async () => {
    await client.kill("size-1").catch(() => {});
    await client.shutdown().catch(() => {});
  });
  await client.spawn({ ptyId: "size-1", command: "cat", cwd: TMP_AYA_HOME, cols: 91, rows: 33 });
  await waitFor(() => client.getSize("size-1"), 20_000);
  assert.deepEqual(await client.getSize("size-1"), { cols: 91, rows: 33, alt: false });
  await client.resize("size-1", 120, 40);
  assert.deepEqual(await client.getSize("size-1"), { cols: 120, rows: 40, alt: false });
  assert.equal(await client.getSize("no-such-pane"), null);
});
