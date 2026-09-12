// Detecting a SILENTLY-FAILED macOS auto-update (#78). ShipIt installs in a
// SEPARATE process after we quit, and a failure there fires no electron-updater
// `error` - so we mark the target version before quitting and compare on launch.

import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeFileAtomic } from "./atomic-write";
import { AYA_HOME } from "./paths";

/** Marker written right before quitAndInstall and cleared once reconciled. */
export const PENDING_UPDATE_FILE = path.join(AYA_HOME, "pending-update.json");

/** ShipIt's cache dir (macOS). Wiping it after a rollback is a SUSPECTED fix:
 *  the blocking "attempt N" state is reported upstream, not reproduced here. */
export const SHIPIT_CACHE_DIR = path.join(
  os.homedir(),
  "Library",
  "Caches",
  "com.aya.app.ShipIt",
);

export interface PendingUpdate {
  /** The version we asked ShipIt to install. */
  targetVersion: string;
  /** When THIS attempt was requested (ISO). Anchors the grace window below. */
  requestedAt: string;
  /** Quits with this version pending, counting this one. The marker only
   *  survives a failed launch, so >1 is evidence an earlier attempt failed. */
  attempts: number;
}

export type RelaunchDiagnosis = "none" | "applied" | "rolled-back";

/** The marker's schema. Both readers go through here so they cannot diverge. */
function normalizePendingUpdate(parsed: unknown): PendingUpdate | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const raw = parsed as Partial<PendingUpdate>;
  if (typeof raw.targetVersion !== "string") return null;
  return {
    targetVersion: raw.targetVersion,
    requestedAt: typeof raw.requestedAt === "string" ? raw.requestedAt : "",
    // A marker written before attempts existed reads as the first attempt.
    attempts: attemptsOf(raw),
  };
}

/** How many attempts a marker represents; the one place a missing or
 *  nonsensical count is interpreted (as 1). */
function attemptsOf(marker: Partial<PendingUpdate>): number {
  return typeof marker.attempts === "number" && marker.attempts >= 1
    ? marker.attempts
    : 1;
}

/** Too early to judge: a relaunch within 90 s most likely means ShipIt's
 *  separate install process is still running, not that it failed. */
export const ROLLBACK_GRACE_MS = 90_000;

/** Only the FIRST attempt gets the grace window - a second quit with the same
 *  version pending is proof the first did not land. */
export const ROLLBACK_GRACE_MAX_ATTEMPTS = 1;

/** Pure: no marker -> normal launch, same version -> applied, otherwise
 *  rolled-back unless it is a first attempt still inside the grace window. */
export function diagnoseRelaunch(
  pending: PendingUpdate | null,
  currentVersion: string,
  nowMs: number = Date.now(),
): RelaunchDiagnosis {
  if (!pending || !pending.targetVersion) return "none";
  if (pending.targetVersion === currentVersion) return "applied";
  if (attemptsOf(pending) <= ROLLBACK_GRACE_MAX_ATTEMPTS) {
    const requestedAt = Date.parse(pending.requestedAt || "");
    const age = nowMs - requestedAt;
    // Bounded on BOTH sides: a backwards wall clock (NTP, RTC, VM resume) would
    // otherwise suppress the diagnosis on every launch until it caught up.
    if (!Number.isNaN(requestedAt) && age >= 0 && age < ROLLBACK_GRACE_MS) {
      return "none";
    }
  }
  return "rolled-back";
}

/** Gate on the DESTRUCTIVE half (wiping ShipIt's cache): it waits for a repeat
 *  failure, because a wipe can land underneath a live install. */
export function shouldCleanShipItCache(pending: PendingUpdate | null): boolean {
  if (!pending) return false;
  return attemptsOf(pending) > ROLLBACK_GRACE_MAX_ATTEMPTS;
}

/** Read + validate the marker; any missing/corrupt marker reads as "none". */
export async function readPendingUpdate(): Promise<PendingUpdate | null> {
  try {
    const raw = await fs.readFile(PENDING_UPDATE_FILE, "utf8");
    return normalizePendingUpdate(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** The marker for a new install request: fresh timestamp per attempt, with the
 *  count stopping the grace window from renewing forever. Exported for tests. */
export function nextAttempt(
  targetVersion: string,
  prior: PendingUpdate | null,
  nowIso: string = new Date().toISOString(),
): PendingUpdate {
  const repeat =
    prior && prior.targetVersion === targetVersion ? attemptsOf(prior) : 0;
  return { targetVersion, requestedAt: nowIso, attempts: repeat + 1 };
}

export async function markPendingUpdate(targetVersion: string): Promise<void> {
  await fs.mkdir(path.dirname(PENDING_UPDATE_FILE), { recursive: true });
  const marker = nextAttempt(targetVersion, await readPendingUpdate());
  await writeFileAtomic(PENDING_UPDATE_FILE, JSON.stringify(marker) + "\n");
}

/** Sync marker for the quit path (`before-quit` awaits nothing). On macOS
 *  electron-updater registers NO quit handler: Squirrel applies on exit. */
export function markPendingUpdateSync(targetVersion: string): void {
  try {
    fsSync.mkdirSync(path.dirname(PENDING_UPDATE_FILE), { recursive: true });
    let prior: PendingUpdate | null = null;
    try {
      prior = normalizePendingUpdate(
        JSON.parse(fsSync.readFileSync(PENDING_UPDATE_FILE, "utf8")),
      );
    } catch {
      // no usable prior marker; this is attempt one
    }
    const tmp = `${PENDING_UPDATE_FILE}.tmp`;
    fsSync.writeFileSync(
      tmp,
      JSON.stringify(nextAttempt(targetVersion, prior)) + "\n",
    );
    fsSync.renameSync(tmp, PENDING_UPDATE_FILE);
  } catch {
    // best-effort; a quit-path install just stays undiagnosable
  }
}

export async function clearPendingUpdate(): Promise<void> {
  await fs.rm(PENDING_UPDATE_FILE, { force: true });
}

/** Best-effort wipe of ShipIt's poisoned state after a failed attempt. */
export async function cleanShipItCache(): Promise<void> {
  if (process.platform !== "darwin") return;
  try {
    await fs.rm(SHIPIT_CACHE_DIR, { recursive: true, force: true });
  } catch {
    // best-effort; the next attempt just doesn't get a clean slate
  }
}
