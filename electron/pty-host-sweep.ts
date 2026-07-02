// Phase-2 legacy sweep: clean up Aya processes the registry (pty-host-registry)
// structurally cannot reach - detached PTY hosts that PREDATE the registry (no
// record file), and orphaned terminal children whose host already died (the
// process group persists while members live, but a leader-based registry check
// can never authorize killing it).
//
// Like the registry reap, every kill decision is FAIL-CLOSED and re-verified by
// a fresh per-pid probe IMMEDIATELY before signaling:
//  - S1 (stray hosts): a process only qualifies when its command line contains
//    the highly specific "dist-electron/pty-host" script path, it runs as our
//    uid, it is a detached group leader (pgid == pid), its env's AYA scope
//    (AYA_HOME / AYA_DEV) matches OURS (so a prod app never kills a dev
//    workflow's host or an isolated E2E fixture host), and it is not the
//    current socket host / a registry-kept host / ourselves. Kill = one atomic
//    kill(-pid) of its own verified group.
//  - S2 (orphaned children): a process only qualifies when it belongs to a
//    process group whose LEADER IS GONE, runs as our uid, and its env carries
//    AYA_TERMINAL_ID= - the marker safeEnv stamps on every terminal child (and
//    its descendants inherit). The env probe doubles as the just-before-kill
//    re-verification (a reused pid shows a different env / group).
// Any probe failure, scope mismatch, or ambiguity -> skip, never kill.

import { execFileSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { AYA_HOME } from "./paths";

/** One row of the system process snapshot. */
export interface ProcRow {
  uid: number;
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
}

/** Fresh per-pid probe result: current group + command WITH environment (ps
 *  eww), or null when the probe failed / the pid is gone. */
export interface EnvProbe {
  pgid: number;
  /** `ps eww -o command=` output: argv followed by the process environment. */
  commandWithEnv: string;
}

/** Markers safeEnv puts in EVERY terminal child's environment (both, always).
 *  The leading space anchors each as a distinct entry in the `ps eww` dump;
 *  requiring both makes an accidental argv collision (a grep/editor with one
 *  of the strings in its arguments) implausible. */
const AYA_CHILD_MARKER = " AYA_TERMINAL_ID=";
const AYA_HOME_MARKER = " AYA_HOME=";
/** Env marker every PTY host carries: the client spawns it with
 *  ELECTRON_RUN_AS_NODE=1. An editor/grep/test-runner that merely mentions the
 *  host script path in its ARGUMENTS does not run as-node. */
const HOST_ENV_MARKER = " ELECTRON_RUN_AS_NODE=1";

/** Does this command line LOOK like a PTY host's argv? The host is spawned as
 *  exactly [execPath, hostScript], so the script path must be the SECOND
 *  whitespace token - a substring match anywhere in the arguments (an editor
 *  session, a grep, a test runner touching this very file) must never qualify.
 *  Exec paths containing spaces fail closed (that host just isn't swept). */
export function isHostArgv(command: string): boolean {
  const m = command.match(/^\S+\s+(\S+)/);
  return !!m && m[1].endsWith("dist-electron/pty-host.js");
}
// Per-pid env probes fork `ps` each - bound the orphan scan so a pathological
// process table can't stall startup. Anything past the cap is logged, not
// silently dropped (it gets another chance next launch).
export const MAX_ORPHAN_PROBES = 64;

/** The AYA "scope" (config home) a process runs under, parsed from its env
 *  dump: explicit AYA_HOME= wins; else AYA_DEV=1 implies ~/.aya-dev; else the
 *  default ~/.aya. Mirrors electron/paths.ts. Used so a sweep only ever kills
 *  hosts belonging to ITS OWN scope. */
export function scopeFromEnvDump(commandWithEnv: string, homedir: string): string {
  const m = commandWithEnv.match(/ AYA_HOME=([^ ]+)/);
  if (m) return path.resolve(m[1]);
  if (commandWithEnv.includes(" AYA_DEV=1")) return path.join(homedir, ".aya-dev");
  return path.join(homedir, ".aya");
}

/** Parse `ps -Axo uid=,pid=,ppid=,pgid=,command=` output. Malformed lines are
 *  dropped (fail-closed: an unparseable row can never become a kill target). */
export function parseSnapshot(psOutput: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of psOutput.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    rows.push({
      uid: Number(m[1]),
      pid: Number(m[2]),
      ppid: Number(m[3]),
      pgid: Number(m[4]),
      command: m[5].trim(),
    });
  }
  return rows;
}

