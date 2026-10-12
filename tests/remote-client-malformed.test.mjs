// What another machine's Aya sends back over ssh is untrusted. Output that throws while it is read (a host that is
// not a host, a null line, a snapshot without its data) must reject the request, not escape as an exception in the
// main process and leave the request pending; an ssh that fails with no stderr says so briefly and at the right
// stage; an error with no id (snapshot_failed) is the reason unless the answer still came; and a target that would
// read as an ssh option never reaches ssh. A fake ssh first on PATH prints canned output.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeExecutable } from "./helpers/executable.mjs";

const root = mkdtempSync(join(tmpdir(), "aya-remote-malformed-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
const out = join(root, "out");
const ran = join(root, "ran");
const HELLO = JSON.stringify({ type: "hello", protocol: 1, host: { id: "h", name: "box", platform: "linux", user: "u" }, app: { version: "1" }, permissions: { mode: "read-only" } });
// Called as ssh -- <target> <command>. It records that it ran, then prints the canned output; with FAKE_SSH_ANSWER it
// prints a hello, an error with no id, and the answer to the request whose id it reads from the command.
writeExecutable(
  join(root, "ssh"),
  [
    "#!/bin/sh",
    `echo run >> '${ran}'`,
    'if [ -n "$FAKE_SSH_ANSWER" ]; then',
    '  id=$(printf "%s" "$3" | grep -oE "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}" | head -1)',
    `  printf '%s\\n' '${HELLO}'`,
    `  printf '%s\\n' '{"type":"error","protocol":1,"code":"snapshot_failed","message":"late"}'`,
    `  printf '{"type":"fs:list-result","protocol":1,"id":"%s","path":"/srv","entries":[]}\\n' "$id"`,
    "  exit 0",
    "fi",
    `cat '${out}'`,
    'exit "${FAKE_SSH_EXIT:-0}"',
    "",
  ].join("\n"),
);
process.env.PATH = `${root}:${process.env.PATH}`;
const { checkRemoteHealth, listRemoteDirectory } = await import("../dist-electron/remote-client.js");

const reply = (...lines) => writeFileSync(out, lines.map((l) => `${l}\n`).join(""));

for (const [name, lines, error] of [
  ["a hello whose host is not a host", [JSON.stringify({ type: "hello", host: { id: "h" } })], /Remote host info is invalid/],
  ["a line that is null", ["null"], /not an object/],
  ["a snapshot without its snapshot", [HELLO, JSON.stringify({ type: "snapshot" })], /a snapshot without its data/],
]) {
  test(`${name}: the request rejects with the reason, nothing escapes`, async () => {
    reply(...lines);
    await assert.rejects(listRemoteDirectory("box"), error);
  });
}

test("an ssh that fails with no stderr says so briefly (255 is ssh's own), not with the whole bridge command", async (t) => {
  reply();
  t.after(() => delete process.env.FAKE_SSH_EXIT);
  process.env.FAKE_SSH_EXIT = "255";
  await assert.rejects(listRemoteDirectory("box"), (err) => (assert.equal(err.message, "ssh box failed (exit 255)."), true));
  process.env.FAKE_SSH_EXIT = "3";
  await assert.rejects(listRemoteDirectory("box"), (err) => (assert.equal(err.message, "Remote Aya did not respond on box: its bridge exited 3 with no output."), true));
});

test("the health check puts ssh's own failure at the ssh stage and a silent bridge at aya-remote", async (t) => {
  reply();
  t.after(() => delete process.env.FAKE_SSH_EXIT);
  const failedStage = async (code) => {
    process.env.FAKE_SSH_EXIT = String(code);
    return (await checkRemoteHealth("box")).checks.find((c) => !c.ok).stage;
  };
  assert.equal(await failedStage(255), "ssh");
  assert.equal(await failedStage(3), "aya-remote");
});

test("an error with no id (the snapshot failed) is the request's reason", async () => {
  reply(HELLO, JSON.stringify({ type: "error", protocol: 1, code: "snapshot_failed", message: "projects.json unreadable" }));
  await assert.rejects(listRemoteDirectory("box"), /projects\.json unreadable/);
});

test("an error with no id does not fail a request whose own answer still came", async (t) => {
  process.env.FAKE_SSH_ANSWER = "1";
  t.after(() => delete process.env.FAKE_SSH_ANSWER);
  const listing = await listRemoteDirectory("box");
  assert.equal(listing.path, "/srv");
});

test("a target that would read as an ssh option is refused before ssh runs", async () => {
  writeFileSync(ran, "");
  await assert.rejects(listRemoteDirectory("-oProxyCommand=touch /tmp/owned"), /is not an ssh target/);
  assert.equal(
    (await checkRemoteHealth("-oProxyCommand=x")).checks[0].message,
    '"-oProxyCommand=x" is not an ssh target: use a Host alias from ~/.ssh/config or user@host',
  );
  assert.equal(readFileSync(ran, "utf8"), "", "ssh never ran");
});
