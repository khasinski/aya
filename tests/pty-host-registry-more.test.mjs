// More of the pty-host registry: the parts tests/pty-host-registry.test.mjs
// leaves out. The record writer and reader against hostile entries on disk
// (a file where the dir should be, a directory or a symlink where a record
// should be, unreadable files, FIFOs, aged .tmp entries that cannot be swept);
// two writer processes and a reader racing on one dir; the three ps readers
// against the real ps on processes this file spawns itself and against a fake
// ps; and the reaper with its DEFAULT deps and dir, driven against detached
// fake hosts this file starts, with process.kill wrapped so it can only ever
// signal the group the test expects.
//
// AYA_HOME points at a temp dir before pty-host-registry (and so paths.ts)
// loads. The fake ps patches execFileSync on the node:child_process module
// object, which the compiled CommonJS reads at every call; it is restored after
// each test. Waiting is by condition, never by a fixed sleep.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { waitFor } from "./helpers/wait-for.mjs";

const require = createRequire(import.meta.url);
const cp = require("node:child_process");
const crypto = require("node:crypto");
const realExecFileSync = cp.execFileSync;

const home = mkdtempSync(join(tmpdir(), "aya-pty-host-registry-more-"));
process.env.AYA_HOME = home;
const REG_DIR = join(home, "pty-hosts"); // the module's default dir under this AYA_HOME
const REGISTRY_JS = resolve("dist-electron/pty-host-registry.js");

// Every process this file starts, killed at the end whatever happened.
const started = new Set();
const killQuietly = (pid) => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
};

// Registered before the imports, so a failing import leaves nothing behind.
test.after(() => {
  for (const pid of started) killQuietly(pid);
  rmSync(home, { recursive: true, force: true });
  delete process.env.AYA_HOME;
});

const {
  writeHostRecord,
  readHostRecords,
  removeHostRecord,
  readProcInfo,
  listProcs,
  ownStartTime,
  ownPgid,
  reapStaleHostRecords,
} = await import("../dist-electron/pty-host-registry.js");

const SCRIPT = "/Applications/Aya.app/Contents/Resources/app.asar/dist-electron/pty-host.js";
const EXPECTED = { version: "0.8.0", scriptHash: "new" };
const REC = { pid: 4242, pgid: 4242, version: "0.7.5", scriptHash: "abc", startTime: "Wed Jul  2 10:00:00 2026", nonce: "n1" };
// `ps -o lstart` under C locale: "Tue Oct 13 00:17:03 2026", day space-padded.
const CTIME = /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4}$/;
const isRoot = process.getuid?.() === 0;

