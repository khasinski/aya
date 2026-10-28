// More of the legacy sweep: the parts tests/pty-host-sweep.test.mjs leaves out.
// A kill that throws (the process vanished, or is not ours to signal) is a
// skip, never a sweep, and the pass goes on; the three ps readers against the
// real ps on processes this file spawns itself (a live child, a dead pid, a
// dead-leader group whose members the sweep must tell apart by environment);
// the readers' fail-closed answers when ps fails or prints nothing usable; and
// the default deps, driven through a fake ps and a recording process.kill, so
// nothing outside this file is ever probed or signalled.
//
// AYA_HOME points at a temp dir before pty-host-sweep (and so paths.ts) loads.
// The fake ps patches execFileSync on the node:child_process module object,
// which the compiled CommonJS reads at every call; it is restored after each
// test. Waiting is by condition, never by a fixed sleep.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor } from "./helpers/wait-for.mjs";

const require = createRequire(import.meta.url);
const cp = require("node:child_process");
const realExecFileSync = cp.execFileSync;

const home = mkdtempSync(join(tmpdir(), "aya-pty-host-sweep-more-"));
process.env.AYA_HOME = home;

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
  readSnapshot,
  readSnapshotAsync,
  readEnvProbe,
  readLeaderGone,
  sweepLegacyAyaProcesses,
  PS_SNAPSHOT_MAX_BUFFER_BYTES,
  PS_ENV_PROBE_MAX_BUFFER_BYTES,
} = await import("../dist-electron/pty-host-sweep.js");

const HOST_CMD = "/opt/Aya/Aya /opt/Aya/app.asar/dist-electron/pty-host.js";
const HOST_ENV = `${HOST_CMD} ELECTRON_RUN_AS_NODE=1 AYA_HOME=${home} PATH=/bin`;
const ORPHAN_ENV = `claude AYA_TERMINAL_ID=t1 AYA_HOME=${home} PATH=/bin`;
const row = (o) => ({ uid: 501, ppid: 1, command: "/bin/zsh", ...o });

const injectedDeps = (over) => ({
  snapshot: () => [],
  envProbe: () => null,
  leaderGone: () => true,
  kill: () => assert.fail("unexpected kill"),
  uid: 501,
  selfPid: 1,
  selfPgid: 1,
  ayaHome: home,
  homedir: "/Users/u",
  ...over,
});

/** Run fn with execFileSync replaced by fake(file, args, opts); always restored. */
function withFakePs(fake, fn) {
  cp.execFileSync = fake;
  try {
    return fn();
  } finally {
    cp.execFileSync = realExecFileSync;
  }
}

/** A node child that idles until killed; resolves once it has a pid. */
function spawnIdle(args, opts) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ...args], {
    stdio: "ignore",
    ...opts,
  });
  started.add(child.pid);
  return child;
}

const exited = (child) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((r) => child.once("exit", r));

// --- a kill that throws ---------------------------------------------------

test("S1: a stray host whose group kill throws is skipped, not swept, and the next host is still swept", () => {
  const rows = [
    row({ pid: 900, pgid: 900, command: HOST_CMD }),
    row({ pid: 901, pgid: 901, command: HOST_CMD }),
  ];
  const attempts = [];
  const summary = sweepLegacyAyaProcesses(
    new Set(),
    injectedDeps({
      snapshot: () => rows,
      envProbe: (pid) => ({ pgid: pid, commandWithEnv: HOST_ENV }),
      kill: (pid) => {
        attempts.push(pid);
        if (pid === -900) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      },
    }),
  );
  assert.deepEqual(attempts, [-900, -901]);
  assert.deepEqual(summary.sweptHosts, [901]);
  assert.deepEqual(summary.skipped, [900]);
});

test("S2: an orphan whose kill throws is skipped, not swept, and the next orphan is still swept", () => {
  const rows = [row({ pid: 200, pgid: 7777 }), row({ pid: 201, pgid: 7777 })];
  const attempts = [];
  const summary = sweepLegacyAyaProcesses(
    new Set(),
    injectedDeps({
      snapshot: () => rows,
      envProbe: () => ({ pgid: 7777, commandWithEnv: ORPHAN_ENV }),
      kill: (pid, sig) => {
        assert.equal(sig, "SIGKILL");
        attempts.push(pid);
        if (pid === 200) throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      },
    }),
  );
  assert.deepEqual(attempts, [200, 201]);
  assert.deepEqual(summary.sweptOrphans, [201]);
  assert.deepEqual(summary.skipped, [200]);
});

// --- the readers against the real ps, on processes spawned here ------------

