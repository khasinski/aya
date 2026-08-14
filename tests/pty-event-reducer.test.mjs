// Pure reducer behind the PTY event router. Every UI cue Aya gives about a
// terminal — running / waiting / idle / error and the dock-badge bell — flows
// through here, so the state machine deserves direct coverage.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyPtyEvent,
  clearedTerminalStatus,
  controlLevelToTerminalStatus,
  controlStatusEventTitle,
  deriveLifecycleStatus,
  eventTouchesActivity,
  isTerminalDone,
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

// --- deriveLifecycleStatus ----------------------------------------------
// Shared truth for "what colour is a terminal from its process alone",
// reused by the control-status "clear" handler so clearing the agent overlay
// falls back to the same lifecycle rules the reducer uses (#34).

test("deriveLifecycleStatus: a live process (exitCode null) is idle", () => {
  assert.equal(deriveLifecycleStatus({ exitCode: null }), "idle");
});

test("deriveLifecycleStatus: a clean exit (code 0) is idle", () => {
  assert.equal(deriveLifecycleStatus({ exitCode: 0 }), "idle");
});

test("deriveLifecycleStatus: a non-zero exit is error", () => {
  assert.equal(deriveLifecycleStatus({ exitCode: 1 }), "error");
  assert.equal(deriveLifecycleStatus({ exitCode: 137 }), "error");
});

test("deriveLifecycleStatus: a spawn failure is error even before exit", () => {
  assert.equal(
    deriveLifecycleStatus({
      exitCode: null,
      spawnFailure: { reason: "command-not-found", detail: "claude" },
    }),
    "error",
  );
});

test("deriveLifecycleStatus: spawn failure wins over an otherwise-clean exit", () => {
  assert.equal(
    deriveLifecycleStatus({
      exitCode: 0,
      spawnFailure: { reason: "node-pty-spawn-error", detail: "boom" },
    }),
    "error",
  );
});

// --- clearedTerminalStatus ----------------------------------------------
// Shared by the control-socket `clear` and the clickable status dot (#34).
// Reuses the termState() helper declared at the top of this file.

test("clearedTerminalStatus: drops the agent overlay and reverts a live error to idle", () => {
  const t = termState("t1", {
    status: "error",
    externalStatus: { level: "error", text: "boom", updatedAt: 1 },
  });
  const next = clearedTerminalStatus(t);
  assert.equal(next.externalStatus, undefined);
  assert.equal(next.status, "idle");
});

test("clearedTerminalStatus: keeps error for a genuinely failed (exited) terminal", () => {
  const t = termState("t1", {
    status: "error",
    exitCode: 1,
    externalStatus: { level: "error", text: "boom", updatedAt: 1 },
  });
  const next = clearedTerminalStatus(t);
  assert.equal(next.externalStatus, undefined);
  assert.equal(next.status, "error");
});

test("clearedTerminalStatus: clears the bell left by a waiting overlay", () => {
  const t = termState("t1", {
    status: "waiting",
    bell: true,
    externalStatus: { level: "waiting", text: "needs input", updatedAt: 1 },
  });
  const next = clearedTerminalStatus(t);
  assert.equal(next.bell, false);
  assert.equal(next.status, "idle");
});

// --- osc-status ------------------------------------------------------------
// Explicit status parsed from an inline OSC 9001 sequence (integrations.md) —
// the same vocabulary as the control-socket `aya status` path, delivered
// through the PTY stream instead. Must drive status/bell/externalStatus
// identically to the control-socket effect in App.tsx.

test("osc-status: waiting sets status + rings the bell + records externalStatus", () => {
  const prev = { t1: termState("t1", { status: "running", bell: false }) };
  const next = applyPtyEvent(prev, {
    type: "osc-status",
    ptyId: "t1",
    level: "waiting",
    text: "Approval needed",
    updatedAt: 1000,
  });
  assert.equal(next.t1.status, "waiting");
  assert.equal(next.t1.bell, true);
  assert.deepEqual(next.t1.externalStatus, {
    level: "waiting",
    text: "Approval needed",
    updatedAt: 1000,
  });
});

