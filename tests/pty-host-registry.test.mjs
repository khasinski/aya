// The reaper SIGKILLs process trees, so isReapableHost is the safety gate: it
// must be fail-closed - true ONLY when we are certain a live pid is the exact
// host a record describes. These tests pin every rejection path (a regression
// that flips one to `true` risks killing an unrelated user process).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
import {
  isReapableHost,
  collectDescendants,
  writeHostRecord,
  readHostRecords,
  removeHostRecord,
  reapStaleHostRecords,
  classifyRecord,
} from "../dist-electron/pty-host-registry.js";

const SCRIPT = "/Applications/Aya.app/Contents/Resources/app.asar/dist-electron/pty-host.js";
const REC = {
  pid: 4242,
  pgid: 4242,
  version: "0.7.5",
  scriptHash: "abc",
  startTime: "Wed Jul  2 10:00:00 2026",
  nonce: "n1",
};
const GOOD_INFO = {
  alive: true,
  startTime: REC.startTime,
  command: `/Applications/Aya.app/Contents/MacOS/Aya ${SCRIPT}`,
};
const SELF = 999999; // a pid that is never our record's pid

test("isReapableHost: all checks pass -> reapable", () => {
  assert.equal(isReapableHost(REC, GOOD_INFO, SCRIPT, SELF), true);
});

test("isReapableHost: never reaps our own pid", () => {
  assert.equal(isReapableHost(REC, GOOD_INFO, SCRIPT, REC.pid), false);
});

test("isReapableHost: never signals init/invalid pids", () => {
  assert.equal(isReapableHost({ ...REC, pid: 1 }, GOOD_INFO, SCRIPT, SELF), false);
  assert.equal(isReapableHost({ ...REC, pid: 0 }, GOOD_INFO, SCRIPT, SELF), false);
});

test("isReapableHost: dead process is not reaped", () => {
  assert.equal(
    isReapableHost(REC, { alive: false, startTime: null, command: null }, SCRIPT, SELF),
    false,
  );
});

test("isReapableHost: start-time mismatch (PID reuse) is not reaped", () => {
  const reused = { ...GOOD_INFO, startTime: "Wed Jul  2 11:30:00 2026" };
  assert.equal(isReapableHost(REC, reused, SCRIPT, SELF), false);
});

test("isReapableHost: missing start time is not reaped", () => {
  assert.equal(isReapableHost(REC, { ...GOOD_INFO, startTime: null }, SCRIPT, SELF), false);
});

test("isReapableHost: command not matching the host script is not reaped", () => {
  const other = { ...GOOD_INFO, command: "/usr/bin/some-unrelated-electron-app --foo" };
  assert.equal(isReapableHost(REC, other, SCRIPT, SELF), false);
  assert.equal(isReapableHost(REC, { ...GOOD_INFO, command: null }, SCRIPT, SELF), false);
});

test("isReapableHost: a record that is not a detached leader (pgid != pid) is not reaped", () => {
  // Guards kill(-pgid) from ever targeting a group other than the verified
  // leader's own (a corrupted/foreign record could name an unrelated pgid).
  assert.equal(isReapableHost({ ...REC, pgid: 5 }, GOOD_INFO, SCRIPT, SELF), false);
});

test("collectDescendants: recursive tree, excludes root, cycle-safe", () => {
  const procs = [
    { pid: 100, ppid: 1 }, // root
    { pid: 200, ppid: 100 }, // child
    { pid: 300, ppid: 200 }, // grandchild
    { pid: 400, ppid: 100 }, // child
    { pid: 500, ppid: 999 }, // unrelated
  ];
  const d = collectDescendants(100, procs).sort((a, b) => a - b);
  assert.deepEqual(d, [200, 300, 400]);
  assert.equal(d.includes(100), false, "excludes the root");
  assert.equal(d.includes(500), false, "excludes unrelated");
});

