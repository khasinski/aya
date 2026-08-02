// Host side of the attach-only contract: when a re-mount asks to attach-only
// and the host has no live PTY for that id, it must emit a `no-session` event
// and NOT start a process. This covers the PRODUCER of no-session (the reducer
// test covers the consumer); together they exercise both ends of the path that
// a real PTY E2E can't reach in the sandbox. The attach-only branch returns
// before any node-pty call, so this needs no real process.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killPty, spawnPty } from "../dist-electron/pty.js";

// pty.ts logs lifecycle events to $AYA_HOME/pty-events.log (resolved lazily at
// the first append), so redirect it before any spawnPty call - otherwise unit
// runs write into the user's real ~/.aya.
process.env.AYA_HOME = mkdtempSync(join(tmpdir(), "aya-pty-test-"));

function fakeSink() {
  const events = [];
  return {
    events,
    sendPtyEvent: (e) => events.push(e),
    isDestroyed: () => false,
  };
}

const baseReq = (over) => ({
  ptyId: "attach-only-" + Math.random().toString(36).slice(2),
  command: "echo hi",
  cwd: "/tmp",
  cols: 80,
  rows: 24,
  ...over,
});

test("attachOnly with no live session emits no-session and does not spawn", async () => {
  const sink = fakeSink();
  const req = baseReq({ attachOnly: true });
  await spawnPty(req, sink);
  assert.deepEqual(sink.events, [{ type: "no-session", ptyId: req.ptyId }]);
});

test("lifecycle events land in $AYA_HOME/pty-events.log (lazy singleton + wiring)", async () => {
  // AYA_HOME was set ABOVE, after pty.js was already imported - so a hit here
  // pins BOTH halves of the isolation story (#91): the ptyLog singleton must
  // resolve its path lazily at the first append (an eager import-time binding
  // would write into the user's real ~/.aya and leave this file empty), and
  // the pty.ts call sites must actually fire (deleting the appends would also
  // leave this file empty while every event-sink assertion stays green).
  const sink = fakeSink();
  const req = baseReq({ attachOnly: true });
  await spawnPty(req, sink);
  killPty(req.ptyId); // dead id -> arms the pending-kill marker, logs live:false
  const lines = readFileSync(join(process.env.AYA_HOME, "pty-events.log"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const noSession = lines.find((l) => l.ev === "no-session" && l.ptyId === req.ptyId);
  assert.ok(noSession, "the no-session event must be logged");
  assert.equal(noSession.pid, process.pid);
  const kill = lines.find((l) => l.ev === "kill" && l.ptyId === req.ptyId);
  assert.ok(kill, "the kill event must be logged");
  assert.equal(kill.live, false);
});

test("attachOnly returns before command/cwd validation (no spawn-failed)", async () => {
  // A bad command/cwd would normally produce spawn-failed; attach-only must
  // short-circuit first, so the only event is no-session.
  const sink = fakeSink();
  const req = baseReq({ attachOnly: true, command: "", cwd: "/no/such/dir/xyz" });
  await spawnPty(req, sink);
  assert.equal(sink.events.length, 1);
  assert.equal(sink.events[0].type, "no-session");
});
