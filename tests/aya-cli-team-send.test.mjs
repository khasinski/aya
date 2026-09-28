// `aya team send` against a stub control socket: the assertion is on the JSON
// the app receives, as in aya-cli-pane-send.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import * as net from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const cli = resolve("bin/aya");
// Linux runs /bin/sh as dash, where a failed shift ends the script.
const SHELLS = ["/bin/sh", "/bin/dash"].filter(existsSync);

async function teamSend(args, shell = "/bin/sh") {
  const dir = mkdtempSync(join(tmpdir(), "aya-team-send-"));
  const socket = join(dir, "aya.sock");
  let request = null;
  const server = net.createServer((conn) => {
    let buffer = "";
    conn.setEncoding("utf8");
    conn.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      request = JSON.parse(buffer.slice(0, newline));
      conn.end(`${JSON.stringify({ ok: true })}\n`);
    });
  });
  await new Promise((done) => server.listen(socket, done));
  try {
    const status = await new Promise((done, fail) => {
      const child = spawn(shell, [cli, "team", "send", ...args], {
        env: { ...process.env, AYA_SOCKET: socket },
        stdio: ["ignore", "ignore", "ignore"],
      });
      child.on("error", fail);
      child.on("close", done);
    });
    return { status, request };
  } finally {
    await new Promise((done) => server.close(done));
    rmSync(dir, { recursive: true, force: true });
  }
}

test("unquoted words after the role are one message", async () => {
  const { status, request } = await teamSend(["implementer", "round", "5", "ready"]);
  assert.equal(status, 0);
  assert.equal(request.type, "team-send");
  assert.equal(request.role, "implementer");
  assert.equal(request.text, "round 5 ready");
});

for (const shell of SHELLS) {
  test(`a send without text is refused before anything reaches the app (${shell})`, async () => {
    for (const args of [["implementer"], ["implementer", ""], []]) {
      const { status, request } = await teamSend(args, shell);
      assert.equal(status, 1, JSON.stringify(args));
      assert.equal(request, null, JSON.stringify(args));
    }
  });
}
