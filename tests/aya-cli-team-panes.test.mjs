// `aya presets` and `aya team open` against a stub control socket, under sh and
// dash: the assertion is on the JSON the app receives and what the CLI prints.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import * as net from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { envWithoutAya } from "./helpers/env.mjs";

const cli = resolve("bin/aya");
const SHELLS = ["/bin/sh", "/bin/dash"].filter(existsSync);

async function aya(args, { shell = "/bin/sh", reply = { ok: true, output: "from the app\n" } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "aya-team-panes-"));
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
      const child = spawn(shell, [cli, ...args], {
        cwd: dir,
        env: { ...envWithoutAya(), AYA_SOCKET: socket, AYA_PROJECT_SLUG: "game", AYA_TERMINAL_ID: "pane-1" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stderr += c));
      child.on("error", fail);
      child.on("close", (status) => done({ status, stdout, stderr }));
      child.stdin.end();
    });
    return { ...result, request, dir };
  } finally {
    await new Promise((done) => server.close(done));
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const shell of SHELLS) {
  test(`presets asks the app and prints its answer, --json asks for JSON (${shell})`, async () => {
    const plain = await aya(["presets"], { shell });
    assert.equal(plain.status, 0);
    assert.equal(plain.stdout, "from the app\n");
    assert.equal(plain.request.type, "presets");
    assert.equal(plain.request.json, false);
    const json = await aya(["presets", "--json"], { shell });
    assert.equal(json.status, 0);
    assert.equal(json.request.json, true);
  });

  test(`presets refuses anything but --json before reaching the app (${shell})`, async () => {
    const { status, stderr, request } = await aya(["presets", "--all"], { shell });
    assert.equal(status, 1);
    assert.match(stderr, /Usage/);
    assert.equal(request, null);
  });

  test(`team open sends the team, each role=target in order, and --replace anywhere (${shell})`, async () => {
    for (const args of [
      ["team", "open", "ux-fix", "reviewer=claude", "tester=this", "fixer=shell 2"],
      ["team", "open", "--replace", "ux-fix", "reviewer=claude", "tester=this", "fixer=shell 2"],
      ["team", "open", "ux-fix", "reviewer=claude", "--replace", "tester=this", "fixer=shell 2"],
    ]) {
      const { status, stdout, request, dir } = await aya(args, { shell });
      assert.equal(status, 0, args.join(" "));
      assert.equal(stdout, "from the app\n");
      assert.equal(request.type, "team-open");
      assert.equal(request.team, "ux-fix");
      assert.deepEqual(request.panes, [
        { role: "reviewer", target: "claude" },
        { role: "tester", target: "this" },
        { role: "fixer", target: "shell 2" },
      ]);
      assert.equal(request.replace, args.includes("--replace"), args.join(" "));
      assert.equal(request.projectSlug, "game");
      assert.equal(request.caller.terminalId, "pane-1");
      assert.ok(request.cwd.endsWith(dir.split("/").pop()), request.cwd);
    }
  });

  test(`team open keeps a repeated role for the app to refuse, and splits at the first = (${shell})`, async () => {
    const { request } = await aya(["team", "open", "t", "a=x", "a=my=pane"], { shell });
    assert.deepEqual(request.panes, [
      { role: "a", target: "x" },
      { role: "a", target: "my=pane" },
    ]);
  });

  test(`team open refuses a missing team or a malformed pair before reaching the app (${shell})`, async () => {
    for (const [args, message] of [
      [["team", "open"], /Usage/],
      [["team", "open", "--replace"], /Usage/],
      [["team", "open", "ux-fix"], /Usage/],
      [["team", "open", "ux-fix", "reviewer"], /expected role=target, got 'reviewer'; nothing was opened/],
      [["team", "open", "ux-fix", "=claude"], /expected role=target, got '=claude'; nothing was opened/],
      [["team", "open", "ux-fix", "a=claude", "reviewer="], /expected role=target, got 'reviewer='; nothing was opened/],
    ]) {
      const { status, stderr, request } = await aya(args, { shell });
      assert.equal(status, 1, args.join(" "));
      assert.match(stderr, message, args.join(" "));
      assert.equal(request, null, args.join(" "));
    }
  });

  test(`team open prints the app's problem and exits 1 (${shell})`, async () => {
    const reply = { ok: false, error: 'team ux-fix has no role "qa"; nothing was opened' };
    const { status, stdout, stderr } = await aya(["team", "open", "ux-fix", "qa=claude"], { shell, reply });
    assert.equal(status, 1);
    assert.equal(stdout, "");
    assert.equal(stderr, `aya: ${reply.error}\n`);
  });
}
