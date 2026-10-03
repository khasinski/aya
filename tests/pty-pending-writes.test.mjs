// Input typed while a spawn is in flight must be held, not dropped: spawnPty
// registers the PTY only after an async preflight, so writePty before the await
// lands in that window. MISSING_BINARY fails the preflight so node-pty is never
// reached: its native module targets Electron's ABI, not this node. Flush is e2e.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PENDING_WRITE_MAX_BYTES,
  spawnPty,
  writePty,
  __testPendingWrites,
} from "../dist-electron/pty.js";

// pty.ts resolves $AYA_HOME lazily at the first log append, so redirect it
// before any spawnPty call or unit runs write into the user's real ~/.aya.
process.env.AYA_HOME = mkdtempSync(join(tmpdir(), "aya-pending-write-test-"));
const { fakeSink } = await import("./helpers/pty-host.mjs");

const MISSING_BINARY = "aya-no-such-binary-zzz";

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

  // Not awaited: parked on the preflight, id in-flight, no PTY registered yet.
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

  // The queue was never flushed, so the finally still has to clear it or the
  // host holds that input until the id is reused.
  assert.ok(
    sink.events.some((e) => e.type === "spawn-failed"),
    "precondition: the spawn failed at the command-exists preflight",
  );
  assert.deepEqual(__testPendingWrites(id), [0, 0], "a settled spawn holds nothing");
});

// Only the spawn window buffers; `aya pane list` advertises exited panes, so a drop must be reported.
test("input for an id with no spawn in flight is dropped, and the write REPORTS that it went nowhere", async () => {
  const id = uniqueId("pending-unknown");
  assert.equal(await writePty(id, "nobody is listening\r"), false, "an id with no live process and no spawn in flight must report false");
  assert.deepEqual(__testPendingWrites(id), [0, 0]);
});

// Buffering is NOT delivery: the spawn's `finally` discards the queue on every
// failure path, so the answer has to wait for the spawn to settle.
test("a write parked on a spawn that FAILS reports that it went nowhere", async () => {
  const id = uniqueId("pending-report-failed-spawn");
  const sink = fakeSink();
  const spawn = spawnPty(req(id), sink);
  const delivered = writePty(id, "typed into a spawn that will fail\r");
  // Must DEFER. Sniffing for a `.then` cannot show that - writePty always
  // returns a promise - so race a turn of the loop: pending means deferring.
  const STILL_PENDING = Symbol("still-pending");
  const aTurn = new Promise((resolve) => setImmediate(() => resolve(STILL_PENDING)));
  assert.equal(
    await Promise.race([delivered, aTurn]),
    STILL_PENDING,
    "must defer, not answer yet",
  );
  await spawn.catch(() => {});
  assert.equal(await delivered, false);
  assert.ok(
    sink.events.some((e) => e.type === "spawn-failed"),
    "precondition: the spawn really did fail",
  );
});

test("a chunk that does not fit is failed whole, never queued as a head", async () => {
  // A cut bracketed paste leaves the pane mid-paste, and --submit would press Enter on it.
  const id = uniqueId("pending-report-partial");
  const sink = fakeSink();
  const spawn = spawnPty(req(id), sink);
  writePty(id, "x".repeat(PENDING_WRITE_MAX_BYTES - 10));
  assert.equal(await writePty(id, "abcdefghijklmno"), false);
  const [chunks, bytes] = __testPendingWrites(id);
  assert.equal(chunks, 1, "no head of the failed chunk is queued");
  assert.equal(bytes, PENDING_WRITE_MAX_BYTES - 10);
  assert.equal(await writePty(id, "01234567890"), false, "one byte over the room is refused too");
  assert.equal(__testPendingWrites(id)[1], PENDING_WRITE_MAX_BYTES - 10);
  // What does fit still goes in whole.
  writePty(id, "0123456789");
  assert.equal(__testPendingWrites(id)[1], PENDING_WRITE_MAX_BYTES);

  await spawn.catch(() => {});

  const lines = logLines().filter((l) => l.ptyId === id);
  assert.equal(lines.some((l) => l.ev === "pending-write-truncated"), false);
  const dropped = lines.find((l) => l.ev === "pending-write-dropped");
  assert.ok(dropped, "the refusal leaves a pending-write-dropped line");
  assert.equal(dropped.bytes, 15, "the log names the refused chunk");
});

test("a multi-byte character that is one byte too big reports failure", async () => {
  const id = uniqueId("pending-report-truncated-empty");
  const sink = fakeSink();
  const spawn = spawnPty(req(id), sink);
  writePty(id, "x".repeat(PENDING_WRITE_MAX_BYTES - 1));
  // One byte of room, but the next character needs two.
  assert.equal(await writePty(id, "é"), false);
  assert.deepEqual(__testPendingWrites(id), [1, PENDING_WRITE_MAX_BYTES - 1], "nothing of the refused character is queued");
  void writePty(id, "x");
  assert.deepEqual(__testPendingWrites(id), [2, PENDING_WRITE_MAX_BYTES], "one byte still fits");
  await spawn.catch(() => {});
});

test("the cap counts bytes of what is already queued too, not characters", async () => {
  const id = uniqueId("pending-cap-multibyte");
  const spawn = spawnPty(req(id), fakeSink());
  // Half the cap in characters, all of it in bytes.
  writePty(id, "é".repeat(PENDING_WRITE_MAX_BYTES / 2));
  assert.deepEqual(__testPendingWrites(id), [1, PENDING_WRITE_MAX_BYTES]);
  assert.equal(await writePty(id, "x"), false);
  assert.equal(__testPendingWrites(id)[1], PENDING_WRITE_MAX_BYTES);
  await spawn.catch(() => {});
});

test("the queue is capped, and the overflow is logged rather than silent", async () => {
  const id = uniqueId("pending-cap");
  const sink = fakeSink();

  const spawn = spawnPty(req(id), sink);
  // Half the cap at a time: the third write is over the cap and refused whole.
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
