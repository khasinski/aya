// The legacy sweep SIGKILLs processes it identifies as Aya leftovers, so every
// gate is fail-closed and pinned here: a regression that widens a filter or
// drops a probe re-verification risks killing an unrelated user process.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSnapshot,
  scopeFromEnvDump,
  isHostArgv,
  selectStrayHostCandidates,
  selectOrphanCandidates,
  sweepLegacyAyaProcesses,
  MAX_ORPHAN_PROBES,
} from "../dist-electron/pty-host-sweep.js";

const HOME = "/Users/u";
const AYA = "/Users/u/.aya";
const HOST_CMD =
  "/Applications/Aya.app/Contents/MacOS/Aya /Applications/Aya.app/Contents/Resources/app.asar/dist-electron/pty-host.js";
// A verified host's env dump: argv + as-node marker (client always sets it).
const HOST_ENV = `${HOST_CMD} ELECTRON_RUN_AS_NODE=1 PATH=/bin USER=u`;
// A verified orphan's env dump: argv + BOTH safeEnv markers.
const ORPHAN_ENV = `claude --chrome AYA_TERMINAL_ID=abc AYA_HOME=${AYA} PATH=/b`;

const row = (o) => ({ uid: 501, ppid: 1, command: "/bin/zsh", ...o });

const baseDeps = (over) => ({
  snapshot: () => [],
  envProbe: () => null,
  leaderGone: () => true,
  kill: () => assert.fail("unexpected kill"),
  uid: 501,
  selfPid: 1,
  selfPgid: 1,
  ayaHome: AYA,
  homedir: HOME,
  ...over,
});

// ---------- parseSnapshot ----------

test("parseSnapshot parses valid rows and drops malformed lines", () => {
  const out = parseSnapshot(
    [
      "  501 100 1 100 /bin/zsh -l",
      "501 200 100 100 sleep 30",
      "garbage line without numbers",
      "  0 300 1 300 /sbin/launchd",
      "",
    ].join("\n"),
  );
  assert.deepEqual(out, [
    { uid: 501, pid: 100, ppid: 1, pgid: 100, command: "/bin/zsh -l" },
    { uid: 501, pid: 200, ppid: 100, pgid: 100, command: "sleep 30" },
    { uid: 0, pid: 300, ppid: 1, pgid: 300, command: "/sbin/launchd" },
  ]);
});

// ---------- scopeFromEnvDump ----------

test("scopeFromEnvDump: explicit AYA_HOME wins, AYA_DEV maps to .aya-dev, default .aya", () => {
  assert.equal(scopeFromEnvDump("cmd AYA_HOME=/tmp/x PATH=/bin", HOME), "/tmp/x");
  assert.equal(scopeFromEnvDump("cmd AYA_DEV=1 PATH=/bin", HOME), `${HOME}/.aya-dev`);
  assert.equal(scopeFromEnvDump("cmd PATH=/bin", HOME), `${HOME}/.aya`);
});

// ---------- isHostArgv: positional, not substring ----------

test("isHostArgv: matches ONLY when the script is the second argv token", () => {
  assert.equal(isHostArgv(HOST_CMD), true);
  assert.equal(isHostArgv("/usr/bin/node /Users/u/proj/dist-electron/pty-host.js"), true);
  // The dangerous lookalikes a substring match would have group-killed:
  assert.equal(isHostArgv("vim electron/pty-host-sweep.ts dist-electron/pty-host.js"), false, "path in a LATER argument");
  assert.equal(isHostArgv("grep -r dist-electron/pty-host.js ."), false, "grep with a flag second");
  assert.equal(isHostArgv("rg dist-electron/pty-host ."), false, "prefix without .js");
  assert.equal(isHostArgv("/bin/zsh"), false, "no second token");
});

// ---------- S1 candidate selection ----------

test("selectStrayHostCandidates: positional signature + uid + leader + exclusions", () => {
  const rows = [
    row({ pid: 900, pgid: 900, command: HOST_CMD }), // stray host - candidate
    row({ pid: 901, pgid: 901, command: HOST_CMD, uid: 502 }), // other uid - no
    row({ pid: 902, pgid: 555, command: HOST_CMD }), // not a leader - no
    row({ pid: 903, pgid: 903, command: HOST_CMD }), // excluded (current) - no
    row({ pid: 904, pgid: 904, command: "grep -r dist-electron/pty-host.js ." }), // argv lookalike - no
    row({ pid: 905, pgid: 905, command: HOST_CMD }), // self - no
  ];
  const got = selectStrayHostCandidates(rows, {
    uid: 501,
    selfPid: 905,
    excludePids: new Set([903]),
  });
  assert.deepEqual(got.map((r) => r.pid), [900]);
});

// ---------- S2 candidate selection ----------