test("osc-status: done maps to idle and clears the bell", () => {
  const prev = { t1: termState("t1", { status: "waiting", bell: true }) };
  const next = applyPtyEvent(prev, {
    type: "osc-status",
    ptyId: "t1",
    level: "done",
    text: "Build passed",
    updatedAt: 2000,
  });
  assert.equal(next.t1.status, "idle");
  assert.equal(next.t1.bell, false);
});

test("osc-status: active maps to running", () => {
  const prev = { t1: termState("t1", { status: "idle" }) };
  const next = applyPtyEvent(prev, {
    type: "osc-status",
    ptyId: "t1",
    level: "active",
    text: "Running tests",
    updatedAt: 3000,
  });
  assert.equal(next.t1.status, "running");
  assert.equal(next.t1.bell, false);
});

test("osc-status: error maps to error", () => {
  const prev = { t1: termState("t1", { status: "running" }) };
  const next = applyPtyEvent(prev, {
    type: "osc-status",
    ptyId: "t1",
    level: "error",
    text: "Tests failed",
    updatedAt: 4000,
  });
  assert.equal(next.t1.status, "error");
});

test("osc-status: blank text is a no-op (same map reference)", () => {
  const prev = { t1: termState("t1") };
  const next = applyPtyEvent(prev, {
    type: "osc-status",
    ptyId: "t1",
    level: "waiting",
    text: "   ",
    updatedAt: 5000,
  });
  assert.equal(next, prev);
});

test("osc-status: unknown ptyId is a no-op", () => {
  const prev = { t1: termState("t1") };
  const next = applyPtyEvent(prev, {
    type: "osc-status",
    ptyId: "ghost",
    level: "waiting",
    text: "hi",
    updatedAt: 6000,
  });
  assert.equal(next, prev);
});

test("eventTouchesActivity: osc-status counts as activity", () => {
  assert.equal(
    eventTouchesActivity({
      type: "osc-status",
      ptyId: "t1",
      level: "active",
      text: "Running",
      updatedAt: 1,
    }),
    true,
  );
});

test("controlLevelToTerminalStatus maps every level", () => {
  assert.equal(controlLevelToTerminalStatus("waiting"), "waiting");
  assert.equal(controlLevelToTerminalStatus("done"), "idle");
  assert.equal(controlLevelToTerminalStatus("error"), "error");
  assert.equal(controlLevelToTerminalStatus("active"), "running");
});

test("controlStatusEventTitle produces a per-level human title", () => {
  assert.equal(controlStatusEventTitle("Claude", "waiting"), "Claude is waiting");
  assert.equal(controlStatusEventTitle("Claude", "done"), "Claude finished");
  assert.equal(controlStatusEventTitle("Claude", "error"), "Claude reported an error");
  assert.equal(controlStatusEventTitle("Claude", "active"), "Claude updated status");
});

// --- isTerminalDone --------------------------------------------------------
// Shared by the project-badge computation and the completion sound: what
// counts as "finished" for a terminal.

test("isTerminalDone: explicit externalStatus done is done regardless of PTY state", () => {
  assert.equal(
    isTerminalDone({
      externalStatus: { level: "done", text: "x", updatedAt: 1 },
      status: "running",
      exitCode: null,
      presetId: "codex",
    }),
    true,
  );
});

test("isTerminalDone: idle + clean exit is done for an agent preset", () => {
  assert.equal(
    isTerminalDone({ status: "idle", exitCode: 0, presetId: "claude" }),
    true,
  );
});

test("isTerminalDone: a plain shell never reads as done from lifecycle alone", () => {
  assert.equal(
    isTerminalDone({ status: "idle", exitCode: 0, presetId: "shell" }),
    false,
  );
});

