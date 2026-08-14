// Input typed while a spawn is still in flight must be held, not dropped.
//
// writePty resolves the PTY out of the `ptys` map, but spawnPty registers it
// only AFTER an async command-exists preflight. Anything typed in that window
// used to hit `if (!p) return` and vanish with no echo and no error - a real
// tty buffers what you type before the shell reads it, so the drop was the
// anomaly. These tests drive the queue directly: spawnPty runs synchronously up
// to the preflight (marking the id in-flight), so calling writePty before
// awaiting lands squarely inside the spawn window.
//
// The command below is a valid binary NAME that does not exist, so every spawn
// here fails at the preflight and never reaches node-pty (whose native module
// is built for Electron's ABI, not the plain node running this suite). That
// covers queueing, the cap and cleanup; the flush into a live PTY needs a real
// process and is exercised by the e2e suite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnPty, writePty, __testPendingWrites } from "../dist-electron/pty.js";

// pty.ts logs lifecycle events to $AYA_HOME/pty-events.log (resolved lazily at
// the first append), so redirect it before any spawnPty call - otherwise unit
// runs write into the user's real ~/.aya.
process.env.AYA_HOME = mkdtempSync(join(tmpdir(), "aya-pending-write-test-"));

const MISSING_BINARY = "aya-no-such-binary-zzz";
const PENDING_WRITE_MAX_BYTES = 64 * 1024;

function fakeSink() {
  const events = [];
  return { events, sendPtyEvent: (e) => events.push(e), isDestroyed: () => false };
}

function req(ptyId) {
  return { ptyId, command: MISSING_BINARY, cwd: "/tmp", cols: 80, rows: 24 };
}

function uniqueId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2)}`;
}

function logLines() {
  return readFileSync(join(process.env.AYA_HOME, "pty-events.log"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test("input typed during the spawn window is queued in order, not dropped", async () => {
  const id = uniqueId("pending");
  const sink = fakeSink();

  // Deliberately not awaited: the spawn is now parked on the async preflight
  // with the id marked in-flight and no PTY registered yet.
  const spawn = spawnPty(req(id), sink);
  writePty(id, "echo ");
  writePty(id, "HELLO\r");

  const [chunks, bytes] = __testPendingWrites(id);
  assert.equal(chunks, 2, "both writes should be held for the in-flight spawn");
  assert.equal(bytes, "echo HELLO\r".length, "held verbatim, nothing lost");

  await spawn;
});

test("a settled spawn holds nothing, whatever its outcome", async () => {
  const id = uniqueId("pending-cleanup");
  const sink = fakeSink();

  const spawn = spawnPty(req(id), sink);
  writePty(id, "typed into a spawn that is about to fail\r");
  await spawn;

  // This spawn failed at the preflight, so the queue was never flushed into a
  // PTY - the finally still has to clear it, or the host would hold that input
  // (and its memory) until the id was reused.
  assert.ok(
    sink.events.some((e) => e.type === "spawn-failed"),
    "precondition: the spawn failed at the command-exists preflight",
  );
  assert.deepEqual(__testPendingWrites(id), [0, 0], "a settled spawn holds nothing");
});

test("input for an id with no spawn in flight is still dropped", async () => {
  // Only the spawn window buffers. An unknown id - or one whose PTY already
  // exited - must not accumulate input for a process that will never read it.
  const id = uniqueId("pending-unknown");
  writePty(id, "nobody is listening\r");
  assert.deepEqual(__testPendingWrites(id), [0, 0]);
});

test("the queue is capped, and the overflow is logged rather than silent", async () => {
  const id = uniqueId("pending-cap");
  const sink = fakeSink();

  const spawn = spawnPty(req(id), sink);
  // Half the cap at a time: the third write crosses it, so it is truncated to
  // the remaining room and the fourth finds no room at all.
  const half = "x".repeat(PENDING_WRITE_MAX_BYTES / 2);
  writePty(id, half);
  writePty(id, half);
  writePty(id, "over the cap");
  writePty(id, "not a byte more");

  const [, bytes] = __testPendingWrites(id);
  assert.equal(bytes, PENDING_WRITE_MAX_BYTES, "the queue must not exceed its cap");

  await spawn;

  const lines = logLines().filter((l) => l.ptyId === id);
  assert.ok(
    lines.some((l) => l.ev === "pending-write-dropped"),
    "a write with no room left must leave a pending-write-dropped line",
  );
});

test("a truncated chunk is cut on a character boundary", async () => {
  const id = uniqueId("pending-utf8");
  const sink = fakeSink();

  const spawn = spawnPty(req(id), sink);
  // Fill to one byte short of the cap, then write a 2-byte character across the
  // boundary. Slicing mid-character and decoding would hand the shell a U+FFFD
  // it never typed, so the whole character is dropped instead.
  writePty(id, "x".repeat(PENDING_WRITE_MAX_BYTES - 1));
  writePty(id, "é");

  const [, bytes] = __testPendingWrites(id);
  assert.equal(bytes, PENDING_WRITE_MAX_BYTES - 1, "no partial character is kept");

  await spawn;
});
