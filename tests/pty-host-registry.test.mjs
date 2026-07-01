// The reaper SIGKILLs process trees, so isReapableHost is the safety gate: it
// must be fail-closed - true ONLY when we are certain a live pid is the exact
// host a record describes. These tests pin every rejection path (a regression
// that flips one to `true` risks killing an unrelated user process).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isReapableHost,
  collectDescendants,
  writeHostRecord,
  readHostRecords,
  removeHostRecord,
  reapStaleHostRecords,
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
    // Kills by PROCESS GROUP (-pgid) plus the leader pid - NOT per-descendant
    // enumeration (that would be a reuse-race kill target). pgid == 5000.
    assert.deepEqual(killed.sort((a, b) => a - b), [-5000, 5000], "group kill + leader, no per-pid enumeration kill");
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
      readProcInfo: () => ({ alive: false, startTime: null, command: null }),
      listProcs: () => [],
      kill: () => assert.fail("must not kill anything"),
    });
    assert.deepEqual(summary, { reaped: [], killedDescendants: [], keptCompatible: [], gc: [] });
  });
});
