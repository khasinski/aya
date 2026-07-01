// Registry of detached PTY-host instances, used to reap STALE hosts (and their
// process trees) that a normal app restart intentionally leaves alive (#28).
//
// The reap kills processes, so every decision here is FAIL-CLOSED: we only ever
// signal a PID we are confident is the exact host a record describes. Any
// uncertainty (PID reuse, missing metadata, cmdline mismatch) -> skip the kill.
//
// Off-socket hosts can't be authenticated via the socket handshake, so the
// cross-check is: the process is still alive, its OS start time matches the one
// recorded at spawn (the classic stale-PID-file defense), and its command line
// still looks like our host script. All three must hold.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { AYA_HOME } from "./paths";

export interface HostRecord {
  /** Host process pid (also its process-group leader: spawned detached). */
  pid: number;
  /** Process-group id (== pid for a detached leader; recorded for tree kill). */
  pgid: number;
  version: string;
  scriptHash: string;
  /** OS-reported start time (`ps -o lstart`) captured at spawn. Opaque string,
   *  compared for exact equality to defend against PID reuse. */
  startTime: string;
  /** Random per-instance token (socket-handshake cross-check, future use). */
  nonce: string;
}

export interface ProcInfo {
  alive: boolean;
  /** `ps -o lstart` for the pid, or null if it could not be read. */
  startTime: string | null;
  /** `ps -o command` for the pid, or null. */
  command: string | null;
}

export const HOST_REGISTRY_DIR = path.join(AYA_HOME, "pty-hosts");

const recordPath = (dir: string, pid: number): string =>
  path.join(dir, `${pid}.json`);

/** Atomically write a host's record (tmp + rename). Best-effort. */
export function writeHostRecord(rec: HostRecord, dir: string = HOST_REGISTRY_DIR): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${recordPath(dir, rec.pid)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
    fs.renameSync(tmp, recordPath(dir, rec.pid));
  } catch {
    // best effort; a missing record just means this host won't be reaped by pid
  }
}

/** Read all valid host records in the registry (skips malformed files). */
export function readHostRecords(dir: string = HOST_REGISTRY_DIR): HostRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: HostRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as unknown;
      if (isHostRecord(rec)) out.push(rec);
    } catch {
      // skip malformed / partial writes
    }
  }
  return out;
}

/** Remove a host's record (on clean exit, or after a confirmed reap / GC). */
export function removeHostRecord(pid: number, dir: string = HOST_REGISTRY_DIR): void {
  try {
    fs.rmSync(recordPath(dir, pid), { force: true });
  } catch {
    // best effort
  }
}

function isHostRecord(v: unknown): v is HostRecord {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.pid === "number" &&
    typeof r.pgid === "number" &&
    typeof r.version === "string" &&
    typeof r.scriptHash === "string" &&
    typeof r.startTime === "string" &&
    typeof r.nonce === "string"
  );
}

/** Is the live pid the EXACT process we recorded? Alive, start time matches
 *  exactly (PID-reuse defense), and the command still runs a pty-host script.
 *  The start-time equality is the real authenticator; the command basename check
 *  (not full path - a stale host lives in an older/different bundle) only rejects
 *  a reused pid now running something unrelated. */
export function isSameRecordedProcess(
  rec: HostRecord,
  info: ProcInfo,
  hostScript: string,
): boolean {
  if (!info.alive) return false;
  if (!info.startTime || info.startTime !== rec.startTime) return false;
  const scriptName = hostScript.slice(hostScript.lastIndexOf("/") + 1) || hostScript;
  if (!info.command || !info.command.includes(scriptName)) return false;
  return true;
}

/** FAIL-CLOSED gate: may we SIGKILL (by process group) the host `rec` describes?
 *  Adds the kill-only guards on top of the identity check: never our own pid,
 *  never init/invalid, and the record MUST be a detached group leader (pgid ==
 *  pid) so kill(-pgid) targets exactly that host's own group and not some other
 *  group a corrupted/foreign record might name. */
export function isReapableHost(
  rec: HostRecord,
  info: ProcInfo,
  hostScript: string,
  selfPid: number,
): boolean {
  if (rec.pid === selfPid) return false; // never reap ourselves
  if (rec.pid <= 1) return false; // never signal init / invalid pids
  if (rec.pgid !== rec.pid) return false; // must be a detached leader (pgid==pid)
  return isSameRecordedProcess(rec, info, hostScript);
}

/** All descendant pids of `rootPid`, recursively, from a (pid,ppid) list.
 *  Cycle-safe. Excludes the root itself. */
export function collectDescendants(
  rootPid: number,
  procs: Array<{ pid: number; ppid: number }>,
): number[] {
  const childrenOf = new Map<number, number[]>();
  for (const p of procs) {
    const arr = childrenOf.get(p.ppid);
    if (arr) arr.push(p.pid);
    else childrenOf.set(p.ppid, [p.pid]);
  }
  const out: number[] = [];
  const seen = new Set<number>([rootPid]);
  const stack = [rootPid];
  while (stack.length) {
    const cur = stack.pop() as number;
    for (const child of childrenOf.get(cur) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      stack.push(child);
    }
  }
  return out;
}