test("selectOrphanCandidates: only dead-leader groups, never our group or hosts", () => {
  const rows = [
    row({ pid: 100, pgid: 100 }), // live leader
    row({ pid: 101, pgid: 100 }), // child of LIVE leader - no (leader alive)
    row({ pid: 200, pgid: 7777 }), // leader 7777 gone - candidate
    row({ pid: 201, pgid: 7777, uid: 502 }), // foreign uid - no
    row({ pid: 202, pgid: 8888 }), // our own group - no
    row({ pid: 203, pgid: 7777, command: HOST_CMD }), // host-shaped - S1's job, no
    row({ pid: 204, pgid: 7777 }), // second orphan - candidate
  ];
  const got = selectOrphanCandidates(rows, { uid: 501, selfPid: 1000, selfPgid: 8888 });
  assert.deepEqual(got.map((r) => r.pid).sort((a, b) => a - b), [200, 204]);
});

// ---------- orchestration: S1 ----------

test("sweep S1: a verified stray host gets ONE group kill; scope mismatch and probe failure are skipped", () => {
  const rows = [
    row({ pid: 900, pgid: 900, command: HOST_CMD }), // ours - swept
    row({ pid: 910, pgid: 910, command: HOST_CMD }), // dev-scoped - skipped
    row({ pid: 920, pgid: 920, command: HOST_CMD }), // probe fails - skipped
  ];
  const killed = [];
  const summary = sweepLegacyAyaProcesses(
    new Set(),
    baseDeps({
      snapshot: () => rows,
      envProbe: (pid) => {
        if (pid === 900) return { pgid: 900, commandWithEnv: HOST_ENV };
        if (pid === 910)
          return { pgid: 910, commandWithEnv: `${HOST_CMD} ELECTRON_RUN_AS_NODE=1 AYA_DEV=1 PATH=/bin` };
        return null; // 920
      },
      kill: (pid, sig) => {
        assert.equal(sig, "SIGKILL");
        killed.push(pid);
      },
    }),
  );
  assert.deepEqual(killed, [-900], "one atomic group kill of the verified leader only");
  assert.deepEqual(summary.sweptHosts, [900]);
  assert.deepEqual(summary.skipped.sort((a, b) => a - b), [910, 920]);
});

test("sweep S1: a probe WITHOUT ELECTRON_RUN_AS_NODE=1 is skipped (editor/grep can't fake a host)", () => {
  const rows = [row({ pid: 900, pgid: 900, command: HOST_CMD })];
  const killed = [];
  const summary = sweepLegacyAyaProcesses(
    new Set(),
    baseDeps({
      snapshot: () => rows,
      // Argv shape matches but the as-node env marker every REAL host carries
      // is absent -> not a host.
      envProbe: () => ({ pgid: 900, commandWithEnv: `${HOST_CMD} PATH=/bin USER=u` }),
      kill: (pid) => killed.push(pid),
    }),
  );
  assert.deepEqual(killed, []);
  assert.deepEqual(summary.skipped, [900]);
});

test("sweep S1: a pid reused since the snapshot (argv no longer host-shaped) is skipped", () => {
  const rows = [row({ pid: 900, pgid: 900, command: HOST_CMD })];
  const killed = [];
  const summary = sweepLegacyAyaProcesses(
    new Set(),
    baseDeps({
      snapshot: () => rows,
      envProbe: () => ({ pgid: 900, commandWithEnv: "/usr/bin/vim notes.txt PATH=/bin" }),
      kill: (pid) => killed.push(pid),
    }),
  );
  assert.deepEqual(killed, []);
  assert.deepEqual(summary.skipped, [900]);
});

test("sweep S1 disabled (current host unidentifiable) never kills hosts; S2 still runs", () => {
  const rows = [
    row({ pid: 900, pgid: 900, command: HOST_CMD }), // would-be stray
    row({ pid: 200, pgid: 7777 }), // dead-leader orphan
  ];
  const killed = [];
  const summary = sweepLegacyAyaProcesses(
    new Set(),
    baseDeps({
      snapshot: () => rows,
      envProbe: (pid) =>
        pid === 200 ? { pgid: 7777, commandWithEnv: ORPHAN_ENV } : { pgid: 900, commandWithEnv: HOST_ENV },
      leaderGone: () => true,
      kill: (pid) => killed.push(pid),
    }),
    { strayHosts: false },
  );
  assert.deepEqual(summary.sweptHosts, [], "stray pass disabled");
  assert.deepEqual(summary.sweptOrphans, [200]);
  assert.deepEqual(killed, [200]);
});

// ---------- orchestration: S2 ----------

