// Concurrent-spawn guard. Two spawnPty calls for the same id (a fast
// unmount+remount) used to both pass the `ptys.has` check and both spawn,
// orphaning the first. The in-flight guard makes the racing call bail. We use a
// command-not-found path so the test never reaches real node-pty: spawnPty runs
// synchronously up to the async command-exists preflight, where the first call
// marks the id in-flight before yielding; the second call (run by Promise.all
// right after) sees the marker and short-circuits.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnPty } from "../dist-electron/pty.js";

function fakeSink() {
  const events = [];
  return { events, sendPtyEvent: (e) => events.push(e), isDestroyed: () => false };
}

test("a concurrent spawn for the same id is suppressed (no second process)", async () => {
  const sink1 = fakeSink();
  const sink2 = fakeSink();
  // Valid binary-name shape so preflightBinary returns it, but it does not
  // exist -> command-not-found, never reaching node-pty.
  const req = {
    ptyId: "double-spawn-" + Math.random().toString(36).slice(2),
    command: "aya-no-such-binary-zzz",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
  };

  await Promise.all([spawnPty(req, sink1), spawnPty(req, sink2)]);

  // First call owns the spawn attempt and reports the failure...
  assert.ok(
    sink1.events.some((e) => e.type === "spawn-failed" && e.reason === "command-not-found"),
    "first call should reach the command-not-found preflight",
  );
  // ...the racing second call bails at the in-flight guard: no events at all.
  assert.deepEqual(sink2.events, [], "concurrent duplicate spawn must be suppressed");
});

test("a sequential re-spawn after the first finished is NOT suppressed", async () => {
  // Once the in-flight marker is cleared (finally), a later spawn for the same
  // id runs again (it is a real retry, not a concurrent duplicate).
  const id = "double-spawn-seq-" + Math.random().toString(36).slice(2);
  const req = { ptyId: id, command: "aya-no-such-binary-zzz", cwd: "/tmp", cols: 80, rows: 24 };

  const s1 = fakeSink();
  await spawnPty(req, s1);
  const s2 = fakeSink();
  await spawnPty(req, s2);

  assert.ok(s1.events.some((e) => e.type === "spawn-failed"));
  assert.ok(
    s2.events.some((e) => e.type === "spawn-failed"),
    "a sequential retry should run (marker cleared by finally), not be suppressed",
  );
});
