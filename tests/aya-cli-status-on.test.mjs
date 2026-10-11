// `aya status waiting [--on role] text` against a stub control socket, under each shell: the JSON the app receives.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as net from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { envWithoutAya } from "./helpers/env.mjs";
import { CLI_SHELLS, shellOptions } from "./helpers/cli-shells.mjs";

const cli = resolve("bin/aya");

async function aya(args, shell) {
  const dir = mkdtempSync(join(tmpdir(), "aya-status-on-"));
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
      const child = spawn(shell, [cli, "status", ...args], { cwd: dir, env: { ...envWithoutAya(), AYA_SOCKET: socket, AYA_TERMINAL_ID: "pane-1" } });
      child.on("error", fail);
      child.on("close", done);
    });
    return { status, request };
  } finally {
    await new Promise((done) => server.close(done));
    rmSync(dir, { recursive: true, force: true });
  }
}

// [args, exit status, level, text, on]
const ROWS = [
  [["waiting", "--on", "tester", "answer", "on", "the", "test"], 0, "waiting", "answer on the test", "tester"],
  [["waiting", "need", "the", "password"], 0, "waiting", "need the password", undefined],
  [["waiting", "--on", "tester"], 1, null, null, undefined],
  [["waiting", "--on"], 1, null, null, undefined],
  [["waiting", "--on", "", "x"], 1, null, null, undefined],
];

for (const shell of CLI_SHELLS) {
  for (const [args, exit, level, text, on] of ROWS) {
    test(`aya status ${args.map((a) => a || '""').join(" ")} (${shell})`, shellOptions(shell), async () => {
      const { status, request } = await aya(args, shell);
      if (exit !== 0) {
        assert.equal(status, exit, "a usage error");
        assert.equal(request, null, "nothing is sent");
        return;
      }
      assert.equal(status, 0);
      assert.equal(request.type, "status");
      assert.equal(request.level, level);
      assert.equal(request.text, text);
      assert.equal(request.on, on);
    });
  }
}
