// Kill escalation: killPty removes a PTY from the map and terminates the child.
// A stuck child (e.g. `claude --chrome`) can trap the default kill signal and
// survive, becoming an orphan that a later respawn of the same id turns into a
// SECOND live process. terminatePtyChild must escalate to SIGKILL so the old
// child actually dies. schedule is injectable so we run the escalation inline.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { terminatePtyChild } from "../dist-electron/pty.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  assert.ok(scheduled.ms > 0, "escalation runs after a grace delay");

  // Run the scheduled escalation -> uncatchable SIGKILL.
  scheduled.fn();
  assert.deepEqual(signals, ["default", "SIGKILL"]);
});

test("terminatePtyChild swallows errors when the child already exited", () => {
  const fake = {
    kill: () => {
      throw new Error("process already gone");
    },
  };
  // Neither the immediate kill nor the (inline) escalation may throw.
  assert.doesNotThrow(() => terminatePtyChild(fake, (fn) => fn()));
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
  await sleep(150); // let the trap install

  // Map the IPty-shaped kill(signal) onto the real process.
  const handle = {
    kill: (sig) => {
      try {
        process.kill(child.pid, sig ?? "SIGHUP");
      } catch {
        /* already gone */
      }
    },
  };
  terminatePtyChild(handle); // real setTimeout escalation

  await sleep(250); // past the graceful kill, before escalation
  assert.equal(exited, false, "SIGHUP-ignoring process must survive the graceful kill");

  await sleep(1000); // past KILL_ESCALATE_MS -> SIGKILL delivered
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
  await sleep(100);
  // The handle does NOT swallow - so the escalation's SIGKILL on the by-then
  // dead pid throws ESRCH straight into terminatePtyChild's own try/catch. If
  // that catch regressed, the throw would escape the real setTimeout callback
  // and crash the test process (uncaught) - so the tail wait actually verifies
  // terminatePtyChild swallows the escalation error, not the handle.
  const handle = {
    kill: (sig) => process.kill(child.pid, sig ?? "SIGHUP"),
  };
  assert.doesNotThrow(() => terminatePtyChild(handle));
  await sleep(300); // graceful SIGHUP kills a non-trapping process quickly
  assert.equal(exited, true, "a non-trapping process dies on the graceful signal");
  await sleep(700); // escalation fires on the already-dead pid -> must not crash
});

// Edge: terminating an already-exited process throws nothing (both signals hit a
// dead pid -> ESRCH, swallowed).
test("terminating an already-exited process is a no-op", async () => {
  const child = spawn("sh", ["-c", "exit 0"], { stdio: "ignore" });
  await new Promise((r) => child.on("exit", r));
  const handle = {
    kill: (sig) => process.kill(child.pid, sig ?? "SIGHUP"), // will throw ESRCH
  };
  assert.doesNotThrow(() => terminatePtyChild(handle, (fn) => fn()));
});