test("isTerminalDone: idle with a non-zero exit is not done", () => {
  assert.equal(
    isTerminalDone({ status: "idle", exitCode: 1, presetId: "claude" }),
    false,
  );
});

test("isTerminalDone: a live (non-idle) terminal is not done", () => {
  assert.equal(
    isTerminalDone({ status: "running", exitCode: null, presetId: "claude" }),
    false,
  );
});

// --- no-session ----------------------------------------------------------

test("no-session marks the terminal stopped + restartable, not running", () => {
  const prev = { t1: termState("t1", { status: "running", bell: true }) };
  const next = applyPtyEvent(prev, { type: "no-session", ptyId: "t1" });
  assert.equal(next.t1.stopped, true);
  assert.equal(next.t1.bell, false);
  // exitCode stays null so it never reads as a clean "done" finish, and the
  // derived lifecycle status is idle (restartable), not running or error.
  assert.equal(next.t1.exitCode, null);
  assert.equal(next.t1.status, "idle");
});

test("no-session for an unknown ptyId is a no-op (same map reference)", () => {
  const prev = { t1: termState("t1") };
  const next = applyPtyEvent(prev, { type: "no-session", ptyId: "ghost" });
  assert.equal(next, prev);
});

test("no-session is not counted as activity", () => {
  assert.equal(eventTouchesActivity({ type: "no-session", ptyId: "t1" }), false);
});

// --- osc-session -----------------------------------------------------------
// The agent reports its session id mid-run; it rides on TerminalState until a
// persist writes it to the project's WorkingTab, so a later restore can resume
// that exact conversation instead of "whatever was latest".

test("osc-session records the id on the terminal", () => {
  const prev = { t1: termState("t1") };
  const next = applyPtyEvent(prev, {
    type: "osc-session",
    ptyId: "t1",
    sessionId: "claude-abc123",
  });
  assert.equal(next.t1.sessionId, "claude-abc123");
});

test("osc-session with an unchanged id is a no-op (same map reference)", () => {
  const prev = { t1: termState("t1", { sessionId: "same" }) };
  const next = applyPtyEvent(prev, {
    type: "osc-session",
    ptyId: "t1",
    sessionId: "same",
  });
  assert.equal(next, prev);
});

test("osc-session replaces an older id (agent started a new conversation)", () => {
  const prev = { t1: termState("t1", { sessionId: "old" }) };
  const next = applyPtyEvent(prev, {
    type: "osc-session",
    ptyId: "t1",
    sessionId: "new",
  });
  assert.equal(next.t1.sessionId, "new");
});

test("osc-session for an unknown ptyId is a no-op", () => {
  const prev = { t1: termState("t1") };
  const next = applyPtyEvent(prev, {
    type: "osc-session",
    ptyId: "ghost",
    sessionId: "x",
  });
  assert.equal(next, prev);
});

test("osc-session does not disturb status or bell", () => {
  const prev = { t1: termState("t1", { status: "waiting", bell: true }) };
  const next = applyPtyEvent(prev, {
    type: "osc-session",
    ptyId: "t1",
    sessionId: "x",
  });
  assert.equal(next.t1.status, "waiting");
  assert.equal(next.t1.bell, true);
});

// --- vt-status -------------------------------------------------------------
// Derived from the pane's real screen (electron/vt-state.ts). Unlike the
// byte-stream heuristic it reports BOTH edges, so it can also clear a stale
// waiting state — but it must never overrule what an agent said about itself.

test("vt-status waiting sets the waiting state and rings the bell", () => {
  const prev = { t1: termState("t1", { status: "running" }) };
  const next = applyPtyEvent(prev, {
    type: "vt-status",
    ptyId: "t1",
    waiting: true,
  });
  assert.equal(next.t1.status, "waiting");
  assert.equal(next.t1.bell, true);
});

