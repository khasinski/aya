// `aya team new|save` against a stub control socket, under sh and dash: the
// assertion is on the JSON the app receives and what the CLI prints.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { envWithoutAya } from "./helpers/env.mjs";

const cli = resolve("bin/aya");
// Linux runs /bin/sh as dash, where a failed shift ends the script.
const SHELLS = ["/bin/sh", "/bin/dash"].filter(existsSync);
const FILE = "# ux-fix\n\n## Role: a\nMust not: x\n";

async function aya(args, { shell = "/bin/sh", reply = { ok: true, output: "from the app\n" }, stdin = "", files = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "aya-team-author-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
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
      conn.end(`${JSON.stringify(reply)}\n`);
    });
  });
  await new Promise((done) => server.listen(socket, done));
  try {
    const result = await new Promise((done, fail) => {
      const child = spawn(shell, [cli, "team", ...args], {
        cwd: dir,
        env: { ...envWithoutAya(), AYA_SOCKET: socket, AYA_PROJECT_SLUG: "game", AYA_TERMINAL_ID: "pane-1" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stderr += c));
      child.on("error", fail);
      child.on("close", (status) => done({ status, stdout, stderr }));
      child.stdin.end(stdin);
    });
    return { ...result, request, dir };
  } finally {
    await new Promise((done) => server.close(done));
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const shell of SHELLS) {
  test(`team new sends the description as one text and prints the guide (${shell})`, async () => {
    const { status, stdout, request, dir } = await aya(["new", "a", "team", "for", "UX"], { shell });
    assert.equal(status, 0);
    assert.equal(stdout, "from the app\n");
    assert.equal(request.type, "team-guide");
    assert.equal(request.description, "a team for UX");
    assert.equal(request.projectSlug, "game");
    assert.equal(request.caller.terminalId, "pane-1");
    assert.ok(request.cwd.endsWith(dir.split("/").pop()), request.cwd);
  });

  test(`team new without a description asks for the guide alone (${shell})`, async () => {
    const { status, request } = await aya(["new"], { shell });
    assert.equal(status, 0);
    assert.equal(request.type, "team-guide");
    assert.equal(request.description, undefined);
  });

  test(`team save sends the file's text, --replace in either place (${shell})`, async () => {
    for (const args of [["save", "t.md"], ["save", "t.md", "--replace"], ["save", "--replace", "t.md"]]) {
      const { status, stdout, request } = await aya(args, { shell, files: { "t.md": FILE } });
      assert.equal(status, 0, args.join(" "));
      assert.equal(stdout, "from the app\n");
      assert.equal(request.type, "team-save");
      assert.equal(request.text, FILE.trimEnd());
      assert.equal(request.replace, args.includes("--replace"), args.join(" "));
      assert.equal(request.projectSlug, "game");
    }
  });

  test(`team save - reads the file from stdin (${shell})`, async () => {
    const { status, request } = await aya(["save", "-"], { shell, stdin: FILE });
    assert.equal(status, 0);
    assert.equal(request.text, FILE.trimEnd());
  });

  test(`team save refuses a missing, empty or absent file before anything reaches the app (${shell})`, async () => {
    for (const [args, message] of [
      [["save"], /Usage/],
      [["save", "--replace"], /Usage/],
      [["save", "a.md", "b.md"], /Usage/],
      [["save", "nope.md"], /no such file: nope\.md/],
      [["save", "empty.md"], /empty\.md is empty; nothing was saved/],
      [["save", "-"], /- is empty; nothing was saved/],
    ]) {
      const { status, stderr, request } = await aya(args, { shell, files: { "empty.md": "\n\n" } });
      assert.equal(status, 1, args.join(" "));
      assert.match(stderr, message, args.join(" "));
      assert.equal(request, null, args.join(" "));
    }
  });

  test(`team save prints the app's problem and exits 1 (${shell})`, async () => {
    const reply = { ok: false, error: 'team "ux-fix": role "a" needs a "Must not:" line' };
    const { status, stdout, stderr } = await aya(["save", "t.md"], { shell, reply, files: { "t.md": FILE } });
    assert.equal(status, 1);
    assert.equal(stdout, "");
    assert.equal(stderr, `aya: ${reply.error}\n`);
  });
}