test("readSnapshot lists this process and a child it spawned, with uid, ppid and pgid", async (t) => {
  const child = spawnIdle(["aya-sweep-snapshot-mark"], { detached: true });
  t.after(() => killQuietly(child.pid));
  const rows = await waitFor(() => {
    const r = readSnapshot();
    return r.some((x) => x.pid === child.pid) ? r : null;
  });
  const self = rows.find((r) => r.pid === process.pid);
  assert.ok(self, "this process is in the table");
  assert.equal(self.uid, process.getuid());
  assert.equal(self.ppid, process.ppid);
  const kid = rows.find((r) => r.pid === child.pid);
  assert.equal(kid.uid, process.getuid());
  assert.equal(kid.ppid, process.pid);
  assert.equal(kid.pgid, child.pid, "a detached child leads its own group");
  assert.match(kid.command, /aya-sweep-snapshot-mark/);
  assert.doesNotMatch(kid.command, /AYA_SWEEP/, "the snapshot is argv only, no environment");
});

test("readEnvProbe returns a live child's group and its environment; a dead pid gives null", async () => {
  const child = spawnIdle([], {
    detached: true,
    env: { ...process.env, AYA_SWEEP_PROBE_MARK: "seen" },
  });
  const probe = await waitFor(() => readEnvProbe(child.pid));
  assert.equal(probe.pgid, child.pid);
  assert.ok(probe.commandWithEnv.startsWith(process.execPath), probe.commandWithEnv.slice(0, 200));
  assert.ok(probe.commandWithEnv.includes(" AYA_SWEEP_PROBE_MARK=seen"), "environment follows argv");

  child.kill("SIGKILL");
  await exited(child);
  assert.equal(readEnvProbe(child.pid), null);
});

test("readLeaderGone: false while the pid lives, true once ps confirms it is gone", async () => {
  const child = spawnIdle([], { detached: true });
  assert.equal(readLeaderGone(process.pid), false);
  assert.equal(readLeaderGone(child.pid), false);
  child.kill("SIGKILL");
  await exited(child);
  assert.equal(readLeaderGone(child.pid), true);
});

test("real ps end to end: in a dead-leader group only the member with both terminal markers is killed", async (t) => {
  // A detached leader starts two members in its own group: one with the
  // markers safeEnv stamps on terminal children, one without. The leader then
  // dies, so its group lives on with no leader.
  const leaderScript = `
    const { spawn } = require("node:child_process");
    const idle = ["-e", "setInterval(() => {}, 1000)"];
    const marked = spawn(process.execPath, idle, {
      stdio: "ignore",
      env: { ...process.env, AYA_TERMINAL_ID: "t1", AYA_HOME: ${JSON.stringify(home)} },
    });
    const plain = spawn(process.execPath, idle, { stdio: "ignore", env: { ...process.env } });
    process.stdout.write(marked.pid + " " + plain.pid + "\\n");
    setInterval(() => {}, 1000);
  `;
  const leaderEnv = { ...process.env };
  delete leaderEnv.AYA_TERMINAL_ID;
  delete leaderEnv.AYA_HOME;
  const leader = spawn(process.execPath, ["-e", leaderScript], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
    env: leaderEnv,
  });
  started.add(leader.pid);
  let out = "";
  leader.stdout.on("data", (d) => (out += d));
  await waitFor(() => out.includes("\n"), 10_000);
  const [marked, plain] = out.trim().split(" ").map(Number);
  started.add(marked);
  started.add(plain);
  t.after(() => [leader.pid, marked, plain].forEach(killQuietly));

  process.kill(leader.pid, "SIGKILL");
  await exited(leader);
  await waitFor(() => readLeaderGone(leader.pid) === true);

  const ours = new Set([marked, plain]);
  const self = readEnvProbe(process.pid);
  assert.ok(self, "this process can be probed");
  const killed = [];
  const summary = sweepLegacyAyaProcesses(new Set(), {
    // Only the two members are offered, so nothing else on the machine is probed.
    snapshot: () => readSnapshot().filter((r) => ours.has(r.pid)),
    envProbe: readEnvProbe,
    leaderGone: readLeaderGone,
    kill: (pid, sig) => {
      assert.ok(ours.has(pid), `refusing to signal ${pid}`);
      killed.push(pid);
      process.kill(pid, sig);
    },
    uid: process.getuid(),
    selfPid: process.pid,
    selfPgid: self.pgid,
    ayaHome: home,
    homedir: homedir(),
  });

  assert.deepEqual(killed, [marked]);
  assert.deepEqual(summary.sweptOrphans, [marked]);
  assert.deepEqual(summary.skipped, [plain]);
  assert.deepEqual(summary.sweptHosts, []);
  await waitFor(() => readEnvProbe(marked) === null, 10_000);
  assert.ok(readEnvProbe(plain), "the member without the markers is left running");
});

