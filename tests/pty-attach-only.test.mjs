// Host side of the attach-only contract: when a re-mount asks to attach-only
// and the host has no live PTY for that id, it must emit a `no-session` event
// and NOT start a process. This covers the PRODUCER of no-session (the reducer
// test covers the consumer); together they exercise both ends of the path that
// a real PTY E2E can't reach in the sandbox. The attach-only branch returns
// before any node-pty call, so this needs no real process.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnPty } from "../dist-electron/pty.js";

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

test("attachOnly returns before command/cwd validation (no spawn-failed)", async () => {
  // A bad command/cwd would normally produce spawn-failed; attach-only must
  // short-circuit first, so the only event is no-session.
  const sink = fakeSink();
  const req = baseReq({ attachOnly: true, command: "", cwd: "/no/such/dir/xyz" });
  await spawnPty(req, sink);
  assert.equal(sink.events.length, 1);
  assert.equal(sink.events[0].type, "no-session");
});
