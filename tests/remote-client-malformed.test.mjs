// What another machine's Aya sends back over ssh is untrusted. Output that throws while it is read (a host that is
// not a host, a null line, a snapshot without its fields) must reject the request, not escape as an exception in
// the main process and leave the request pending; an ssh that fails with no stderr says so briefly; an error with no
// id (snapshot_failed) is the reason the request failed. A fake ssh first on PATH prints canned output.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeExecutable } from "./helpers/executable.mjs";

const root = mkdtempSync(join(tmpdir(), "aya-remote-malformed-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
const out = join(root, "out");
writeExecutable(join(root, "ssh"), `#!/bin/sh\ncat '${out}'\nexit "\${FAKE_SSH_EXIT:-0}"\n`);
process.env.PATH = `${root}:${process.env.PATH}`;
const { listRemoteDirectory } = await import("../dist-electron/remote-client.js");

const HELLO = JSON.stringify({ type: "hello", protocol: 1, host: { id: "h", name: "box", platform: "linux", user: "u" }, app: { version: "1" }, permissions: { mode: "read-only" } });
const reply = (...lines) => writeFileSync(out, lines.map((l) => `${l}\n`).join(""));

for (const [name, lines, error] of [
  ["a hello whose host is not a host", [JSON.stringify({ type: "hello", host: { id: "h" } })], /Remote host info is invalid/],
  ["a line that is null", ["null"], /not an object/],
  ["a snapshot without its snapshot", [HELLO, JSON.stringify({ type: "snapshot" })], /presets|undefined/],
]) {
  test(`${name}: the request rejects with the reason, nothing escapes`, async () => {
    reply(...lines);
    await assert.rejects(listRemoteDirectory("box"), error);
  });
}

test("an ssh that fails with no stderr says so briefly, not with the whole bridge command", async (t) => {
  reply();
  process.env.FAKE_SSH_EXIT = "3";
  t.after(() => delete process.env.FAKE_SSH_EXIT);
  await assert.rejects(listRemoteDirectory("box"), (err) => {
    assert.equal(err.message, "ssh box failed (exit 3).");
    return true;
  });
});

test("an error with no id (the snapshot failed) is the request's reason", async () => {
  reply(HELLO, JSON.stringify({ type: "error", protocol: 1, code: "snapshot_failed", message: "projects.json unreadable" }));
  await assert.rejects(listRemoteDirectory("box"), /projects\.json unreadable/);
});