/** S1 candidates: processes that LOOK like stray PTY hosts. Snapshot-level
 *  filter only - each candidate is re-verified by a fresh env probe (signature
 *  still present, scope matches) before any signal. */
export function selectStrayHostCandidates(
  rows: ProcRow[],
  opts: { uid: number; selfPid: number; excludePids: ReadonlySet<number> },
): ProcRow[] {
  return rows.filter(
    (r) =>
      // Snapshot command is pure argv (no `e` flag) - positional check is exact.
      isHostArgv(r.command) &&
      r.uid === opts.uid &&
      r.pid !== opts.selfPid &&
      r.pid > 1 &&
      !opts.excludePids.has(r.pid) &&
      // Only a detached leader can be group-killed as "its own" group; a
      // non-leader host (shouldn't exist) is skipped rather than guessed at.
      r.pgid === r.pid,
  );
}

/** S2 candidates: members of process groups whose leader no longer exists.
 *  Skips our own group, host-looking processes (S1 territory), foreign uids,
 *  and system groups. Each candidate still needs the AYA_TERMINAL_ID env
 *  marker (checked via the per-pid probe) before it can be killed. */
export function selectOrphanCandidates(
  rows: ProcRow[],
  opts: { uid: number; selfPid: number; selfPgid: number },
): ProcRow[] {
  const livePids = new Set(rows.map((r) => r.pid));
  return rows.filter(
    (r) =>
      r.uid === opts.uid &&
      r.pid !== opts.selfPid &&
      r.pid > 1 &&
      r.pgid > 1 &&
      r.pgid !== opts.selfPgid &&
      !livePids.has(r.pgid) && // group leader is GONE -> orphaned group
      !isHostArgv(r.command), // hosts are S1's job
  );
}

export interface SweepDeps {
  snapshot: () => ProcRow[];
  envProbe: (pid: number) => EnvProbe | null;
  /** Fresh, direct leader-liveness check: true = leader CONFIRMED gone (ps ran
   *  and found no such pid), false = leader alive, null = probe failed
   *  (unknown). S2 kills only on a confirmed-gone leader - the snapshot alone
   *  could have silently dropped a LIVE host's row (parse hiccup, truncation)
   *  and its children must never be mistaken for orphans. */
  leaderGone: (pgid: number) => boolean | null;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  uid: number;
  selfPid: number;
  selfPgid: number;
  ayaHome: string;
  homedir: string;
}

export interface SweepSummary {
  sweptHosts: number[]; // stray host leaders whose groups were killed
  sweptOrphans: number[]; // dead-leader-group members killed individually
  skipped: number[]; // candidates left alone (probe failed / scope or marker mismatch)
  truncated: number; // orphan candidates beyond the probe cap (retried next launch)
}

const defaultDeps = (): SweepDeps => ({
  snapshot: readSnapshot,
  envProbe: readEnvProbe,
  leaderGone: readLeaderGone,
  kill: (pid, signal) => process.kill(pid, signal),
  uid: process.getuid?.() ?? -1,
  selfPid: process.pid,
  selfPgid: (() => {
    try {
      return readEnvProbe(process.pid)?.pgid ?? -1;
    } catch {
      return -1;
    }
  })(),
  ayaHome: AYA_HOME,
  homedir: os.homedir(),
});

/** Run the legacy sweep. Both passes re-verify every candidate with a fresh
 *  per-pid probe right before signaling; anything ambiguous is skipped. The
 *  stray-host pass can be disabled (passes.strayHosts=false) when the caller
 *  cannot positively identify the CURRENT socket host to exclude it - killing
 *  hosts without that exclusion would risk sweeping the live one. */