test("sweep S2: kills ONLY confirmed-dead-leader members carrying BOTH safeEnv markers", () => {
  const rows = [
    row({ pid: 200, pgid: 7777, command: "claude --chrome" }), // both markers - swept
    row({ pid: 201, pgid: 7777, command: "some-daemon" }), // no markers - skipped
    row({ pid: 202, pgid: 7777, command: "sleep 5" }), // moved group - skipped
    row({ pid: 205, pgid: 7777, command: "grep AYA_TERMINAL_ID= ." }), // one marker only (argv) - skipped
  ];
  const killed = [];
  const summary = sweepLegacyAyaProcesses(
    new Set(),
    baseDeps({
      snapshot: () => rows,
      leaderGone: (pgid) => {
        assert.equal(pgid, 7777);
        return true; // freshly confirmed gone
      },
      envProbe: (pid) => {
        if (pid === 200) return { pgid: 7777, commandWithEnv: ORPHAN_ENV };
        if (pid === 201) return { pgid: 7777, commandWithEnv: "some-daemon PATH=/b HOME=/u" };
        if (pid === 205)
          return { pgid: 7777, commandWithEnv: "grep AYA_TERMINAL_ID= . PATH=/b" }; // no AYA_HOME=
        return { pgid: 9999, commandWithEnv: ORPHAN_ENV }; // 202 moved
      },
      kill: (pid, sig) => {
        assert.equal(sig, "SIGKILL");
        killed.push(pid);
      },
    }),
  );
  assert.deepEqual(killed, [200], "dual-marker-verified orphan only");
  assert.deepEqual(summary.sweptOrphans, [200]);
  assert.deepEqual(summary.skipped.sort((a, b) => a - b), [201, 202, 205]);
});

test("sweep S2: a leader that is actually ALIVE (snapshot lied) blocks the whole group", () => {
  // The snapshot dropped the live host's row (parse hiccup) - its children look
  // orphaned. The direct leader probe must catch this and kill NOTHING.
  const rows = [row({ pid: 200, pgid: 7777, command: "claude --chrome" })];
  const killed = [];
  const summary = sweepLegacyAyaProcesses(
    new Set(),
    baseDeps({
      snapshot: () => rows,
      leaderGone: () => false, // direct probe: leader is alive!
      envProbe: () => assert.fail("must not even env-probe members of a live-leader group"),
      kill: (pid) => killed.push(pid),
    }),
  );
  assert.deepEqual(killed, [], "live-leader children are NEVER killed");
  assert.deepEqual(summary.skipped, [200]);
});

test("sweep S2: a failed leader probe (unknown state) blocks the group", () => {
  const rows = [row({ pid: 200, pgid: 7777, command: "claude --chrome" })];
  const killed = [];
  const summary = sweepLegacyAyaProcesses(
    new Set(),
    baseDeps({
      snapshot: () => rows,
      leaderGone: () => null, // probe failed - unknown
      envProbe: () => assert.fail("no env probe on unknown leader state"),
      kill: (pid) => killed.push(pid),
    }),
  );
  assert.deepEqual(killed, []);
  assert.deepEqual(summary.skipped, [200]);
});

test("sweep S2: the leader probe is cached per group (one ps per dead group, not per member)", () => {
  const rows = [
    row({ pid: 200, pgid: 7777, command: "a" }),
    row({ pid: 204, pgid: 7777, command: "b" }),
  ];
  let leaderProbes = 0;
  sweepLegacyAyaProcesses(
    new Set(),
    baseDeps({
      snapshot: () => rows,
      leaderGone: () => {
        leaderProbes += 1;
        return true;
      },
      envProbe: () => null, // all members skipped after that
      kill: () => assert.fail("nothing verifiable"),
    }),
  );
  assert.equal(leaderProbes, 1, "one leader probe per group");
});

test("sweep S2: the probe cap bounds work and reports truncation (no silent cap)", () => {
  const rows = [];
  for (let i = 0; i < MAX_ORPHAN_PROBES + 10; i++) {
    rows.push(row({ pid: 10_000 + i, pgid: 7777 }));
  }
  let envProbes = 0;
  const summary = sweepLegacyAyaProcesses(
    new Set(),
    baseDeps({
      snapshot: () => rows,
      leaderGone: () => true,
      envProbe: () => {
        envProbes += 1;
        return null; // all skipped - we only measure the bound
      },
      kill: () => assert.fail("nothing verifiable to kill"),
    }),
  );
  assert.equal(envProbes, MAX_ORPHAN_PROBES, "env-probe count is bounded");
  assert.equal(summary.truncated, 10, "overflow is reported, not silently dropped");
});

test("sweep: empty snapshot or missing uid is a total no-op", () => {
  assert.deepEqual(
    sweepLegacyAyaProcesses(new Set(), baseDeps({ snapshot: () => [] })).sweptHosts,
    [],
  );
  assert.deepEqual(
    sweepLegacyAyaProcesses(
      new Set(),
      baseDeps({ uid: -1, snapshot: () => assert.fail("uid gate first") }),
    ).sweptHosts,
    [],
  );
});