let dirSeq = 0;
/** A fresh registry dir for one test, removed after it. */
function freshDir(t) {
  const dir = join(home, `reg-${++dirSeq}`);
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Replaces execFileSync for this test only; `impl` gets (cmd, args, opts). */
function fakePs(t, impl) {
  cp.execFileSync = impl;
  t.after(() => {
    cp.execFileSync = realExecFileSync;
  });
}

const spawnError = () => Object.assign(new Error("spawn ps ENOENT"), { code: "ENOENT", errno: -2, status: null });

/** process.kill passes through only for the targets in `allowed`; every call is recorded. */
function guardKill(t, allowed) {
  const real = process.kill;
  const calls = [];
  process.kill = function (pid, signal) {
    if(signal===0)return real.call(process,pid,signal); // Kernel presence probe, no signal sent.
    calls.push([pid, signal]);
    if (!allowed.has(pid)) throw Object.assign(new Error(`test refused to signal ${pid}`), { code: "EPERM" });
    return real.call(process, pid, signal);
  };
  t.after(() => {
    process.kill = real;
  });
  return calls;
}

/** Recorded deps for the reaper, so no real process is probed or signalled. */
function fakeDeps(infoByPid, overrides = {}) {
  const killed = [];
  let snapshots = 0;
  return {
    killed,
    snapshots: () => snapshots,
    deps: {
      selfPid: 1,
      readProcInfo: (pid) => infoByPid[pid] ?? { alive: false, probeFailed: false, startTime: null, command: null },
      listProcs: () => {
        snapshots++;
        return [];
      },
      kill: (pid, sig) => killed.push([pid, sig]),
      ...overrides,
    },
  };
}

const liveAs = (startTime) => ({ alive: true, probeFailed: false, startTime, command: `Aya ${SCRIPT}` });

/** A fake host: `node <dir>/pty-host.js`, optionally with a `sleep` grandchild. Resolves once it runs. */
async function startFakeHost(t, { detached = true, grandchild = false } = {}) {
  const dir = join(home, `build-${++dirSeq}`);
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "pty-host.js");
  writeFileSync(
    script,
    `const { spawn } = require("node:child_process");
     const g = ${grandchild} ? spawn("sleep", ["1000"], { stdio: "ignore" }).pid : null;
     process.stdout.write(JSON.stringify({ grandchild: g }) + "\\n");
     setInterval(() => {}, 1 << 30);`,
  );
  const child = spawn(process.execPath, [script], { detached, stdio: ["ignore", "pipe", "ignore"] });
  started.add(child.pid);
  const state = { exit: null };
  child.on("exit", (code, signal) => {
    state.exit = { code, signal };
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  const ready = await waitFor(() => out.includes("\n") && JSON.parse(out.split("\n")[0]));
  if (ready.grandchild) started.add(ready.grandchild);
  t.after(() => {
    killQuietly(child.pid);
    if (ready.grandchild) killQuietly(ready.grandchild);
  });
  return { pid: child.pid, grandchild: ready.grandchild, script, state };
}

/** Runs `code` (an ES module body with `reg` bound to the registry) in a fresh node. */
function runNode(code, { detached = false } = {}) {
  const body = `const reg = await import(${JSON.stringify(REGISTRY_JS)});\n${code}`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", body], {
    detached,
    stdio: ["ignore", "pipe", "pipe"],
  });
  started.add(child.pid);
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const done = new Promise((ok, fail) =>
    child.on("exit", (c, s) => (c === 0 ? ok(out) : fail(new Error(`node exit ${c ?? s}: ${err}`)))),
  );
  return { child, done };
}

// --- writeHostRecord: best effort, never throws, never writes through ---------

test("writeHostRecord: a registry path that is a regular file -> no throw, the file untouched", (t) => {
  const parent = freshDir(t);
  const notADir = join(parent, "pty-hosts");
  writeFileSync(notADir, "precious");
  assert.doesNotThrow(() => writeHostRecord(REC, notADir));
  assert.equal(readFileSync(notADir, "utf8"), "precious");
  assert.deepEqual(readdirSync(parent), ["pty-hosts"], "nothing written next to it either");
});

test("writeHostRecord: a directory squatting on the record path -> no throw, no .tmp left behind", (t) => {
  const dir = freshDir(t);
  mkdirSync(join(dir, `${REC.pid}.json`));
  assert.doesNotThrow(() => writeHostRecord(REC, dir));
  assert.deepEqual(readdirSync(dir), [`${REC.pid}.json`], "the failed rename's temp file is cleaned up");
  assert.ok(statSync(join(dir, `${REC.pid}.json`)).isDirectory(), "the directory is not removed");
});

test("writeHostRecord: an unwritable registry dir -> no throw, no record", { skip: isRoot && "root ignores modes" }, (t) => {
  const dir = freshDir(t);
  chmodSync(dir, 0o500);
  try {
    assert.doesNotThrow(() => writeHostRecord(REC, dir));
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    chmodSync(dir, 0o700);
  }
});

test("writeHostRecord: a symlink planted at the record path is replaced, its target never written", (t) => {
  const dir = freshDir(t);
  const victim = join(freshDir(t), "victim.txt");
  writeFileSync(victim, "precious");
  symlinkSync(victim, join(dir, `${REC.pid}.json`));
  writeHostRecord(REC, dir);
  assert.equal(readFileSync(victim, "utf8"), "precious", "the rename replaces the link, never follows it");
  assert.ok(lstatSync(join(dir, `${REC.pid}.json`)).isFile(), "the record is a regular file now");
  assert.deepEqual(readHostRecords(dir), [REC]);
});

test("writeHostRecord: rewriting a record left world-readable makes it owner-only again", (t) => {
  const dir = freshDir(t);
  const file = join(dir, `${REC.pid}.json`);
  writeFileSync(file, JSON.stringify(REC), { mode: 0o644 });
  chmodSync(file, 0o644);
  writeHostRecord({ ...REC, nonce: "n2" }, dir);
  assert.equal(statSync(file).mode & 0o777, 0o600, "a record names a kill target: never readable by others");
  assert.equal(readHostRecords(dir)[0].nonce, "n2");
});

