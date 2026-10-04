// Registry of detached PTY-host instances, used to reap STALE hosts (and their
// process trees) that a normal app restart intentionally leaves alive (#28).
//
// The reap kills processes, so every decision here is FAIL-CLOSED: we only ever
// signal a PID we are confident is the exact host a record describes. Any
// uncertainty (PID reuse, missing metadata, cmdline mismatch, a failed probe,
// an "unknown" identity hash) -> no kill. GC of a record additionally requires
// a SUCCESSFUL probe showing the pid gone/reused - a failed probe keeps the
// record so a live host never loses its only reapability pointer.
//
// Off-socket hosts can't be authenticated via the socket handshake, so the
// cross-check is: the process is still alive, its OS start time matches the one
// recorded at spawn (the classic stale-PID-file defense), and its command line
// still looks like our host script. All three must hold.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { atomicTempPath, TMP_SUFFIX } from "./atomic-write";
import { AYA_HOME, OWNER_ONLY_FILE_MODE } from "./paths";
import { classifyIdentity } from "./pty-host-staleness";

export interface HostRecord {
  /** Host process pid (also its process-group leader: spawned detached). */
  pid: number;
  /** Process-group id. Must equal pid (detached leader) or the record is never
   *  reaped; the host verifies this via the OS at write time. */
  pgid: number;
  version: string;
  scriptHash: string;
  /** OS-reported start time (`ps -o lstart`, pinned to UTC + C locale) captured
   *  at spawn. Opaque string, compared for exact equality to defend against PID
   *  reuse. Pinning TZ matters: lstart renders in the current zone, so a DST
   *  shift between record and probe would otherwise unverify every record. */
  startTime: string;
  /** Random per-instance token (socket-handshake cross-check, future use). */
  nonce: string;
}

export interface ProcInfo {
  alive: boolean;
  /** True when the probe itself failed (ps could not run) - the pid's state is
   *  UNKNOWN, which is different from "ps ran and the pid is gone". */
  probeFailed: boolean;
  /** `ps -o lstart` for the pid, or null if it could not be read. */
  startTime: string | null;
  /** `ps -o command` for the pid, or null. */
  command: string | null;
}

const HOST_REGISTRY_DIR = path.join(AYA_HOME, "pty-hosts");

// Fixed width of the `ps -o lstart=` ctime field (C locale + UTC pinned in
// PS_ENV below): "Wed Jul  2 10:00:00 2026" = 24 chars. The two slices in
// readProcInfo MUST use the same offset - one constant keeps them agreeing.
export const PS_LSTART_WIDTH = 24;

// A .tmp older than this is a crash leftover, safe to sweep. Young .tmp files
// are spared: another host may be mid-write (writeFileSync -> renameSync).
const TMP_SWEEP_AGE_MS = 60_000;

const recordPath = (dir: string, pid: number): string =>
  path.join(dir, `${pid}.json`);

/** Atomic (tmp + rename), best-effort. A record without a start time is refused: it could never be
 *  verified, only GC'd. */
export function writeHostRecord(rec: HostRecord, dir: string = HOST_REGISTRY_DIR): void {
  if (!rec.startTime) return;
  const tmp = atomicTempPath(recordPath(dir, rec.pid));
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(rec), { mode: OWNER_ONLY_FILE_MODE });
    fs.renameSync(tmp, recordPath(dir, rec.pid));
  } catch {
    // best effort; a missing record just means this host won't be reaped by pid
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // leave it - readHostRecords sweeps aged .tmp files
    }
  }
}

/** Valid records only: an unparsable .json is a crash artifact (writes are atomic) and is unlinked, as are
 *  aged .tmp leftovers. */
