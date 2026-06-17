import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as net from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const cli = resolve("bin/aya");

function runAya(args, env = {}) {
  return spawnSync(cli, args, {
    cwd: resolve("."),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function runAyaAsync(args, env = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cli, args, {
      cwd: resolve("."),
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolvePromise({ status, stdout, stderr });
    });
  });
}

function parseNdjson(stdout) {
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("aya help lists the remote stdio bridge", () => {
  const result = runAya(["help"]);

  assert.equal(result.status, 0);
  assert.match(result.stderr, /aya remote --stdio\s+Bridge remote Aya over stdio/);
});

test("aya remote --stdio reports app_unavailable when no socket exists", () => {
  const home = mkdtempSync(join(tmpdir(), "aya-cli-remote-home-"));
  try {
    const result = runAya(["remote", "--stdio"], {
      HOME: home,
      AYA_HOME: "",
      AYA_SOCKET: "",
    });

    assert.notEqual(result.status, 0);
    assert.equal(result.stderr, "");

    const messages = parseNdjson(result.stdout);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, "error");
    assert.equal(messages[0].code, "app_unavailable");
    assert.match(messages[0].message, /Aya is not accepting connections/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("aya remote --stdio identifies a connected app without remote API", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aya-cli-remote-socket-"));
  const socket = join(dir, "aya.sock");
  const server = net.createServer((client) => client.end());
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(socket, resolvePromise);
  });

  try {
    const result = await runAyaAsync(["remote", "--stdio"], {
      AYA_SOCKET: socket,
    });

    assert.notEqual(result.status, 0);
    assert.equal(result.stderr, "");

    const messages = parseNdjson(result.stdout);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].type, "hello");
    assert.equal(messages[0].protocol, 1);
    assert.equal(messages[0].socket, socket);
    assert.equal(messages[1].type, "error");
    assert.equal(messages[1].code, "remote_api_unavailable");
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    rmSync(dir, { recursive: true, force: true });
  }
});