export function sweepLegacyAyaProcesses(
  excludePids: ReadonlySet<number>,
  deps: SweepDeps = defaultDeps(),
  passes: { strayHosts: boolean } = { strayHosts: true },
): SweepSummary {
  const summary: SweepSummary = { sweptHosts: [], sweptOrphans: [], skipped: [], truncated: 0 };
  if (deps.uid < 0) return summary; // no uid (should not happen on mac/linux) -> do nothing
  const rows = deps.snapshot();
  if (rows.length === 0) return summary;

  // --- S1: stray PTY hosts (no registry record needed) ---
  const strayCandidates = passes.strayHosts
    ? selectStrayHostCandidates(rows, {
        uid: deps.uid,
        selfPid: deps.selfPid,
        excludePids,
      })
    : [];
  for (const cand of strayCandidates) {
    const probe = deps.envProbe(cand.pid);
    if (
      !probe ||
      probe.pgid !== cand.pid || // no longer (or never was) its own leader
      !isHostArgv(probe.commandWithEnv) || // pid reused / not a host's argv shape
      !probe.commandWithEnv.includes(HOST_ENV_MARKER) || // every real host runs as-node
      scopeFromEnvDump(probe.commandWithEnv, deps.homedir) !== deps.ayaHome // other workflow's host
    ) {
      summary.skipped.push(cand.pid);
      continue;
    }
    try {
      deps.kill(-cand.pid, "SIGKILL"); // atomic: the verified leader's own group
      summary.sweptHosts.push(cand.pid);
    } catch {
      summary.skipped.push(cand.pid); // vanished or not permitted - leave it
    }
  }

  // --- S2: orphaned terminal children in dead-leader groups ---
  const orphans = selectOrphanCandidates(rows, {
    uid: deps.uid,
    selfPid: deps.selfPid,
    selfPgid: deps.selfPgid,
  });
  const bounded = orphans.slice(0, MAX_ORPHAN_PROBES);
  summary.truncated = orphans.length - bounded.length;
  // A snapshot that silently dropped a LIVE host's row (parse hiccup) would
  // make its children look orphaned - so leader absence must be re-confirmed
  // by a direct probe before ANY member of that group is killed. Cache per
  // group: one extra ps per dead group, not per member.
  const leaderGoneCache = new Map<number, boolean | null>();
  for (const cand of bounded) {
    let gone = leaderGoneCache.get(cand.pgid);
    if (gone === undefined) {
      gone = deps.leaderGone(cand.pgid);
      leaderGoneCache.set(cand.pgid, gone);
    }
    if (gone !== true) {
      // Leader alive (snapshot lied) or probe failed -> these are NOT orphans.
      summary.skipped.push(cand.pid);
      continue;
    }
    const probe = deps.envProbe(cand.pid);
    if (
      !probe ||
      probe.pgid !== cand.pgid || // moved groups since the snapshot (pid reuse)
      !probe.commandWithEnv.includes(AYA_CHILD_MARKER) || // not an Aya terminal descendant
      !probe.commandWithEnv.includes(AYA_HOME_MARKER) // safeEnv always sets BOTH markers
    ) {
      summary.skipped.push(cand.pid);
      continue;
    }
    try {
      deps.kill(cand.pid, "SIGKILL");
      summary.sweptOrphans.push(cand.pid);
    } catch {
      summary.skipped.push(cand.pid);
    }
  }
  return summary;
}

// --- Impure OS probes (injected in tests) ----------------------------------

const PS_ENV = { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" };

/** Full system snapshot: uid, pid, ppid, pgid, command per process. */
export function readSnapshot(): ProcRow[] {
  try {
    const out = execFileSync("ps", ["-Axo", "uid=,pid=,ppid=,pgid=,command="], {
      encoding: "utf8",
      env: PS_ENV,
      maxBuffer: 16 * 1024 * 1024,
    });
    return parseSnapshot(out);
  } catch {
    return [];
  }
}

/** Direct leader-liveness probe. true = ps ran and CONFIRMED the pid gone
 *  (non-zero exit with a numeric status), false = pid alive, null = the probe
 *  itself failed (spawn error) - state unknown, callers must skip. */
export function readLeaderGone(pid: number): boolean | null {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "pid="], {
      encoding: "utf8",
      env: PS_ENV,
    }).trim();
    return out ? false : true;
  } catch (err) {
    const status = (err as { status?: unknown }).status;
    return typeof status === "number" ? true : null;
  }
}

/** Per-pid probe: current pgid + command INCLUDING the environment (`ps eww`).
 *  Null when the pid is gone or ps failed - callers must skip, never kill. */
export function readEnvProbe(pid: number): EnvProbe | null {
  try {
    const out = execFileSync("ps", ["eww", "-p", String(pid), "-o", "pgid=,command="], {
      encoding: "utf8",
      env: PS_ENV,
      maxBuffer: 4 * 1024 * 1024,
    }).trim();
    const m = out.match(/^\s*(\d+)\s+(.+)$/s);
    if (!m) return null;
    return { pgid: Number(m[1]), commandWithEnv: m[2] };
  } catch {
    return null;
  }
}