export function readHostRecords(dir: string = HOST_REGISTRY_DIR): HostRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: HostRecord[] = [];
  for (const name of names) {
    const full = path.join(dir, name);
    if (name.endsWith(TMP_SUFFIX)) {
      try {
        if (Date.now() - fs.statSync(full).mtimeMs > TMP_SWEEP_AGE_MS) {
          fs.rmSync(full, { force: true });
        }
      } catch {
        // best effort
      }
      continue;
    }
    if (!name.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(full, "utf8")) as unknown;
      if (isHostRecord(rec)) out.push(rec);
      else fs.rmSync(full, { force: true }); // wrong shape - non-actionable forever
    } catch {
      try {
        fs.rmSync(full, { force: true }); // unparseable - crash artifact
      } catch {
        // best effort
      }
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
    Number.isInteger(r.pid) &&
    r.pid > 1 &&
    typeof r.pgid === "number" &&
    Number.isInteger(r.pgid) &&
    typeof r.version === "string" &&
    typeof r.scriptHash === "string" &&
    typeof r.startTime === "string" &&
    typeof r.nonce === "string"
  );
}

/** The live pid is the EXACT recorded process: equal start time is the authenticator (PID reuse); the
 *  script basename check (an old bundle path differs) only rejects a reused pid running something else. */
function isSameRecordedProcess(
  rec: HostRecord,
  info: ProcInfo,
  hostScript: string,
): boolean {
  if (info.probeFailed) return false; // unknown state is never "same"
  if (!info.alive) return false;
  if (!info.startTime || info.startTime !== rec.startTime) return false;
  const scriptName = hostScript.slice(hostScript.lastIndexOf("/") + 1) || hostScript;
  if (!info.command || !info.command.includes(scriptName)) return false;
  return true;
}

/** FAIL-CLOSED gate for kill(-pgid): never our pid or init, and only a detached group leader (pgid ==
 *  pid), so a corrupted record cannot name another group. */
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

/** Every descendant pid of `rootPid` (cycle-safe, root excluded). Only for LOGGING what a group kill
 *  covered: a snapshotted pid could be reused, so never a kill target. */
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

// C locale + UTC keep `lstart` a stable, zone-independent 24-char ctime string.
// Without TZ pinning a DST transition between record and probe would shift the
// rendered hour and silently unverify every record (empirically confirmed:
// the same pid renders 08:52 under TZ=UTC and 10:52 under Europe/Warsaw).
export const PS_ENV = { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" };

/** `ps` fields for one pid: alive:false when ps ran and the pid is gone; probeFailed:true when ps could not
 *  run (fork pressure, sandbox), which callers treat as UNKNOWN, not dead. */
export function readProcInfo(pid: number): ProcInfo {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart=,command="], {
      encoding: "utf8",
      env: PS_ENV,
    }).trim();
    if (!out) return { alive: false, probeFailed: false, startTime: null, command: null };
    // lstart is a fixed 24-char ctime string; the rest is the command.
    const lstart = out.slice(0, PS_LSTART_WIDTH).trim();
    const command = out.slice(PS_LSTART_WIDTH).trim();
    return { alive: true, probeFailed: false, startTime: lstart, command };
  } catch (err) {
    // execFileSync throws BOTH when ps exits non-zero (pid does not exist -
    // status is a number) and when ps itself failed to run (spawn error -
    // status is null/undefined). Only the former proves the pid is gone.
    const status = (err as { status?: unknown }).status;
    if (typeof status === "number") {
      return { alive: false, probeFailed: false, startTime: null, command: null };
    }
    return { alive: false, probeFailed: true, startTime: null, command: null };
  }
}