test(
  "writeHostRecord: a symlink planted at the temp path is not written through",
  (t) => {
    const dir = freshDir(t);
    const victim = join(freshDir(t), "victim.txt");
    writeFileSync(victim, "precious");
    // Pin the temp name's random part so the plant lands where the writer will write.
    const realRandomBytes = crypto.randomBytes;
    crypto.randomBytes = (n, ...rest) => (n === 4 && rest.length === 0 ? Buffer.from("deadbeef", "hex") : realRandomBytes(n, ...rest));
    t.after(() => {
      crypto.randomBytes = realRandomBytes;
    });
    symlinkSync(victim, join(dir, `${REC.pid}.json.${process.pid}.deadbeef.tmp`));
    writeHostRecord(REC, dir);
    assert.equal(readFileSync(victim, "utf8"), "precious", "a file outside the registry is overwritten with the record");
    // The write fails instead (best effort: no record this time), and the planted link is cleaned up.
    let linked = false;
    try { linked = lstatSync(join(dir, `${REC.pid}.json`)).isSymbolicLink(); } catch { /* no record */ }
    assert.equal(linked, false, "the record path never becomes a symlink to it");
    assert.deepEqual(readdirSync(dir), [], "the planted temp link is removed with the failed write");
  },
);

// --- readHostRecords: hostile entries are skipped or removed, never followed ---

test("readHostRecords: a directory named like a record is left in place and the rest still read", (t) => {
  const dir = freshDir(t);
  mkdirSync(join(dir, "5000.json"));
  writeFileSync(join(dir, "5000.json", "keep.txt"), "x");
  writeHostRecord(REC, dir);
  assert.deepEqual(readHostRecords(dir), [REC]);
  assert.ok(existsSync(join(dir, "5000.json", "keep.txt")), "a directory is never removed (no recursive rm)");
});

test("readHostRecords: a .json far larger than any record is not kept, and the rest still read", (t) => {
  const dir = freshDir(t);
  writeFileSync(join(dir, "5000.json"), JSON.stringify({ ...REC, pid: 5000, pad: "x".repeat(200_000) }));
  writeHostRecord(REC, dir);
  assert.deepEqual(readHostRecords(dir), [REC]);
  assert.equal(existsSync(join(dir, "5000.json")), false, "an oversized file is no record: removed, not parsed");
});

test("readHostRecords: a .json symlink to a non-record file loses the link, never the target", (t) => {
  const dir = freshDir(t);
  const victim = join(freshDir(t), "settings.json");
  writeFileSync(victim, JSON.stringify({ hooks: {} }));
  symlinkSync(victim, join(dir, "5000.json"));
  assert.deepEqual(readHostRecords(dir), []);
  assert.equal(existsSync(join(dir, "5000.json")), false, "the wrong-shape entry is unlinked");
  assert.equal(readFileSync(victim, "utf8"), JSON.stringify({ hooks: {} }), "its target is untouched");
});

test("readHostRecords: an aged .tmp symlink is swept as a link, its old target survives", (t) => {
  const dir = freshDir(t);
  const victim = join(freshDir(t), "old-notes.txt");
  writeFileSync(victim, "precious");
  const old = new Date(Date.now() - 120_000);
  utimesSync(victim, old, old); // statSync follows the link: the target's age decides
  symlinkSync(victim, join(dir, "4242.json.1.abcdef12.tmp"));
  assert.deepEqual(readHostRecords(dir), []);
  assert.deepEqual(readdirSync(dir), [], "the aged link is swept");
  assert.equal(readFileSync(victim, "utf8"), "precious", "rm removes the link, not the file it points at");
});

test("readHostRecords: .tmp entries that cannot be swept do not abort the read", (t) => {
  const dir = freshDir(t);
  const agedDir = join(dir, "4242.json.1.abcdef12.tmp");
  mkdirSync(agedDir);
  writeFileSync(join(agedDir, "inner"), "x");
  const old = new Date(Date.now() - 120_000);
  utimesSync(agedDir, old, old);
  symlinkSync(join(dir, "gone"), join(dir, "4243.json.1.abcdef12.tmp")); // dangling: stat fails
  writeHostRecord(REC, dir);
  assert.deepEqual(readHostRecords(dir), [REC], "the valid record is still returned");
  assert.ok(existsSync(join(agedDir, "inner")), "an aged .tmp directory is not removed recursively");
});