// --- the readers when ps fails or prints nothing usable --------------------

test("readSnapshotAsync returns the same table as readSnapshot without blocking", async () => {
  const sync = readSnapshot();
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  const rows = await readSnapshotAsync();
  clearInterval(timer);
  assert.ok(ticks > 0, "the event loop kept running while ps ran");
  assert.ok(rows.some((r) => r.pid === process.pid && r.uid === process.getuid()), "this process is in the table");
  assert.equal(new Set(rows.map((r) => r.pid)).has(sync.find((r) => r.pid === process.pid).pid), true);
});

test("readSnapshot asks ps for the whole table in the C locale with the large buffer, and a failing ps gives []", () => {
  const calls = [];
  const rows = withFakePs(
    (file, args, opts) => {
      calls.push({ file, args, opts });
      return "  501 4000 1 4000 /bin/zsh -l\n";
    },
    () => readSnapshot(),
  );
  assert.deepEqual(rows, [{ uid: 501, pid: 4000, ppid: 1, pgid: 4000, command: "/bin/zsh -l" }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "ps");
  assert.deepEqual(calls[0].args, ["-A", "-o", "uid=,pid=,ppid=,pgid=,command="]);
  assert.equal(calls[0].opts.env.LC_ALL, "C");
  assert.equal(calls[0].opts.maxBuffer, PS_SNAPSHOT_MAX_BUFFER_BYTES);

  const failed = withFakePs(
    () => {
      throw Object.assign(new Error("stdout maxBuffer length exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
    },
    () => readSnapshot(),
  );
  assert.deepEqual(failed, []);
});

test("readLeaderGone: failed/empty ps needs independent ESRCH and never treats a live leader as gone", () => {
  const kill=process.kill;let kernelError="EAGAIN";process.kill=(_pid,signal)=>{assert.equal(signal,0);if(kernelError)throw Object.assign(Error("injected presence"),{code:kernelError});return true;};
  try {
  const spawnError = Object.assign(new Error("spawnSync ps ENOENT"), { code: "ENOENT" });
  assert.equal(
    withFakePs(() => {
      throw spawnError;
    }, () => readLeaderGone(4321)),
    null,
  );
  kernelError="ESRCH";
  assert.equal(
    withFakePs(() => {
      throw Object.assign(new Error("Command failed: ps"), { status: 1 });
    }, () => readLeaderGone(4321)),
    true,
  );
  assert.equal(withFakePs(() => "  \n", () => readLeaderGone(4321)), true);
  let args;
  assert.equal(
    withFakePs((file, a) => {
      args = a;
      return " 4321\n";
    }, () => readLeaderGone(4321)),
    false,
  );
  assert.deepEqual(args, ["-p", "4321", "-o", "pid="]);
  for(kernelError of [null,"EPERM","EAGAIN"]){
   assert.equal(withFakePs(()=>"",()=>readLeaderGone(4321)),kernelError==="EAGAIN"?null:false);
   assert.equal(withFakePs(()=>{throw Object.assign(Error("ps failed"),{status:1});},()=>readLeaderGone(4321)),kernelError==="EAGAIN"?null:false);
  }
  }finally{process.kill=kill;}
});

test("readEnvProbe: output without a leading pgid, or a failing ps, is null; a multi-line environment is kept whole", () => {
  assert.equal(withFakePs(() => "", () => readEnvProbe(4321)), null);
  assert.equal(withFakePs(() => "zsh AYA_TERMINAL_ID=t1", () => readEnvProbe(4321)), null);
  assert.equal(
    withFakePs(() => {
      throw new Error("ps failed");
    }, () => readEnvProbe(4321)),
    null,
  );
  let call;
  const probe = withFakePs(
    (file, args, opts) => {
      call = { args, opts };
      return "  77 zsh A=1\nB=two lines AYA_TERMINAL_ID=t1\n";
    },
    () => readEnvProbe(4321),
  );
  assert.deepEqual(probe, { pgid: 77, commandWithEnv: "zsh A=1\nB=two lines AYA_TERMINAL_ID=t1" });
  assert.deepEqual(call.args, ["eww", "-p", "4321", "-o", "pgid=,command="]);
  assert.equal(call.opts.maxBuffer, PS_ENV_PROBE_MAX_BUFFER_BYTES);
});

// --- the default deps, on a fake ps and a recording process.kill ------------

test("default deps: uid from process.getuid, AYA_HOME scope, our own group from ps, kills through process.kill", () => {
  const uid = process.getuid();
  const selfPgid = 4242;
  const table = [
    `${uid} 9900 1 9900 ${HOST_CMD}`, // stray host in our scope - group-killed
    `${uid} 9910 1 9910 ${HOST_CMD}`, // stray host of another scope - skipped
    `${uid} 9920 1 7777 claude`, // orphan with both markers - killed
    `${uid} 9930 1 ${selfPgid} claude`, // in our own group - never a candidate
  ].join("\n");
  const env = {
    9900: `9900 ${HOST_ENV}`,
    9910: `9910 ${HOST_CMD} ELECTRON_RUN_AS_NODE=1 AYA_HOME=/elsewhere/.aya PATH=/bin`,
    9920: `7777 ${ORPHAN_ENV}`,
    [process.pid]: `${selfPgid} node test PATH=/bin`,
  };
  const psCalls = [];
  const fakePs = (file, args) => {
    psCalls.push(args.join(" "));
    if (args[0] === "-A") return table;
    if (args[0] === "eww") {
      const out = env[args[2]];
      if (out === undefined) throw Object.assign(new Error("no such pid"), { status: 1 });
      return out;
    }
    if (args[0] === "-p") throw Object.assign(new Error("no such pid"), { status: 1 }); // leader gone
    throw new Error(`unexpected ps ${args.join(" ")}`);
  };
  const realKill = process.kill;
  const signals = [];
  const kernelProbes=[];
  process.kill = (pid, sig) => {
    if(sig===0){kernelProbes.push(pid);assert.equal(pid,7777);throw Object.assign(Error("fixture leader gone"),{code:"ESRCH"});}
    signals.push([pid, sig]);
    return true;
  };
  let summary;
  try {
    summary = withFakePs(fakePs, () => sweepLegacyAyaProcesses(new Set()));
  } finally {
    process.kill = realKill;
  }
  assert.deepEqual(kernelProbes,[7777]);
  assert.deepEqual(signals, [
    [-9900, "SIGKILL"],
    [9920, "SIGKILL"],
  ]);
  assert.deepEqual(summary.sweptHosts, [9900]);
  assert.deepEqual(summary.sweptOrphans, [9920]);
  assert.deepEqual(summary.skipped, [9910]);
  assert.equal(psCalls[0], `eww -p ${process.pid} -o pgid=,command=`, "our own group is read first");
  assert.ok(!psCalls.some((c) => c.startsWith("eww -p 9930")), "a member of our own group is never probed");
});

test("default deps: without process.getuid (no uid) the sweep takes no snapshot and kills nothing", () => {
  const realGetuid = process.getuid;
  const psCalls = [];
  process.getuid = undefined;
  let summary;
  try {
    summary = withFakePs(
      (file, args) => {
        psCalls.push(args.join(" "));
        if (args[0] === "eww") return `${process.pid} node PATH=/bin`;
        throw new Error(`unexpected ps ${args.join(" ")}`);
      },
      () => sweepLegacyAyaProcesses(new Set()),
    );
  } finally {
    process.getuid = realGetuid;
  }
  assert.deepEqual(summary, { sweptHosts: [], sweptOrphans: [], skipped: [], truncated: 0 });
  assert.ok(!psCalls.some((c) => c.startsWith("-A ")), "no process table is read");
});

test("default deps: a self probe that fails does not stop the sweep", () => {
  const uid = process.getuid();
  const realKill = process.kill;
  const signals = [];
  const kernelProbes=[];
  process.kill = (pid, sig) => {
    if(sig===0){kernelProbes.push(pid);assert.equal(pid,7777);throw Object.assign(Error("fixture leader gone"),{code:"ESRCH"});}
    signals.push([pid, sig]);
    return true;
  };
  let summary;
  try {
    summary = withFakePs(
      (file, args) => {
        if (args[0] === "-A") return `${uid} 9920 1 7777 claude`;
        if (args[0] === "eww" && args[2] === "9920") return `7777 ${ORPHAN_ENV}`;
        throw Object.assign(new Error("ps failed"), { status: 1 }); // self probe and leader probe
      },
      () => sweepLegacyAyaProcesses(new Set()),
    );
  } finally {
    process.kill = realKill;
  }
  assert.deepEqual(kernelProbes,[7777]);
  assert.deepEqual(signals, [[9920, "SIGKILL"]]);
  assert.deepEqual(summary.sweptOrphans, [9920]);
});
