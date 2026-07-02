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
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { AYA_HOME } from "./paths";

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

export const HOST_REGISTRY_DIR = path.join(AYA_HOME, "pty-hosts");

// A .tmp older than this is a crash leftover, safe to sweep. Young .tmp files
// are spared: another host may be mid-write (writeFileSync -> renameSync).
const TMP_SWEEP_AGE_MS = 60_000;

const recordPath = (dir: string, pid: number): string =>
  path.join(dir, `${pid}.json`);

/** Atomically write a host's record (tmp + rename). Refuses a record without a
 *  start time - it could never be verified, so it would only ever be GC'd.
 *  Best-effort beyond that. */
export function writeHostRecord(rec: HostRecord, dir: string = HOST_REGISTRY_DIR): void {
  if (!rec.startTime) return;
  const tmp = `${recordPath(dir, rec.pid)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
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

/** Read all valid host records in the registry. Self-healing: unlinks files
 *  that fail parse/shape validation (writes are atomic, so a bad .json is a
 *  crash artifact, never a mid-write) and sweeps aged .tmp leftovers. */
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
    if (name.endsWith(".tmp")) {
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
  if (info.probeFailed) return false; // unknown state is never "same"
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

/** How a record compares to the identity THIS app would spawn.
 *  - "compatible": same version AND same known scriptHash -> keep (#28).
 *  - "stale": different version, or same version with two KNOWN, different
 *    hashes (a rebuild) -> reap.
 *  - "indeterminate": same version but either hash is the "unknown" sentinel
 *    (a failed read at record or launch time). Comparing sentinels would be
 *    catastrophic in both directions - "unknown"==="unknown" would trust a
 *    foreign build, and real-vs-"unknown" would SIGKILL a healthy same-build
 *    host - so we do NOTHING with such records this launch. */
export function classifyRecord(
  rec: Pick<HostRecord, "version" | "scriptHash">,
  expected: { version: string; scriptHash: string },
): "compatible" | "stale" | "indeterminate" {
  if (rec.version !== expected.version) return "stale";
  if (rec.scriptHash === "unknown" || expected.scriptHash === "unknown") {
    return "indeterminate";
  }
  return rec.scriptHash === expected.scriptHash ? "compatible" : "stale";
}

/** All descendant pids of `rootPid`, recursively, from a (pid,ppid) list.
 *  Cycle-safe. Excludes the root itself. Used only to LOG what a group kill
 *  covered - never as a kill target (a snapshotted pid could be reused). */
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
const PS_ENV = { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" };

/** `ps` fields for one pid. alive:false when ps ran and the pid is gone;
 *  probeFailed:true when ps itself could not run (fork pressure, sandbox) -
 *  callers must treat that as UNKNOWN, not as dead. */
export function readProcInfo(pid: number): ProcInfo {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart=,command="], {
      encoding: "utf8",
      env: PS_ENV,
    }).trim();
    if (!out) return { alive: false, probeFailed: false, startTime: null, command: null };
    // lstart is a fixed 24-char ctime string; the rest is the command.
    const lstart = out.slice(0, 24).trim();
    const command = out.slice(24).trim();
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

/** Own process-group id via the OS, or null when unreadable. The host records
 *  itself only when it truly is a group leader (pgid === pid) - the property
 *  the reaper's kill(-pgid) depends on - rather than assuming detached spawn. */
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

/** Reconcile the registry on launch: KEEP a recorded host whose identity matches
 *  what we would spawn (#28 - survive same-version restart); force-kill the whole
 *  process GROUP of any STALE (version/scriptHash-mismatched) host we can verify
 *  by pid (fail-closed via isReapableHost); GC records whose process is verifiably
 *  gone or reused (removed WITHOUT signaling - never a blind kill); SKIP records
 *  we cannot judge this launch (failed probe, "unknown" hash sentinel) so a live
 *  host never loses its record to a transient failure.
 *
 *  The kill targets the whole process GROUP (kill(-pgid)) of a just-verified,
 *  still-alive detached leader - atomic, and free of the enumerate-then-kill
 *  reuse race (a snapshotted child pid could be reused before we signal it).
 *  POSIX delivers a group signal to every member INCLUDING the leader, so there
 *  is deliberately no follow-up kill(pid) - that would be the one unverified
 *  signal in the file and would reopen the reuse window the group kill closes.
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
    const kind = classifyRecord(rec, expected);
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