test(
  "readHostRecords: a record it cannot read (EACCES) is kept, not deleted as a crash artifact",
  { skip: isRoot && "root ignores modes" },
  (t) => {
    const dir = freshDir(t);
    writeHostRecord(REC, dir);
    const file = join(dir, `${REC.pid}.json`);
    chmodSync(file, 0o000);
    t.after(() => {
      if (existsSync(file)) chmodSync(file, 0o600);
    });
    readHostRecords(dir);
    // A failed read is like a failed probe: the state is unknown, and the record
    // is a live host's only reapability pointer.
    assert.ok(existsSync(file), "a valid record lost to a transient read error");
  },
);

test(
  "readHostRecords: a FIFO named like a record does not hang the read",
  async (t) => {
    const dir = freshDir(t);
    realExecFileSync("mkfifo", [join(dir, "5000.json")]);
    writeHostRecord(REC, dir);
    const { child, done } = runNode(`console.log(JSON.stringify(reg.readHostRecords(${JSON.stringify(dir)})));`);
    t.after(() => killQuietly(child.pid));
    let timer;
    const outcome = await Promise.race([
      done.then((out) => ({ out })),
      new Promise((r) => (timer = setTimeout(() => r({ hung: true }), 5000))),
    ]);
    clearTimeout(timer);
    assert.equal(outcome.hung, undefined, "readHostRecords still blocked after 5 s");
    assert.deepEqual(JSON.parse(outcome.out), [REC]);
  },
);

test(
  "reap: a record whose file name disagrees with its pid never deletes another host's record",
  (t) => {
    const dir = freshDir(t);
    const live = { pid: 7001, pgid: 7001, ...EXPECTED, startTime: "T-live", nonce: "live" };
    writeHostRecord(live, dir);
    // e.g. a copy left by a restore, or a host's file renamed by hand
    writeFileSync(join(dir, "5000.json"), JSON.stringify({ ...live, startTime: "T-old", nonce: "copy" }), { mode: 0o600 });
    const { deps, killed } = fakeDeps({ 7001: liveAs("T-live") });
    const summary = reapStaleHostRecords(EXPECTED, SCRIPT, dir, deps);
    assert.deepEqual(killed, []);
    assert.ok(summary.keptCompatible.includes(7001));
    assert.ok(existsSync(join(dir, "7001.json")), "the live compatible host lost its record");
    assert.equal(existsSync(join(dir, "5000.json")), false, "the mislabeled file is never cleaned up");
  },
);

// --- removeHostRecord ------------------------------------------------------------

test("removeHostRecord never throws: an absent record, an absent dir, a directory at the path", (t) => {
  const dir = freshDir(t);
  assert.doesNotThrow(() => removeHostRecord(4242, dir));
  assert.doesNotThrow(() => removeHostRecord(4242, join(dir, "missing")));
  mkdirSync(join(dir, "4242.json"));
  assert.doesNotThrow(() => removeHostRecord(4242, dir));
  assert.ok(statSync(join(dir, "4242.json")).isDirectory(), "a directory is left in place, not removed recursively");
  writeHostRecord({ ...REC, pid: 4343, pgid: 4343 }, dir);
  removeHostRecord(4343, dir);
  assert.equal(existsSync(join(dir, "4343.json")), false);
});

// --- races --------------------------------------------------------------------------

