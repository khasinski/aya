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
