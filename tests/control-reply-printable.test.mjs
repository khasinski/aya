// The control server's reply is where every command's text is made printable (control.ts printableReply), so no
// command has to remember to: a pane's screen, a tab name and an error, each with characters that act on a
// terminal, reach the CLI's stdout and stderr as their \uXXXX escapes. Through the real CLI and server.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { envWithoutAya } from "./helpers/env.mjs";

const { startControlServerOn } = await import("../dist-electron/control.js");

const cli = resolve("bin/aya");
const root = mkdtempSync(join(tmpdir(), "aya-reply-printable-"));
const PANE = "3f1c2a9e-0d4b-4e8a-9c51-7b2d6e0f1a11";
// What a pane's screen can hold, and a tab name: ESC sequences, BEL, CR, C1 CSI, a bidi override.
const SCREEN = "build ok\n\x1b[2J\x1b]0;owned\x07done\rX\u009b31m\u202eTXT\tend\n";
const TAB = "worker\x1b[8m";
const UNPRINTABLE = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u206f]/;

const socket = join(root, "aya.sock");
const stop = startControlServerOn(socket, {
  getWindow: () => null,
  openProject: () => {},
  listProjects: async () => [{ slug: "game", name: "game", directory: root, tabs: [{ id: PANE, name: TAB, presetId: "shell" }] }],
  readPane: async () => SCREEN,
  writePane: async () => true,
});
test.after(() => {
  stop();
  rmSync(root, { recursive: true, force: true });
});

function aya(...args) {
  return new Promise((done, fail) => {
    const child = spawn("/bin/sh", [cli, ...args], { cwd: root, env: { ...envWithoutAya(), HOME: root, AYA_SOCKET: socket, AYA_PROJECT_SLUG: "game" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", fail);
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}

test("a pane's screen reaches the reader as text: each acting character as its escape, tab and newline kept", async () => {
  const { status, stdout, stderr } = await aya("pane", "read", PANE);
  assert.equal(status, 0, stderr);
  assert.doesNotMatch(stdout, UNPRINTABLE);
  assert.equal(stdout, "build ok\n\\u001b[2J\\u001b]0;owned\\u0007done\\u000dX\\u009b31m\\u202eTXT\tend\n");
});

test("a tab name in aya pane list, and an error quoting what it was given, the same", async () => {
  const list = await aya("pane", "list");
  assert.equal(list.status, 0, list.stderr);
  assert.doesNotMatch(list.stdout, UNPRINTABLE);
  assert.match(list.stdout, /worker\\u001b\[8m/);
  const missing = await aya("pane", "read", "ghost\x1b]0;owned\x07");
  assert.equal(missing.status, 1);
  assert.doesNotMatch(missing.stderr, UNPRINTABLE);
  assert.match(missing.stderr, /ghost\\u001b\]0;owned\\u0007/);
});