/** Snapshot of (pid, ppid) for every process (descendant LOGGING only). */
export function listProcs(): Array<{ pid: number; ppid: number }> {
  try {
    const out = execFileSync("ps", ["-Ao", "pid=,ppid="], {
      encoding: "utf8",
      env: PS_ENV,
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

/** Own OS start time, recorded so a later reaper can verify identity. Empty
 *  string when the probe fails - writeHostRecord refuses such a record. */
export function ownStartTime(): string {
  return readProcInfo(process.pid).startTime ?? "";
}

/** Own process-group id from the OS, null when unreadable: the host records itself only as a real group
 *  leader, which the reaper's kill(-pgid) depends on. */
export function ownPgid(): number | null {
  try {
    const out = execFileSync("ps", ["-p", String(process.pid), "-o", "pgid="], {
      encoding: "utf8",
      env: PS_ENV,
    }).trim();
    const pgid = Number(out);
    return Number.isInteger(pgid) && pgid > 0 ? pgid : null;
  } catch {
    return null;
  }
}

export interface ReapDeps {
  readProcInfo: (pid: number) => ProcInfo;
  listProcs: () => Array<{ pid: number; ppid: number }>;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  selfPid: number;
}

export interface ReapSummary {
  reaped: number[]; // host pids whose group we force-killed
  killedDescendants: number[]; // pids observed in the killed groups (log only)
  keptCompatible: number[]; // records matching the expected identity (left alive)
  gc: number[]; // records whose pid is verifiably gone/reused (removed, no signal)
  skipped: number[]; // indeterminate identity or failed probe - left untouched
}

const defaultDeps = (): ReapDeps => ({
  readProcInfo,
  listProcs,
  kill: (pid, signal) => process.kill(pid, signal),
  selfPid: process.pid,
});

/** On launch: KEEP a matching host, kill the GROUP of a verified stale one (kill(-pgid) reaches the leader
 *  too, so no unverified kill(pid)), GC gone or reused pids unsignalled, SKIP what cannot be judged this launch.
 *  The stale host holding the socket (`socketHost`) is skipped: handleStaleHost asks before stopping its panes' work. */
export function reapStaleHostRecords(
  expected: { version: string; scriptHash: string },
  hostScript: string,
  dir: string = HOST_REGISTRY_DIR,
  deps: ReapDeps = defaultDeps(),
  socketHost?: number,
): ReapSummary {
  const summary: ReapSummary = {
    reaped: [],
    killedDescendants: [],
    keptCompatible: [],
    gc: [],
    skipped: [],
  };
  const records = readHostRecords(dir);
  if (records.length === 0) return summary;

  // Full-system snapshot only if a kill actually happens (log decoration is not
  // worth a per-launch system-wide ps on the common keep path).
  let procs: Array<{ pid: number; ppid: number }> | null = null;

  for (const rec of records) {
    const info = deps.readProcInfo(rec.pid);
    if (info.probeFailed) {
      // ps itself failed - the pid's state is unknown. Keep the record; a live
      // stale host must not lose its only reapability pointer to a transient
      // probe failure.
      summary.skipped.push(rec.pid);
      continue;
    }
    const kind = classifyIdentity(expected, rec);
    if (kind === "indeterminate") {
      // Identity can't be compared ("unknown" hash) so NEVER kill - but GC is
      // still safe when a successful probe shows the pid conclusively gone or
      // reused; otherwise dead unknown-hash records would accumulate forever.
      if (isSameRecordedProcess(rec, info, hostScript)) summary.skipped.push(rec.pid);
      else {
        removeHostRecord(rec.pid, dir);
        summary.gc.push(rec.pid);
      }
      continue;
    }
    if (kind === "compatible") {
      // A same-build host: keep it (we'll connect to it) only if it's verifiably
      // the exact process we recorded; a dead OR reused pid gets GC'd (checking
      // start time, not just liveness, so a reused pid isn't mistaken for ours).
      if (isSameRecordedProcess(rec, info, hostScript)) summary.keptCompatible.push(rec.pid);
      else {
        removeHostRecord(rec.pid, dir);
        summary.gc.push(rec.pid);
      }
      continue;
    }
    if (rec.pid === socketHost) {
      summary.skipped.push(rec.pid);
      continue;
    }
    // Stale record. Only signal if we are CERTAIN this pid is that exact host.
    if (!isReapableHost(rec, info, hostScript, deps.selfPid)) {
      removeHostRecord(rec.pid, dir);
      summary.gc.push(rec.pid);
      continue;
    }
    procs ??= deps.listProcs();
    const observed = collectDescendants(rec.pid, procs); // log only, never a kill target
    try {
      deps.kill(-rec.pgid, "SIGKILL");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") {
        // EPERM or an unexpected error: the group may still be ALIVE and we
        // failed to signal it. Removing the record now would strand a live
        // stale host with no reapability pointer - keep it for a retry.
        summary.skipped.push(rec.pid);
        continue;
      }
      // ESRCH: the group vanished between probe and kill - safe to fall
      // through and drop the record.
    }
    summary.killedDescendants.push(...observed);
    removeHostRecord(rec.pid, dir);
    summary.reaped.push(rec.pid);
  }
  return summary;
}
