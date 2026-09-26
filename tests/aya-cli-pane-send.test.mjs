// The real CLI talks to a stub control socket, so the assertion is on the JSON
// the app receives - the level where a trailing `--submit` became text (#116).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as net from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const cli = resolve("bin/aya");

/** Run `aya pane send ...args` against a stub socket; resolve with the request
 *  it sent (null if it never connected) and its exit status. */
async function paneSend(args) {
  const dir = mkdtempSync(join(tmpdir(), "aya-pane-send-"));
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
      const child = spawn(cli, ["pane", "send", ...args], {
        env: { ...process.env, AYA_SOCKET: socket, AYA_PROJECT_SLUG: "" },
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

test("no flag submits by default", async () => {
  const { status, request } = await paneSend(["reviewer", "run the tests"]);
  assert.equal(status, 0);
  assert.equal(request.text, "run the tests");
  assert.equal(request.submit, true);
});

test("--submit before the text still works (README form)", async () => {
  const { request } = await paneSend(["reviewer", "--submit", "run the tests"]);
  assert.equal(request.text, "run the tests");
  assert.equal(request.submit, true);
});

test("--submit after the text is a flag, not literal text (website form)", async () => {
  const { request } = await paneSend(["reviewer", "ship it", "--submit"]);
  assert.equal(request.text, "ship it");
  assert.equal(request.submit, true);
});

test("--no-submit types without Enter, in any position, whatever --submit says", async () => {
  for (const args of [
    ["reviewer", "--no-submit", "draft"],
    ["reviewer", "draft", "--no-submit"],
    ["reviewer", "--no-submit", "draft", "--submit"],
  ]) {
    const { request } = await paneSend(args);
    assert.equal(request.text, "draft", args.join(" "));
    assert.equal(request.submit, false, args.join(" "));
  }
});

test("words are joined with single spaces, as before", async () => {
  const { request } = await paneSend(["reviewer", "run", "the", "tests"]);
  assert.equal(request.text, "run the tests");
});

test("-- ends flag parsing, so the flags can be sent as text", async () => {
  const { request } = await paneSend(["reviewer", "--no-submit", "--", "--submit"]);
  assert.equal(request.text, "--submit");
  assert.equal(request.submit, false);
});

test("flags alone are not text: usage error, nothing sent", async () => {
  const { status, request } = await paneSend(["reviewer", "--submit"]);
  assert.notEqual(status, 0);
  assert.equal(request, null);
});