test("two writer processes and a reader racing on one dir: every record stays whole and present", async (t) => {
  const dir = freshDir(t);
  const PIDS = Array.from({ length: 8 }, (_, i) => 6000 + i);
  for (const pid of PIDS) writeHostRecord({ ...REC, pid, pgid: pid, nonce: "seed" }, dir);
  const at = Date.now() + 500; // a start barrier, so the three overlap
  const barrier = `while (Date.now() < ${at}) await new Promise((r) => setTimeout(r, 1));`;
  const writer = (tag) =>
    runNode(`${barrier}
      for (let round = 0; round < 150; round++)
        for (const pid of ${JSON.stringify(PIDS)})
          reg.writeHostRecord({ ...${JSON.stringify(REC)}, pid, pgid: pid, nonce: "${tag}-" + round }, ${JSON.stringify(dir)});`);
  const reader = runNode(`${barrier}
    let min = Infinity, passes = 0;
    for (; passes < 400; passes++) min = Math.min(min, reg.readHostRecords(${JSON.stringify(dir)}).length);
    console.log(JSON.stringify({ min, passes }));`);
  const [, , out] = await Promise.all([writer("a").done, writer("b").done, reader.done]);
  const { min } = JSON.parse(out);
  assert.equal(min, PIDS.length, "a reader never saw a record missing or half-written mid-replace");
  assert.deepEqual(readdirSync(dir).sort(), PIDS.map((p) => `${p}.json`), "no .tmp left behind, nothing deleted");
  for (const rec of readHostRecords(dir)) assert.match(rec.nonce, /^[ab]-149$/, "each file holds one writer's last write");
});

test(
  "reap: GC does not delete a record a new host rewrote while the reaper probed (pid reused)",
  { todo: "known, not fixed: needs the pid reused by a new host within the milliseconds between probe and unlink" },
  (t) => {
    const dir = freshDir(t);
    const old = { pid: 8100, pgid: 8100, version: "0.7.0", scriptHash: "old", startTime: "T-old", nonce: "old" };
    const fresh = { pid: 8100, pgid: 8100, ...EXPECTED, startTime: "T-new", nonce: "new" };
    writeHostRecord(old, dir);
    const { deps, killed } = fakeDeps(
      {},
      {
        // The old host is gone; its pid was reused by a new host, which publishes
        // its record while this reaper is probing the old one.
        readProcInfo: () => {
          writeHostRecord(fresh, dir);
          return liveAs("T-new");
        },
      },
    );
    const summary = reapStaleHostRecords(EXPECTED, SCRIPT, dir, deps);
    assert.deepEqual(killed, [], "the reused pid is never signalled");
    assert.deepEqual(summary.gc, [8100]);
    assert.deepEqual(readHostRecords(dir), [fresh], "the new host's record was deleted with the old one's");
  },
);

// --- reaper orchestration ------------------------------------------------------------

test("reap: the system-wide ps snapshot runs only when a kill happens, and once per pass", (t) => {
  const keep = { pid: 7000, pgid: 7000, ...EXPECTED, startTime: "T-keep", nonce: "k" };
  const dead = { pid: 7002, pgid: 7002, ...EXPECTED, startTime: "T-dead", nonce: "d" };
  const staleA = { pid: 7003, pgid: 7003, version: "0.7.0", scriptHash: "old", startTime: "T-a", nonce: "a" };
  const staleB = { pid: 7004, pgid: 7004, version: "0.7.0", scriptHash: "old", startTime: "T-b", nonce: "b" };
  const infos = { 7000: liveAs("T-keep"), 7003: liveAs("T-a"), 7004: liveAs("T-b") };

  const quiet = freshDir(t);
  writeHostRecord(keep, quiet);
  writeHostRecord(dead, quiet);
  const q = fakeDeps(infos);
  const qs = reapStaleHostRecords(EXPECTED, SCRIPT, quiet, q.deps);
  assert.deepEqual([qs.keptCompatible, qs.gc], [[7000], [7002]]);
  assert.equal(q.snapshots(), 0, "the keep/GC path pays no system-wide ps");

  const busy = freshDir(t);
  for (const r of [keep, staleA, staleB]) writeHostRecord(r, busy);
  const b = fakeDeps(infos);
  const bs = reapStaleHostRecords(EXPECTED, SCRIPT, busy, b.deps);
  assert.deepEqual(bs.reaped.sort((x, y) => x - y), [7003, 7004]);
  assert.deepEqual(b.killed.map(([pid]) => pid).sort((x, y) => x - y), [-7004, -7003]);
  assert.equal(b.snapshots(), 1, "two kills share one snapshot");
});

// --- the ps readers against the real ps (processes this file spawned) -------------

