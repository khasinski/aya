// Pure reducer behind the PTY event router. Every UI cue Aya gives about a
// terminal — running / waiting / idle / error and the dock-badge bell — flows
// through here, so the state machine deserves direct coverage.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyPtyEvent,
  eventTouchesActivity,
} from "../dist-test/pty-event-reducer.js";

function termState(id, overrides = {}) {
  return {
    id,
    projectSlug: "demo",
    presetId: "claude",
    name: id,
    cwd: "/tmp",
    status: "running",
    bell: false,
    exitCode: null,
    ...overrides,
  };
}

// --- spawn-failed --------------------------------------------------------

test("spawn-failed marks the terminal error + records the failure detail", () => {
  const prev = { t1: termState("t1") };
  const next = applyPtyEvent(prev, {
    type: "spawn-failed",
    ptyId: "t1",
    reason: "command-not-found",
    detail: "claude",
  });
  assert.equal(next.t1.status, "error");
  assert.equal(next.t1.bell, false);
  assert.deepEqual(next.t1.spawnFailure, {
    reason: "command-not-found",
    detail: "claude",
  });
});

test("spawn-failed for an unknown ptyId is a no-op (same reference back)", () => {
  const prev = { t1: termState("t1") };
  const next = applyPtyEvent(prev, {
    type: "spawn-failed",
    ptyId: "ghost",
    reason: "cwd-missing",
    detail: "/gone",
  });
  assert.equal(next, prev, "should return the same map reference");
});

test("spawn-failed clears any stale bell from a prior waiting state", () => {
  const prev = { t1: termState("t1", { status: "waiting", bell: true }) };
  const next = applyPtyEvent(prev, {
    type: "spawn-failed",
    ptyId: "t1",
    reason: "node-pty-spawn-error",
    detail: "EACCES",
  });
  assert.equal(next.t1.bell, false);
  assert.equal(next.t1.status, "error");
});

// --- exit ----------------------------------------------------------------

test("clean exit (code 0) marks the terminal idle and records the exit code", () => {
  const prev = { t1: termState("t1") };
  const next = applyPtyEvent(prev, { type: "exit", ptyId: "t1", exitCode: 0 });
  assert.equal(next.t1.status, "idle");
  assert.equal(next.t1.bell, false);
  assert.equal(next.t1.exitCode, 0);
});

test("non-zero exit marks the terminal error", () => {
  const prev = { t1: termState("t1") };
  const next = applyPtyEvent(prev, { type: "exit", ptyId: "t1", exitCode: 137 });
  assert.equal(next.t1.status, "error");
  assert.equal(next.t1.exitCode, 137);
});

test("exit clears any pending bell so the dock badge drops", () => {
  const prev = { t1: termState("t1", { status: "waiting", bell: true }) };
  const next = applyPtyEvent(prev, { type: "exit", ptyId: "t1", exitCode: 0 });
  assert.equal(next.t1.bell, false);
});

test("exit for an unknown ptyId is a no-op", () => {
  const prev = { t1: termState("t1") };
  const next = applyPtyEvent(prev, {
    type: "exit",
    ptyId: "ghost",
    exitCode: 0,
  });
  assert.equal(next, prev);
});

// --- data: approval detection -------------------------------------------

test("approval-prompt chunk transitions running -> waiting and rings the bell", () => {
  const prev = { t1: termState("t1", { status: "running", bell: false }) };
  const next = applyPtyEvent(prev, {
    type: "data",
    ptyId: "t1",
    chunk: "Do you want me to apply this edit?",
  });
  assert.equal(next.t1.status, "waiting");
  assert.equal(next.t1.bell, true);
});

test("approval-prompt while already waiting is idempotent (same map reference)", () => {
  const prev = { t1: termState("t1", { status: "waiting", bell: true }) };
  const next = applyPtyEvent(prev, {
    type: "data",
    ptyId: "t1",
    chunk: "Do you want to continue?",
  });
  assert.equal(next, prev);
});

// --- data: busy resumes from waiting ------------------------------------

test("substantial output after a waiting prompt clears the bell and returns to running", () => {
  const prev = { t1: termState("t1", { status: "waiting", bell: true }) };
  const next = applyPtyEvent(prev, {
    type: "data",
    ptyId: "t1",
    chunk: "Compiling... ".repeat(20),
  });
  assert.equal(next.t1.status, "running");
  assert.equal(next.t1.bell, false);
});

test("short output while waiting does NOT clear the bell (just a cursor repaint)", () => {
  const prev = { t1: termState("t1", { status: "waiting", bell: true }) };
  const next = applyPtyEvent(prev, {
    type: "data",
    ptyId: "t1",
    chunk: "\x1b[K",
  });
  assert.equal(next, prev);
});

// --- data: status transitions for non-waiting terminals -----------------

test("any data from an idle terminal flips it back to running", () => {
  const prev = { t1: termState("t1", { status: "idle" }) };
  const next = applyPtyEvent(prev, {
    type: "data",
    ptyId: "t1",
    chunk: "$ ",
  });
  assert.equal(next.t1.status, "running");
});

test("data while running is a no-op (no spurious state churn)", () => {
  const prev = { t1: termState("t1", { status: "running" }) };
  const next = applyPtyEvent(prev, {
    type: "data",
    ptyId: "t1",
    chunk: "stdout line\n",
  });
  assert.equal(next, prev);
});

// --- data: exited / unknown terminals -----------------------------------

test("data arriving for an already-exited terminal does not resurrect it", () => {
  const prev = {
    t1: termState("t1", { status: "idle", exitCode: 0 }),
  };
  const next = applyPtyEvent(prev, {
    type: "data",
    ptyId: "t1",
    chunk: "Compiling... ".repeat(20),
  });
  assert.equal(next, prev);
  assert.equal(next.t1.exitCode, 0);
  assert.equal(next.t1.status, "idle");
});

test("data for an unknown ptyId is a no-op (lifecycle race after close)", () => {
  const prev = { t1: termState("t1") };
  const next = applyPtyEvent(prev, {
    type: "data",
    ptyId: "ghost",
    chunk: "x",
  });
  assert.equal(next, prev);
});

// --- isolation across terminals -----------------------------------------

test("an event for one terminal does not mutate sibling terminals", () => {
  const prev = {
    t1: termState("t1", { status: "running" }),
    t2: termState("t2", { status: "waiting", bell: true }),
  };
  const next = applyPtyEvent(prev, {
    type: "data",
    ptyId: "t1",
    chunk: "Do you want me to apply this?",
  });
  assert.equal(next.t2, prev.t2, "t2 reference should be unchanged");
});

// --- eventTouchesActivity -----------------------------------------------

test("eventTouchesActivity: data chunks count as activity", () => {
  assert.equal(
    eventTouchesActivity({ type: "data", ptyId: "t1", chunk: "x" }),
    true,
  );
});

test("eventTouchesActivity: exit and spawn-failed don't count as activity", () => {
  assert.equal(
    eventTouchesActivity({ type: "exit", ptyId: "t1", exitCode: 0 }),
    false,
  );
  assert.equal(
    eventTouchesActivity({
      type: "spawn-failed",
      ptyId: "t1",
      reason: "command-not-found",
      detail: "claude",
    }),
    false,
  );
});
