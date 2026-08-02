// PTY lifecycle log (pty-log.ts): JSONL append + size-capped rotation. The log
// is the forensic record for "what killed all my consoles at 03:12?" - so the
// assertions read the FILE back (the observable a human greps later), not the
// writer's internals, and the failure-swallowing contract is pinned (a broken
// log must never break the PTY layer).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createPtyLog, PTY_LOG_MAX_BYTES } from "../dist-electron/pty-log.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "aya-pty-log-"));

const readLines = (file) =>
  fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

test("append writes one parseable JSON line with ts/pid/ev plus fields", () => {
  const file = path.join(tmp(), "pty-events.log");
  const log = createPtyLog(file, PTY_LOG_MAX_BYTES);
  log.append("spawn", { ptyId: "t1", command: "claude --continue" });
  log.append("exit", { ptyId: "t1", exitCode: 0 });

  const lines = readLines(file);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].ev, "spawn");
  assert.equal(lines[0].ptyId, "t1");
  assert.equal(lines[0].command, "claude --continue");
  assert.equal(lines[0].pid, process.pid);
  // ts must be a real ISO timestamp (greppable + sortable), not a raw number.
  assert.ok(!Number.isNaN(Date.parse(lines[0].ts)), `bad ts: ${lines[0].ts}`);
  assert.equal(lines[1].ev, "exit");
  assert.equal(lines[1].exitCode, 0);
});

test("append creates the parent directory when missing", () => {
  const file = path.join(tmp(), "nested", "deeper", "pty-events.log");
  createPtyLog(file, PTY_LOG_MAX_BYTES).append("host-start", { version: "0.0.0" });
  assert.equal(readLines(file)[0].ev, "host-start");
});

test("rotation moves the full file to .1 and starts fresh", () => {
  const file = path.join(tmp(), "pty-events.log");
  // Cap low enough that the second line cannot fit after the first.
  const log = createPtyLog(file, 120);
  log.append("spawn", { ptyId: "first" });
  log.append("spawn", { ptyId: "second" });

  const rotated = readLines(`${file}.1`);
  const current = readLines(file);
  assert.equal(rotated.length, 1);
  assert.equal(rotated[0].ptyId, "first");
  assert.equal(current.length, 1);
  assert.equal(current[0].ptyId, "second");
});

test("rotation accounts for bytes, not string length (multibyte command)", () => {
  const file = path.join(tmp(), "pty-events.log");
  // "ąęść" is 4 chars / 8 bytes in UTF-8. Pick the cap BETWEEN two lines'
  // total CHAR length and their total BYTE length: a byte-based counter must
  // rotate on the second append, while a length-based one (the natural
  // regression) concludes both lines fit and skips the rotation - so that
  // mutation turns this test red instead of passing by accident.
  const cmd = "ąęść".repeat(8);
  const refLine = `${JSON.stringify({
    ts: new Date().toISOString(),
    pid: process.pid,
    ev: "spawn",
    command: cmd,
  })}\n`;
  const lineChars = refLine.length;
  const lineBytes = Buffer.byteLength(refLine);
  assert.ok(lineBytes > lineChars, "sanity: the command must be multibyte");
  const cap = lineChars * 2 + 1; // > 2 lines in chars, < 2 lines in bytes
  assert.ok(lineBytes * 2 > cap, "sanity: byte accounting must overflow this cap");
  assert.ok(lineBytes <= cap, "sanity: the first line alone must fit");

  const log = createPtyLog(file, cap);
  log.append("spawn", { command: cmd });
  log.append("spawn", { command: cmd });
  assert.equal(
    readLines(`${file}.1`).length,
    1,
    "byte-counted cap must rotate on the second append",
  );
  assert.equal(readLines(file)[0].command, cmd);
});

test("append never throws when the path is unwritable", () => {
  const dir = tmp();
  const blocker = path.join(dir, "not-a-dir");
  fs.writeFileSync(blocker, "plain file");
  // Parent of the log path is a FILE -> mkdir/append fail internally.
  const log = createPtyLog(path.join(blocker, "pty-events.log"), PTY_LOG_MAX_BYTES);
  assert.doesNotThrow(() => log.append("spawn", { ptyId: "t1" }));
});