test("readProcInfo on a live child: alive, a UTC ctime start time stable across probes, its command", async (t) => {
  const before = Date.now();
  const host = await startFakeHost(t, { detached: false });
  const info = readProcInfo(host.pid);
  assert.equal(info.alive, true);
  assert.equal(info.probeFailed, false);
  assert.match(info.startTime, CTIME);
  // Pinned to UTC: read as UTC it is the spawn time (local-time rendering is hours off in CEST/CET).
  const startedAt = Date.parse(`${info.startTime} UTC`);
  assert.ok(Math.abs(startedAt - before) < 60_000, `start ${info.startTime} is not the spawn time in UTC`);
  assert.ok(info.command.includes(host.script), "the command names the script, the reaper's second check");
  assert.equal(readProcInfo(host.pid).startTime, info.startTime, "the authenticator is stable between probes");
});

test("readProcInfo on an exited child: dead, and not a probe failure", async () => {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((r) => child.on("exit", r));
  assert.deepEqual(readProcInfo(child.pid), { alive: false, probeFailed: false, startTime: null, command: null });
});

test("readProcInfo: a ps that cannot run is a probe failure, never a dead pid", (t) => {
  fakePs(t, () => {
    throw spawnError();
  });
  assert.deepEqual(readProcInfo(process.pid), { alive: true, probeFailed: true, startTime: null, command: null });
});

test("readProcInfo: empty ps needs kernel ESRCH, a padded day survives, ps runs under C + UTC", (t) => {
  const calls = [];
  let out = "";
  fakePs(t, (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts.env });
    return out;
  });
  out = "\n";
  const kill=process.kill;
  try{process.kill=(pid,signal)=>{assert.equal(pid,4242);assert.equal(signal,0);throw Object.assign(Error('fixture absent'),{code:'ESRCH'});};
    assert.deepEqual(readProcInfo(4242), { alive: false, probeFailed: false, startTime: null, command: null });
  }finally{process.kill=kill;}
  out = "Wed Jul  2 10:00:00 2026   /Apps/Aya /x/pty-host.js --a  b\n";
  assert.deepEqual(readProcInfo(4242), {
    alive: true,
    probeFailed: false,
    startTime: "Wed Jul  2 10:00:00 2026", // the double space is kept: it is what was recorded
    command: "/Apps/Aya /x/pty-host.js --a  b",
  });
  assert.deepEqual(calls[1].args, ["-p", "4242", "-o", "lstart=,command="]);
  assert.equal(calls[1].env.TZ, "UTC");
  assert.equal(calls[1].env.LC_ALL, "C");
});

test("listProcs: the real snapshot has this process under its parent and a spawned child under it", async (t) => {
  const host = await startFakeHost(t, { detached: false });
  const rows = listProcs();
  assert.ok(rows.some((r) => r.pid === process.pid && r.ppid === process.ppid));
  assert.ok(rows.some((r) => r.pid === host.pid && r.ppid === process.pid));
  assert.ok(rows.every((r) => Number.isInteger(r.pid) && Number.isInteger(r.ppid)));
});

test("listProcs: a failing ps -> [], and lines that are not two numbers are skipped", (t) => {
  let fail = true;
  fakePs(t, () => {
    if (fail) throw spawnError();
    return "  PID  PPID\n   10     1\nnot a row\n 20 10 \n30\n\n 40 20 extra\n";
  });
  assert.deepEqual(listProcs(), []);
  fail = false;
  assert.deepEqual(listProcs(), [
    { pid: 10, ppid: 1 },
    { pid: 20, ppid: 10 },
  ]);
});

test("ownStartTime: this process's ps start time, and empty when ps fails - then no record is written", (t) => {
  const st = ownStartTime();
  assert.match(st, CTIME);
  assert.equal(st, readProcInfo(process.pid).startTime);
  const dir = freshDir(t);
  fakePs(t, () => {
    throw spawnError();
  });
  assert.equal(ownStartTime(), "");
  writeHostRecord({ ...REC, pid: process.pid, pgid: process.pid, startTime: ownStartTime() }, dir);
  assert.deepEqual(readdirSync(dir), [], "an unverifiable host publishes no record");
});

test("ownPgid: a detached child leads its own group, a non-detached one does not", async () => {
  const code = `console.log(JSON.stringify({ pid: process.pid, pgid: reg.ownPgid() }));`;
  const leader = JSON.parse(await runNode(code, { detached: true }).done);
  assert.equal(leader.pgid, leader.pid, "detached: its own group, so the reaper's kill(-pgid) is its group");
  const member = JSON.parse(await runNode(code).done);
  assert.notEqual(member.pgid, member.pid, "not detached: it would not record itself");
  assert.equal(member.pgid, ownPgid(), "it shares this process's group");
});

