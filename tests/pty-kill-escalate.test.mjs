// Kill escalation: killPty removes a PTY from the map and terminates the child.
// A stuck child (e.g. `claude --chrome`) can trap the default kill signal and
// survive, becoming an orphan that a later respawn of the same id turns into a
// SECOND live process. terminatePtyChild must escalate to SIGKILL so the old
// child actually dies. schedule is injectable so we run the escalation inline.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  terminatePtyChild,
  shutdownChildren,
  shutdownPtyChildren,
  spawnPty,
  activePtyCount,
  KILL_ESCALATE_MS,
} from "../dist-electron/pty.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// pty.ts logs lifecycle events to $AYA_HOME/pty-events.log (resolved lazily at
// the first append), so redirect it before any PTY call - otherwise unit runs
// write into the user's real ~/.aya.
process.env.AYA_HOME = mkdtempSync(join(tmpdir(), "aya-pty-test-"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Real-timer margins anchored to the production grace window so a retuned
// KILL_ESCALATE_MS moves them automatically. Values preserved from the
// hand-tuned originals (250 / 1000 / 700); slack is deliberate CI headroom.
const TRAP_INSTALL_MS = 150;
const SPAWN_SETTLE_MS = 100;
const GRACEFUL_EXIT_SETTLE_MS = 300;
const PRE_ESCALATION_PROBE_MS = KILL_ESCALATE_MS - 500; // after graceful kill, before SIGKILL
const POST_ESCALATION_TOTAL_MS = KILL_ESCALATE_MS + 250; // safely past the deadline

test("terminatePtyChild sends the default kill, then escalates to SIGKILL", () => {
  const signals = [];
  const fake = { kill: (s) => signals.push(s ?? "default") };
  let scheduled = null;
  terminatePtyChild(fake, (fn, ms) => {
    scheduled = { fn, ms };
  });

  // Immediate graceful kill (default signal), escalation deferred.
  assert.deepEqual(signals, ["default"]);
  assert.ok(scheduled, "an escalation must be scheduled");
  // Pin the exact grace window, not just "some delay": a near-zero grace would
  // race the graceful exit and defeat "let a well-behaved child clean up first".
  assert.equal(scheduled.ms, KILL_ESCALATE_MS, "escalation runs after the grace window");

  // Run the scheduled escalation -> uncatchable SIGKILL.
  scheduled.fn();
  assert.deepEqual(signals, ["default", "SIGKILL"]);
});

test("terminatePtyChild swallows errors but still attempts both kills", () => {
  let calls = 0;
  const fake = {
    kill: () => {
      calls += 1;
      throw new Error("process already gone");
    },
  };
  // Neither the immediate kill nor the (inline) escalation may throw...
  assert.doesNotThrow(() => terminatePtyChild(fake, (fn) => fn()));
  // ...and both kills must actually be ATTEMPTED - a do-nothing SUT that never
  // calls kill would also not throw, so the count is what makes this diagnostic.
  assert.equal(calls, 2, "both the graceful kill and the escalation are attempted");
});

// Reproduces the trigger against a REAL OS process: a child that traps/ignores
// SIGHUP (as `claude --chrome` effectively did - PID survived a graceful kill
// for minutes, orphaned, causing a double-spawn). The graceful signal must NOT
// kill it, and the SIGKILL escalation MUST. Uses child_process (no node-pty).
test("a SIGHUP-ignoring process survives the graceful kill but the escalation kills it", async () => {
  const child = spawn("sh", ["-c", "trap '' HUP; sleep 30"], { stdio: "ignore" });
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  await sleep(TRAP_INSTALL_MS); // let the trap install

  // Map the IPty-shaped kill(signal) onto the real process, recording signals so
  // we prove the graceful kill was actually SENT (not merely that the process
  // happened to survive - a SUT that skipped the graceful kill would also leave
  // a trap-HUP process alive at the 250ms checkpoint).
  const signals = [];
  const handle = {
    kill: (sig) => {
      signals.push(sig ?? "SIGHUP");
      try {
        process.kill(child.pid, sig ?? "SIGHUP");
      } catch {
        /* already gone */
      }
    },
  };
  terminatePtyChild(handle); // real setTimeout escalation

  await sleep(PRE_ESCALATION_PROBE_MS); // past the graceful kill, before escalation
  assert.deepEqual(signals, ["SIGHUP"], "the graceful signal was actually sent");
  assert.equal(exited, false, "SIGHUP-ignoring process must survive the graceful kill");

  await sleep(POST_ESCALATION_TOTAL_MS); // past KILL_ESCALATE_MS -> SIGKILL delivered
  assert.deepEqual(signals, ["SIGHUP", "SIGKILL"], "escalation followed with SIGKILL");
  assert.equal(exited, true, "the SIGKILL escalation must terminate the stuck process");
});

// Edge: a well-behaved process exits on the graceful signal; the later SIGKILL
// must be a harmless no-op (dead pid -> caught), not an error.
test("a normal process exits on the graceful signal; escalation is a harmless no-op", async () => {
  const child = spawn("sh", ["-c", "sleep 30"], { stdio: "ignore" }); // no trap -> dies on SIGHUP
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  await sleep(SPAWN_SETTLE_MS);
  // The handle does NOT swallow - so the escalation's SIGKILL on the by-then
  // dead pid throws ESRCH straight into terminatePtyChild's own try/catch. If
  // that catch regressed, the throw would escape the real setTimeout callback
  // and crash the test process (uncaught) - so the tail wait actually verifies
  // terminatePtyChild swallows the escalation error, not the handle.
  const handle = {
    kill: (sig) => process.kill(child.pid, sig ?? "SIGHUP"),
  };
  assert.doesNotThrow(() => terminatePtyChild(handle));
  await sleep(GRACEFUL_EXIT_SETTLE_MS); // graceful SIGHUP kills a non-trapping process quickly
  assert.equal(exited, true, "a non-trapping process dies on the graceful signal");
  await sleep(POST_ESCALATION_TOTAL_MS - GRACEFUL_EXIT_SETTLE_MS); // total wait passes the deadline -> must not crash
});

// Edge: terminating an already-exited process throws nothing (both signals hit a
// dead pid -> ESRCH, swallowed).
test("terminating an already-exited process attempts both kills without throwing", async () => {
  const child = spawn("sh", ["-c", "exit 0"], { stdio: "ignore" });
  await new Promise((r) => child.on("exit", r));
  let calls = 0;
  const handle = {
    kill: (sig) => {
      calls += 1;
      process.kill(child.pid, sig ?? "SIGHUP"); // real dead pid -> throws ESRCH
    },
  };
  assert.doesNotThrow(() => terminatePtyChild(handle, (fn) => fn()));
  // Both real ESRCH throws were swallowed AND both kills were attempted (a SUT
  // that skipped the kill would pass doesNotThrow alone).
  assert.equal(calls, 2, "graceful + escalation both attempted against the dead pid");
});

// Fake IPty child for shutdownChildren: records signals; a "well-behaved" child
// fires its onExit listener the moment it receives the graceful kill, a "stuck"
// one ignores the graceful signal and only its SIGKILL is observed (its onExit
// is never fired, mirroring a trap-HUP process the deadline must force-kill).
function fakeChild(behavior) {
  const signals = [];
  let onExit = null;
  return {
    signals,
    get exitListenerRegistered() {
      return onExit !== null;
    },
    kill(sig) {
      signals.push(sig ?? "graceful");
      if (behavior === "wellbehaved" && sig === undefined) onExit?.();
    },
    onExit(fn) {
      onExit = fn;
      return { dispose() {} };
    },
  };
}

// Event-driven shutdown: when every child exits on the graceful signal, resolve
// WITHOUT waiting for (or needing) the SIGKILL deadline - a clean quit is not
// delayed by a fixed timer.
test("shutdownChildren resolves as soon as well-behaved children exit (no wait for deadline)", () => {
  const a = fakeChild("wellbehaved");
  const b = fakeChild("wellbehaved");
  let scheduledDeadline = null;
  let done = 0;
  shutdownChildren([a, b], () => (done += 1), (fn, ms) => {
    scheduledDeadline = { fn, ms };
  });

  // Both exited on the graceful kill -> onDone already fired; no SIGKILL sent.
  assert.equal(done, 1, "shutdown resolves once the last child exits");
  assert.deepEqual(a.signals, ["graceful"]);
  assert.deepEqual(b.signals, ["graceful"]);
  // The deadline is scheduled at the grace window but is moot now; running it
  // late must not re-resolve or send a redundant fatal signal to live pids.
  assert.equal(scheduledDeadline.ms, KILL_ESCALATE_MS);
  scheduledDeadline.fn();
  assert.equal(done, 1, "onDone fires exactly once");
});

// A stuck child ignoring the graceful signal must NOT resolve shutdown early;
// only the deadline SIGKILL closes it out.
test("shutdownChildren escalates a stuck child to SIGKILL at the deadline", () => {
  const stuck = fakeChild("stuck");
  let deadline = null;
  let done = 0;
  shutdownChildren([stuck], () => (done += 1), (fn) => {
    deadline = fn;
  });

  assert.deepEqual(stuck.signals, ["graceful"]);
  assert.equal(done, 0, "not resolved while the stuck child is still alive");

  deadline(); // fire the KILL_ESCALATE_MS deadline
  assert.deepEqual(stuck.signals, ["graceful", "SIGKILL"], "survivor is force-killed");
  assert.equal(done, 1, "the deadline SIGKILL resolves shutdown");
});

// No children -> resolve on the next tick (deferred so a caller can flush its
// response before the process exits), never synchronously.
test("shutdownChildren with no children resolves on the next tick", () => {
  let scheduled = null;
  let done = 0;
  shutdownChildren([], () => (done += 1), (fn, ms) => {
    scheduled = { fn, ms };
  });
  assert.equal(done, 0, "not resolved synchronously");
  assert.equal(scheduled.ms, 0, "deferred to the next tick");
  scheduled.fn();
  assert.equal(done, 1);
});

// MUST BE LAST: shutdownPtyChildren sets a one-way shuttingDown flag on the
// module, so any test spawning after this would be affected. Once shutdown has
// begun, spawnPty must refuse to create a new child - otherwise a spawn arriving
// in the host's post-snapshot linger window would escape the shutdown sweep and
// be orphaned on exit (the widened-race gap this guard closes).
test("spawnPty refuses to start a child once shutdown has begun (z-last)", async () => {
  shutdownPtyChildren(() => {}, () => {}); // sets shuttingDown; empty map, no-op schedule
  const events = [];
  const sink = { isDestroyed: () => false, sendPtyEvent: (e) => events.push(e) };
  await spawnPty(
    { ptyId: "post-shutdown", command: "sh", cwd: process.cwd(), cols: 80, rows: 24 },
    sink,
  );
  // Guarded: no PTY registered and no spawn/failure event emitted. (Without the
  // guard, spawnPty would proceed - either registering a real PTY -> count 1, or
  // emitting a spawn-failure event -> events.length 1 - so both assertions bite.)
  assert.equal(activePtyCount(), 0, "no PTY registered after shutdown began");
  assert.equal(events.length, 0, "no spawn/failure event emitted after shutdown began");
});
