// A host's listen() creates its socket file at bind, a moment before it accepts; a client that
// connects in that moment is refused (it failed a macOS CI run three times). The client must
// retry a started host's refused socket until its deadline. The "host" here leaves a socket file
// nobody accepts on, then, after FAKE_HOST_REFUSE_MS, listens for real.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP_AYA_HOME = mkdtempSync(join(tmpdir(), "aya-refused-"));
process.env.AYA_HOME = TMP_AYA_HOME;

const { PtyHostClient, PTY_HOST_SOCKET_WAIT_TIMEOUT_MS } = await import("../dist-electron/pty-host-client.js");

const SOCKET_PATH = join(TMP_AYA_HOME, "pty-host.sock");
const FAKE_HOST = join(TMP_AYA_HOME, "fake-host.cjs");
const NEVER = -1;
writeFileSync(
  FAKE_HOST,
  `const fs = require("node:fs");
const net = require("node:net");
const { spawnSync } = require("node:child_process");
const sock = ${JSON.stringify(SOCKET_PATH)};
// A listener killed before it can close leaves its socket file behind, refusing every connect. It is
// made under another name and moved in: at sock, the listener would accept for an instant.
const dead = sock + ".dead";
spawnSync(process.execPath, ["-e", \`require("node:net").createServer().listen(\${JSON.stringify(dead)}, () => process.kill(process.pid, "SIGKILL"))\`]);
fs.renameSync(dead, sock);
const refuseMs = Number(process.env.FAKE_HOST_REFUSE_MS);
setTimeout(() => process.exit(0), Math.max(refuseMs, 0) + 8000);
if (refuseMs !== ${NEVER}) setTimeout(() => {
  fs.rmSync(sock, { force: true });
  net.createServer((c) => {
    c.setEncoding("utf8");
    c.on("data", (chunk) => {
      for (const line of chunk.split("\\n").filter(Boolean)) {
        const req = JSON.parse(line);
        c.write(JSON.stringify({ id: req.id, ok: true, result: "from the host" }) + "\\n");
        // Gone with its socket, so the next test starts a host of its own.
        if (req.type === "shutdown") c.end(() => { fs.rmSync(sock, { force: true }); process.exit(0); });
      }
    });
  }).listen(sock);
}, refuseMs);
`,
);

test.after(() => rmSync(TMP_AYA_HOME, { recursive: true, force: true }));

test("a started host whose socket refuses at first is reached once it accepts", async () => {
  process.env.FAKE_HOST_REFUSE_MS = "400";
  const client = new PtyHostClient(FAKE_HOST);
  try {
    assert.equal(await client.getBuffer("t1"), "from the host");
  } finally {
    await client.shutdown();
  }
});

test("a started host whose socket never accepts fails the request at the deadline, with the refusal", async () => {
  process.env.FAKE_HOST_REFUSE_MS = String(NEVER);
  const client = new PtyHostClient(FAKE_HOST);
  const startedAt = Date.now();
  try {
    await assert.rejects(client.getBuffer("t1"), { code: "ECONNREFUSED" });
    const waited = Date.now() - startedAt;
    assert.ok(waited >= PTY_HOST_SOCKET_WAIT_TIMEOUT_MS, `the client gave up before its deadline (${waited} ms)`);
    // Loose, for a loaded runner: past it the client kept retrying long after its deadline.
    assert.ok(waited < 2 * PTY_HOST_SOCKET_WAIT_TIMEOUT_MS, `the client kept trying ${waited} ms`);
  } finally {
    client.dispose();
  }
});