// --- Impure OS probes (thin wrappers; injected in tests) ------------------

/** `ps` fields for one pid. Returns alive:false when the pid is gone. */
export function readProcInfo(pid: number): ProcInfo {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart=,command="], {
      encoding: "utf8",
      // Force C locale so `lstart` is the stable 24-char English ctime we slice
      // on below - a localized month/day name would shift the column and could
      // corrupt the start-time comparison the reuse guard depends on.
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    }).trim();
    if (!out) return { alive: false, startTime: null, command: null };
    // lstart is a fixed 24-char ctime string; the rest is the command.
    const lstart = out.slice(0, 24).trim();
    const command = out.slice(24).trim();
    return { alive: true, startTime: lstart, command };
  } catch {
    return { alive: false, startTime: null, command: null };
  }
}

/** Snapshot of (pid, ppid) for every process (for descendant enumeration). */
export function listProcs(): Array<{ pid: number; ppid: number }> {
  try {
    const out = execFileSync("ps", ["-Ao", "pid=,ppid="], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    const rows: Array<{ pid: number; ppid: number }> = [];
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]) });
    }
    return rows;
  } catch {
    return [];
  }
}

/** Own OS start time, recorded so a later reaper can verify identity. */
export function ownStartTime(): string {
  return readProcInfo(process.pid).startTime ?? "";
}

export interface ReapDeps {
  readProcInfo: (pid: number) => ProcInfo;
  listProcs: () => Array<{ pid: number; ppid: number }>;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  selfPid: number;
}

export interface ReapSummary {
  reaped: number[]; // host pids whose tree we force-killed
  killedDescendants: number[];
  keptCompatible: number[]; // records matching the expected identity (left alive)
  gc: number[]; // dead/unverifiable records removed without signaling
}

const defaultDeps = (): ReapDeps => ({
  readProcInfo,
  listProcs,
  kill: (pid, signal) => process.kill(pid, signal),
  selfPid: process.pid,
});

/** Reconcile the registry on launch: KEEP a recorded host whose identity matches
 *  what we would spawn (#28 - survive same-version restart); force-kill the whole
 *  process TREE of any STALE (version/scriptHash-mismatched) host we can verify
 *  by pid (fail-closed via isReapableHost); GC records whose process is gone or
 *  can't be verified (removed WITHOUT signaling - never a blind kill).
 *
 *  The kill targets the whole process GROUP (kill(-pgid)) of a just-verified,
 *  still-alive detached leader - atomic, and free of the enumerate-then-kill
 *  reuse race (a snapshotted child pid could be reused before we signal it).
 *  Known limits (accepted for now): a descendant that called setsid() escapes the
 *  group, and a leader that dies in the microseconds before the kill could let
 *  its pgid be reused. Deps are injectable so the decision + signalling are
 *  unit-testable without real processes. */
export function reapStaleHostRecords(
  expected: { version: string; scriptHash: string },
  hostScript: string,
  dir: string = HOST_REGISTRY_DIR,
  deps: ReapDeps = defaultDeps(),
): ReapSummary {
  const summary: ReapSummary = { reaped: [], killedDescendants: [], keptCompatible: [], gc: [] };
  const records = readHostRecords(dir);
  if (records.length === 0) return summary;

  const isCompatible = (r: HostRecord) =>
    r.version === expected.version && r.scriptHash === expected.scriptHash;

  const procs = deps.listProcs();
  for (const rec of records) {
    if (isCompatible(rec)) {
      // A same-build host: keep it (we'll connect to it) only if it's verifiably
      // the exact process we recorded; a dead OR reused pid gets GC'd (checking
      // start time, not just liveness, so a reused pid isn't mistaken for ours).
      const info = deps.readProcInfo(rec.pid);
      if (isSameRecordedProcess(rec, info, hostScript)) summary.keptCompatible.push(rec.pid);
      else {
        removeHostRecord(rec.pid, dir);
        summary.gc.push(rec.pid);
      }
      continue;
    }
    // Stale record. Only signal if we are CERTAIN this pid is that exact host.
    const info = deps.readProcInfo(rec.pid);
    if (!isReapableHost(rec, info, hostScript, deps.selfPid)) {
      removeHostRecord(rec.pid, dir);
      summary.gc.push(rec.pid);
      continue;
    }
    // Force-kill the whole process GROUP atomically. The host is a detached
    // session leader (spawned with detached:true => setsid), so pgid == pid and
    // every non-detached descendant is in its group. kill(-pgid) avoids the
    // enumerate-then-kill TOCTOU (a listed child pid could be reused before we
    // signal it); the group id is not reused while any member lives, and we just
    // verified the leader alive - so the group is unambiguously ours.
    const observed = collectDescendants(rec.pid, procs); // for the log only, never a kill target
    try {
      deps.kill(-rec.pgid, "SIGKILL");
    } catch {
      // group already gone
    }
    // Belt-and-suspenders: the leader itself (idempotent if the group kill got it).
    try {
      deps.kill(rec.pid, "SIGKILL");
    } catch {
      // already gone
    }
    summary.killedDescendants.push(...observed);
    removeHostRecord(rec.pid, dir);
    summary.reaped.push(rec.pid);
  }
  return summary;
}