test("vt-status clears a waiting state once the prompt leaves the screen", () => {
  // The byte heuristic cannot do this: it only ever sees the prompt appear.
  const prev = { t1: termState("t1", { status: "waiting", bell: true }) };
  const next = applyPtyEvent(prev, {
    type: "vt-status",
    ptyId: "t1",
    waiting: false,
  });
  assert.equal(next.t1.status, "running");
  assert.equal(next.t1.bell, false);
});

test("vt-status never overrules an agent's own reported status", () => {
  const prev = {
    t1: termState("t1", {
      status: "waiting",
      bell: true,
      externalStatus: { level: "waiting", text: "Needs approval", updatedAt: 1 },
    }),
  };
  const next = applyPtyEvent(prev, {
    type: "vt-status",
    ptyId: "t1",
    waiting: false,
  });
  assert.equal(next, prev);
});

test("vt-status does not resurrect an exited terminal", () => {
  const prev = { t1: termState("t1", { status: "idle", exitCode: 0 }) };
  const next = applyPtyEvent(prev, {
    type: "vt-status",
    ptyId: "t1",
    waiting: true,
  });
  assert.equal(next, prev);
});

test("vt-status with no actual change returns the same map reference", () => {
  const prev = { t1: termState("t1", { status: "waiting", bell: true }) };
  const next = applyPtyEvent(prev, {
    type: "vt-status",
    ptyId: "t1",
    waiting: true,
  });
  assert.equal(next, prev);
});

test("vt-status for an unknown ptyId is a no-op", () => {
  const prev = { t1: termState("t1") };
  const next = applyPtyEvent(prev, {
    type: "vt-status",
    ptyId: "ghost",
    waiting: true,
  });
  assert.equal(next, prev);
});

// --- precedence between the three waiting signals ---------------------------
// integrations.md documents the chain: an agent's own report > the rendered
// screen > a regex over raw bytes. The rule is asymmetric on purpose — a
// blocked agent nobody notices is the expensive failure, so a weaker signal
// may still RAISE the bell; it just may never silence or downgrade what the
// agent said about itself.

test("inferred signals may still raise the bell over a stale agent status", () => {
  // An agent that announced "active" once and then hit an approval prompt it
  // did not report must still ring, or the user waits forever.
  const prev = {
    t1: termState("t1", {
      status: "running",
      externalStatus: { level: "active", text: "Running tests", updatedAt: 1 },
    }),
  };
  const fromBytes = applyPtyEvent(prev, {
    type: "data",
    ptyId: "t1",
    chunk: "Do you want me to apply this edit?",
  });
  assert.equal(fromBytes.t1.bell, true);
  assert.equal(fromBytes.t1.status, "waiting");

  const fromScreen = applyPtyEvent(prev, { type: "vt-status", ptyId: "t1", waiting: true });
  assert.equal(fromScreen.t1.bell, true);
});

test("inferred signals never clear or downgrade an agent's own report", () => {
  const done = {
    t1: termState("t1", {
      status: "idle",
      bell: false,
      externalStatus: { level: "done", text: "Build passed", updatedAt: 1 },
    }),
  };
  // Ordinary output must not flip a reported "done" back to running.
  assert.equal(applyPtyEvent(done, { type: "data", ptyId: "t1", chunk: "trailing log\n" }), done);
  // Nor may the screen watcher clear it.
  assert.equal(applyPtyEvent(done, { type: "vt-status", ptyId: "t1", waiting: false }), done);
});

test("an agent-reported status is preserved even while the bell is raised", () => {
  // The overlay stays so `aya status clear` (and the status dot) still work.
  const prev = {
    t1: termState("t1", {
      status: "running",
      externalStatus: { level: "active", text: "Running tests", updatedAt: 1 },
    }),
  };
  const next = applyPtyEvent(prev, { type: "vt-status", ptyId: "t1", waiting: true });
  assert.deepEqual(next.t1.externalStatus, {
    level: "active",
    text: "Running tests",
    updatedAt: 1,
  });
});