test("ownPgid: ps failing, or printing nothing usable, -> null", (t) => {
  let out = null;
  fakePs(t, () => {
    if (out === null) throw spawnError();
    return out;
  });
  assert.equal(ownPgid(), null);
  for (const bad of ["", "abc", "0", "-3", "1.5"]) {
    out = bad;
    assert.equal(ownPgid(), null, `"${bad}"`);
  }
  out = "  4242\n";
  assert.equal(ownPgid(), 4242);
});

// --- reapStaleHostRecords with its DEFAULT deps and dir (real ps, real kill) -------

test("reap (default deps): a verified stale host's whole group is SIGKILLed and its record removed", async (t) => {
  rmSync(REG_DIR, { recursive: true, force: true });
  const host = await startFakeHost(t, { detached: true, grandchild: true });
  const startTime = readProcInfo(host.pid).startTime;
  writeHostRecord({ pid: host.pid, pgid: host.pid, version: "0.7.0", scriptHash: "old", startTime, nonce: "n" });
  assert.equal(readHostRecords().length, 1, "written to AYA_HOME/pty-hosts by default");
  const kills = guardKill(t, new Set([-host.pid]));

  const summary = reapStaleHostRecords(EXPECTED, host.script);

  assert.deepEqual(kills, [[-host.pid, "SIGKILL"]], "one group kill, nothing else");
  assert.deepEqual(summary.reaped, [host.pid]);
  assert.ok(summary.killedDescendants.includes(host.grandchild), "the snapshot saw the grandchild");
  await waitFor(() => host.state.exit);
  assert.equal(host.state.exit.signal, "SIGKILL");
  await waitFor(() => !readProcInfo(host.grandchild).alive);
  assert.deepEqual(readHostRecords(), []);
});

test("reap (default deps): a same-build host is kept, a record with a foreign start time is GC'd, nobody signalled", async (t) => {
  rmSync(REG_DIR, { recursive: true, force: true });
  const same = await startFakeHost(t);
  const reused = await startFakeHost(t);
  writeHostRecord({ pid: same.pid, pgid: same.pid, ...EXPECTED, startTime: readProcInfo(same.pid).startTime, nonce: "s" });
  // A stale record whose pid now runs a process started at another time: a reused pid.
  writeHostRecord({ pid: reused.pid, pgid: reused.pid, version: "0.7.0", scriptHash: "old", startTime: "Thu Jan  1 00:00:00 1970", nonce: "r" });
  const kills = guardKill(t, new Set());

  const summary = reapStaleHostRecords(EXPECTED, same.script);

  assert.deepEqual(kills, []);
  assert.deepEqual(summary.keptCompatible, [same.pid]);
  assert.deepEqual(summary.gc, [reused.pid]);
  assert.deepEqual(readHostRecords().map((r) => r.pid), [same.pid]);
  for (const h of [same, reused]) {
    assert.equal(h.state.exit, null, "still running");
    assert.equal(readProcInfo(h.pid).alive, true);
  }
});

for (const mode of ['empty','exit1','exit2','spawn-error']) test(`failed/empty ps (${mode}) cannot declare the still-live reader gone`, t => {
 fakePs(t,()=>{if(mode==='empty')return '';throw Object.assign(Error('injected ps failure'),mode==='spawn-error'?{code:'EAGAIN'}:{status:mode==='exit1'?1:2});});
 assert.deepEqual(readProcInfo(process.pid),{alive:true,probeFailed:true,startTime:null,command:null});
});
test('failed ps requires independent ESRCH; denied or undecidable kernel presence stays unknown',t=>{
 fakePs(t,()=>{throw Object.assign(Error('injected ps failure'),{status:1});});
 const kill=process.kill,calls=[];
 try {for(const code of ['ESRCH','EPERM','EAGAIN']){
  process.kill=(pid,signal)=>{calls.push([pid,signal]);throw Object.assign(Error('injected kernel result'),{code});};
  assert.deepEqual(readProcInfo(4242),{alive:code==='EPERM',probeFailed:code!=='ESRCH',startTime:null,command:null});
 }assert.deepEqual(calls,[[4242,0],[4242,0],[4242,0]]);}finally{process.kill=kill;}
});
