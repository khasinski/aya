// Remote and machines IPC (electron/ipc/remote-ipc.ts): the channels, and the argument checks that run before
// anything reaches ssh or the machines registry.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HOME = mkdtempSync(join(tmpdir(), "aya-remote-ipc-"));
process.env.AYA_HOME = HOME;
const { registerRemoteIpc } = await import("../dist-electron/ipc/remote-ipc.js");

test.after(() => rmSync(HOME, { recursive: true, force: true }));

function setup() {
  const handlers = new Map();
  registerRemoteIpc({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, ayaHome: HOME });
  return { handlers, call: (channel, ...args) => handlers.get(channel)({}, ...args) };
}

test("registers exactly the remote and machines channels", () => {
  assert.deepEqual([...setup().handlers.keys()].sort(), [
    "machines:command",
    "machines:configure",
    "machines:discover",
    "machines:setup",
    "machines:status",
    "remote:create-directory",
    "remote:create-project",
    "remote:health",
    "remote:list-directory",
    "remote:list-presets",
  ]);
});

test("machines:configure takes only a configure command, with an optional text token", async () => {
  const { call } = setup();
  for (const [argv, token] of [[["add", "x"], undefined], ["configure", undefined], [["configure", 1], undefined], [["configure", "x"], 7]]) {
    await assert.rejects(call("machines:configure", argv, token), /needs configuration arguments/);
  }
});

test("machines:command takes add, remove, claim or release with text arguments only", async () => {
  const { call } = setup();
  for (const argv of [["configure", "x"], ["status"], "add", [7]]) {
    await assert.rejects(call("machines:command", argv), /takes add, remove, claim or release/);
  }
});

test("ssh targets and directories must be text before anything runs", async () => {
  const { call } = setup();
  await assert.rejects(call("remote:health", 7), /remote:health\.sshTarget/);
  await assert.rejects(call("remote:create-directory", "host", null), /remote:create-directory\.directory/);
  await assert.rejects(async () => call("machines:discover", null), /machines:discover\.id/);
});
