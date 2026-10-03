// Proving who runs an `aya team` command needs the pane's process (caller-proof.ts);
// only the pty host has it. A host from an older build answers "unknown request".

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP_AYA_HOME = mkdtempSync(join(tmpdir(), "aya-pid-"));
process.env.AYA_HOME = TMP_AYA_HOME;

const { PTY_HOST_UNKNOWN_REQUEST } = await import("../dist-electron/constants.js");
const { PtyHostClient } = await import("../dist-electron/pty-host-client.js");
const { PTY_HOST_SOCKET_PATH } = await import("../dist-electron/paths.js");
assert.ok(PTY_HOST_SOCKET_PATH.startsWith(TMP_AYA_HOME + "/"), `pty host socket outside the test's home: ${PTY_HOST_SOCKET_PATH}`);
const { readProcessTable } = await import("../dist-electron/caller-proof.js");

const HOST_SCRIPT = join(process.cwd(), "dist-electron", "pty-host.js");

async function waitFor(predicate, ms = 20_000, step = 50) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await predicate();
    if (v) return v;
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error(`waitFor timed out after ${ms}ms`);
}

async function pidFromFakeHost(answer) {
  const server = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) socket.write(`${JSON.stringify({ id: JSON.parse(line).id, ...answer })}\n`);
    });
  });
  await new Promise((r) => server.listen(PTY_HOST_SOCKET_PATH, r));
  const client = new PtyHostClient(HOST_SCRIPT);
  try {
    return await client.getPid("any");
  } finally {
    client.restart().catch(() => {});
    await new Promise((r) => server.close(r));
  }
}

test("a host that predates the pid request cannot say (undefined, not 'no process')", async () => {
  assert.equal(await pidFromFakeHost({ ok: false, error: PTY_HOST_UNKNOWN_REQUEST }), undefined);
});

test("a pid answer that is not a positive number cannot say; null means the pane has no process", async () => {
  for (const result of ["12", 0, -3, {}]) {
    assert.equal(await pidFromFakeHost({ ok: true, result }), undefined, JSON.stringify(result));
  }
  assert.equal(await pidFromFakeHost({ ok: true, result: null }), null);
});

test("the host reports the process a pane runs, the parent of what the pane starts", async (t) => {
  const client = new PtyHostClient(HOST_SCRIPT);
  t.after(async () => {
    await client.kill("pid-1").catch(() => {});
    await client.shutdown().catch(() => {});
  });
  await client.spawn({ ptyId: "pid-1", command: `sh -c "sleep 60 & wait"`, cwd: TMP_AYA_HOME, cols: 80, rows: 24 });
  const pid = await waitFor(() => client.getPid("pid-1"));
  const child = await waitFor(async () => [...((await readProcessTable()) ?? [])].find(([, proc]) => proc.ppid === pid));
  assert.ok(child, "a process runs under the pane's pid");
  assert.equal(await client.getPid("no-such-pane"), null);
});