test("collectDescendants: a ppid cycle does not hang or duplicate", () => {
  const procs = [
    { pid: 10, ppid: 20 },
    { pid: 20, ppid: 10 }, // cycle
  ];
  const d = collectDescendants(10, procs);
  assert.deepEqual(d, [20]);
});

test("host record write/read/remove round-trips atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "aya-reg-"));
  try {
    writeHostRecord(REC, dir);
    // Records name kill targets - they must be owner-only like the sockets.
    const mode = statSync(join(dir, `${REC.pid}.json`)).mode & 0o777;
    assert.equal(mode, 0o600, "host record written owner-only");
    writeHostRecord({ ...REC, pid: 4343 }, dir);
    const recs = readHostRecords(dir).sort((a, b) => a.pid - b.pid);
    assert.equal(recs.length, 2);
    assert.deepEqual(recs[0], REC);
    removeHostRecord(4242, dir);
    const after = readHostRecords(dir);
    assert.deepEqual(after.map((r) => r.pid), [4343]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readHostRecords: missing dir -> [], malformed files skipped", () => {
  assert.deepEqual(readHostRecords(join(tmpdir(), "aya-reg-does-not-exist-xyz")), []);
});

// --- reapStaleHostRecords orchestration (injected deps, no real processes) ---

const EXPECTED = { version: "0.8.0", scriptHash: "new" };

function withReg(recs, fn) {
  const dir = mkdtempSync(join(tmpdir(), "aya-reap-"));
  try {
    for (const r of recs) writeHostRecord(r, dir);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("reap: a stale, verified host has its whole tree SIGKILLed + record removed", () => {
  const stale = { pid: 5000, pgid: 5000, version: "0.7.0", scriptHash: "old", startTime: "T1", nonce: "x" };
  withReg([stale], (dir) => {
    const killed = [];
    const summary = reapStaleHostRecords(EXPECTED, SCRIPT, dir, {
      selfPid: 1,
      readProcInfo: (pid) => (pid === 5000 ? { alive: true, startTime: "T1", command: `Aya ${SCRIPT}` } : { alive: false, startTime: null, command: null }),
      listProcs: () => [
        { pid: 5000, ppid: 1 },
        { pid: 5001, ppid: 5000 }, // child
        { pid: 5002, ppid: 5001 }, // grandchild
        { pid: 6000, ppid: 1 }, // unrelated
      ],
      kill: (pid, sig) => { assert.equal(sig, "SIGKILL"); killed.push(pid); },
    });
    assert.deepEqual(summary.reaped, [5000]);
    // ONE group kill (-pgid) and nothing else: no per-descendant enumeration
    // kills (reuse-race targets) and no follow-up kill(pid) (POSIX group kill
    // already hits the leader; a second signal would be the only unverified one).
    assert.deepEqual(killed, [-5000], "exactly one group kill, no extra signals");
    assert.deepEqual(summary.killedDescendants.sort((a, b) => a - b), [5001, 5002], "descendants observed for the log only");
    assert.deepEqual(readHostRecords(dir), [], "stale record removed");
  });
});

test("reap: a compatible (same-build) live host is KEPT, never killed (#28 survive)", () => {
  const same = { pid: 7000, pgid: 7000, version: "0.8.0", scriptHash: "new", startTime: "T2", nonce: "y" };
  withReg([same], (dir) => {
    const killed = [];
    const summary = reapStaleHostRecords(EXPECTED, SCRIPT, dir, {
      selfPid: 1,
      readProcInfo: () => ({ alive: true, startTime: "T2", command: `Aya ${SCRIPT}` }),
      listProcs: () => [{ pid: 7000, ppid: 1 }],
      kill: (pid) => killed.push(pid),
    });
    assert.deepEqual(summary.keptCompatible, [7000]);
    assert.deepEqual(killed, [], "same-build host is not signalled");
    assert.equal(readHostRecords(dir).length, 1, "its record is kept");
  });
});

test("reap: a stale record whose pid was REUSED (start-time mismatch) is GC'd, NOT killed", () => {
  const stale = { pid: 8000, pgid: 8000, version: "0.7.0", scriptHash: "old", startTime: "T-orig", nonce: "z" };
  withReg([stale], (dir) => {
    const killed = [];
    const summary = reapStaleHostRecords(EXPECTED, SCRIPT, dir, {
      selfPid: 1,
      // pid 8000 is alive but with a DIFFERENT start time -> reused by something else
      readProcInfo: () => ({ alive: true, startTime: "T-different", command: "/usr/bin/unrelated" }),
      listProcs: () => [{ pid: 8000, ppid: 1 }],
      kill: (pid) => killed.push(pid),
    });
    assert.deepEqual(killed, [], "must NOT signal a reused pid");
    assert.deepEqual(summary.reaped, []);
    assert.deepEqual(summary.gc, [8000]);
    assert.deepEqual(readHostRecords(dir), [], "the stale record is dropped");
  });
});

test("reap: a compatible record whose pid was REUSED is GC'd, not kept, not killed", () => {
  const same = { pid: 7100, pgid: 7100, version: "0.8.0", scriptHash: "new", startTime: "T-was", nonce: "q" };
  withReg([same], (dir) => {
    const killed = [];
    const summary = reapStaleHostRecords(EXPECTED, SCRIPT, dir, {
      selfPid: 1,
      // alive but different start time -> pid reused by something unrelated
      readProcInfo: () => ({ alive: true, startTime: "T-now", command: "/usr/bin/other" }),
      listProcs: () => [{ pid: 7100, ppid: 1 }],
      kill: (pid) => killed.push(pid),
    });
    assert.deepEqual(killed, [], "never signal a reused pid, even on the keep path");
    assert.deepEqual(summary.keptCompatible, [], "a reused pid is not mistaken for our host");
    assert.deepEqual(summary.gc, [7100]);
  });
});

test("reap: a dead compatible record is GC'd", () => {
  const dead = { pid: 9000, pgid: 9000, version: "0.8.0", scriptHash: "new", startTime: "T3", nonce: "w" };
  withReg([dead], (dir) => {
    const killed = [];
    const summary = reapStaleHostRecords(EXPECTED, SCRIPT, dir, {
      selfPid: 1,
      readProcInfo: () => ({ alive: false, startTime: null, command: null }),
      listProcs: () => [],
      kill: (pid) => killed.push(pid),
    });
    assert.deepEqual(killed, []);
    assert.deepEqual(summary.gc, [9000]);
    assert.deepEqual(readHostRecords(dir), []);
  });
});

test("reap: empty registry is a no-op", () => {
  withReg([], (dir) => {
    const summary = reapStaleHostRecords(EXPECTED, SCRIPT, dir, {
      selfPid: 1,
      readProcInfo: () => ({ alive: false, probeFailed: false, startTime: null, command: null }),
      listProcs: () => [],
      kill: () => assert.fail("must not kill anything"),
    });
    assert.deepEqual(summary, {
      reaped: [],
      killedDescendants: [],
      keptCompatible: [],
      gc: [],
      skipped: [],
    });
  });
});

// --- the "unknown" identity sentinel must never decide a kill or a keep ---

test("classifyRecord: version mismatch is stale regardless of hashes", () => {
  assert.equal(classifyRecord({ version: "0.7.0", scriptHash: "unknown" }, EXPECTED), "stale");
  assert.equal(classifyRecord({ version: "0.7.0", scriptHash: "new" }, EXPECTED), "stale");
});

test("classifyRecord: same version needs BOTH hashes known to decide", () => {
  assert.equal(classifyRecord({ version: "0.8.0", scriptHash: "new" }, EXPECTED), "compatible");
  assert.equal(classifyRecord({ version: "0.8.0", scriptHash: "other" }, EXPECTED), "stale");
  // 'unknown' on either side -> indeterminate: 'unknown'==='unknown' must not
  // trust a foreign build, and real-vs-'unknown' must not SIGKILL a healthy one.
  assert.equal(classifyRecord({ version: "0.8.0", scriptHash: "unknown" }, EXPECTED), "indeterminate");
  assert.equal(
    classifyRecord({ version: "0.8.0", scriptHash: "real" }, { version: "0.8.0", scriptHash: "unknown" }),
    "indeterminate",
  );
});

test("reap: a LIVE indeterminate record is skipped - never killed, record kept", () => {
  const rec = { pid: 5100, pgid: 5100, version: "0.8.0", scriptHash: "unknown", startTime: "T", nonce: "n" };
  withReg([rec], (dir) => {
    const summary = reapStaleHostRecords(EXPECTED, SCRIPT, dir, {
      selfPid: 1,
      readProcInfo: () => ({ alive: true, probeFailed: false, startTime: "T", command: `Aya ${SCRIPT}` }),
      listProcs: () => [],
      kill: () => assert.fail("must not kill on an indeterminate identity"),
    });
    assert.deepEqual(summary.skipped, [5100]);
    assert.equal(readHostRecords(dir).length, 1, "record survives for a later launch");
  });
});

test("reap: a DEAD indeterminate record is GC'd (no kill) so unknown-hash records can't pile up", () => {
  const rec = { pid: 5150, pgid: 5150, version: "0.8.0", scriptHash: "unknown", startTime: "T", nonce: "n" };
  withReg([rec], (dir) => {
    const summary = reapStaleHostRecords(EXPECTED, SCRIPT, dir, {
      selfPid: 1,
      readProcInfo: () => ({ alive: false, probeFailed: false, startTime: null, command: null }),
      listProcs: () => [],
      kill: () => assert.fail("must not kill on an indeterminate identity"),
    });
    assert.deepEqual(summary.gc, [5150]);
    assert.deepEqual(readHostRecords(dir), [], "conclusively-dead record removed");
  });
});

test("reap: a kill failing with EPERM KEEPS the record (live host must stay reapable)", () => {
  const stale = { pid: 5300, pgid: 5300, version: "0.7.0", scriptHash: "old", startTime: "T", nonce: "n" };
  withReg([stale], (dir) => {
    const summary = reapStaleHostRecords(EXPECTED, SCRIPT, dir, {
      selfPid: 1,
      readProcInfo: () => ({ alive: true, probeFailed: false, startTime: "T", command: `Aya ${SCRIPT}` }),
      listProcs: () => [{ pid: 5300, ppid: 1 }],
      kill: () => {
        const err = new Error("not permitted");
        err.code = "EPERM";
        throw err;
      },
    });
    assert.deepEqual(summary.reaped, [], "a failed signal is not a reap");
    assert.deepEqual(summary.skipped, [5300]);
    assert.equal(readHostRecords(dir).length, 1, "record kept for a retry next launch");
  });
});

test("reap: a kill failing with ESRCH (group vanished mid-reap) still drops the record", () => {
  const stale = { pid: 5400, pgid: 5400, version: "0.7.0", scriptHash: "old", startTime: "T", nonce: "n" };
  withReg([stale], (dir) => {
    const summary = reapStaleHostRecords(EXPECTED, SCRIPT, dir, {
      selfPid: 1,
      readProcInfo: () => ({ alive: true, probeFailed: false, startTime: "T", command: `Aya ${SCRIPT}` }),
      listProcs: () => [],
      kill: () => {
        const err = new Error("no such process");
        err.code = "ESRCH";
        throw err;
      },
    });
    assert.deepEqual(summary.reaped, [5400], "gone-between-probe-and-kill counts as reaped");
    assert.deepEqual(readHostRecords(dir), []);
  });
});

test("reap: a failed probe (ps could not run) keeps the record - no kill, no GC", () => {
  const stale = { pid: 5200, pgid: 5200, version: "0.7.0", scriptHash: "old", startTime: "T", nonce: "n" };
  withReg([stale], (dir) => {
    const summary = reapStaleHostRecords(EXPECTED, SCRIPT, dir, {
      selfPid: 1,
      readProcInfo: () => ({ alive: false, probeFailed: true, startTime: null, command: null }),
      listProcs: () => [],
      kill: () => assert.fail("must not kill on an unknown process state"),
    });
    assert.deepEqual(summary.skipped, [5200]);
    assert.deepEqual(summary.gc, [], "a live stale host must not lose its record to a transient ps failure");
    assert.equal(readHostRecords(dir).length, 1);
  });
});

// --- registry hygiene ---

test("writeHostRecord refuses a record with an empty startTime", () => {
  const dir = mkdtempSync(join(tmpdir(), "aya-reg-"));
  try {
    writeHostRecord({ ...REC, startTime: "" }, dir);
    assert.deepEqual(readHostRecords(dir), [], "an unverifiable record must never be written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readHostRecords self-heals: unparseable and wrong-shape .json files are removed", () => {
  const dir = mkdtempSync(join(tmpdir(), "aya-reg-"));
  try {
    writeFileSync(join(dir, "123.json"), "{ not json");
    writeFileSync(join(dir, "456.json"), JSON.stringify({ pid: 0.5, pgid: 1 })); // wrong shape
    writeHostRecord(REC, dir); // one good record
    const recs = readHostRecords(dir);
    assert.deepEqual(recs.map((r) => r.pid), [REC.pid]);
    const left = readdirSync(dir).filter((n) => n.endsWith(".json"));
    assert.deepEqual(left, [`${REC.pid}.json`], "bad files are unlinked, not skipped forever");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- real host process: record lifecycle + graceful SIGTERM (integration) ---

test("a real spawned host writes its record, and SIGTERM shuts it down cleanly (record removed)", async () => {
  const home = mkdtempSync(join(tmpdir(), "aya-host-it-"));
  // detached:true mirrors the real client spawn (pty-host-client.ts startHost) -
  // and is REQUIRED for the record: a non-leader host refuses to publish (its
  // ownPgid() !== pid verification; confirmed by this very test failing without
  // detached).
  const host = spawn(process.execPath, ["dist-electron/pty-host.js"], {
    env: { ...process.env, AYA_HOME: home },
    stdio: "ignore",
    detached: true,
  });
  let exited = false;
  host.on("exit", () => {
    exited = true;
  });
  try {
    // Wait for the record (written after listen) - proves pid/pgid verification
    // passed and startTime was non-empty on a real process.
    const regDir = join(home, "pty-hosts");
    const deadline = Date.now() + 5000;
    let recs = [];
    while (Date.now() < deadline) {
      recs = readHostRecords(regDir);
      if (recs.length > 0) break;
      await sleep(50);
    }
    assert.equal(recs.length, 1, "host published its registry record");
    assert.equal(recs[0].pid, host.pid);
    assert.equal(recs[0].pgid, recs[0].pid, "host verified it leads its own group");
    assert.ok(recs[0].startTime.length > 0, "record carries a verifiable start time");

    // SIGTERM must now do a REAL graceful shutdown (not leave a socketless
    // zombie): host exits and removes its record (children confirmed dead -
    // there are none here).
    host.kill("SIGTERM");
    const exitDeadline = Date.now() + 5000;
    while (Date.now() < exitDeadline && !exited) await sleep(50);
    assert.equal(exited, true, "SIGTERM terminates the host (no suppressed-default zombie)");
    await sleep(100); // let the record removal land
    assert.deepEqual(readHostRecords(regDir), [], "clean shutdown removed the record");
  } finally {
    try {
      host.kill("SIGKILL");
    } catch {
      // already dead
    }
    rmSync(home, { recursive: true, force: true });
  }
});
