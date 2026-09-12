// Detecting a SILENTLY-FAILED macOS auto-update (#78).
//
// Squirrel.Mac / ShipIt installs the downloaded update in a SEPARATE process
// after Aya calls quitAndInstall() and quits. When that install fails (the
// observed case: the extracted bundle is missing, ShipIt gives up after "too
// many attempts" and relaunches the OLD bundle), nothing in-process ever sees
// an error - the app just comes back up on the old version, looking like a
// successful update. electron-updater's `error` event does not fire for it.
//
// We can't catch the failure where it happens, but we CAN detect it on the next
// launch: write a marker naming the version we asked ShipIt to install just
// before we quit, then on startup compare it to the version we actually came
// back as. Same version -> it worked; different -> it silently rolled back, and
// we surface that (instead of the user reinstalling the same update for days).

import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeFileAtomic } from "./atomic-write";
import { AYA_HOME } from "./paths";

/** Marker written right before quitAndInstall and cleared once reconciled. */
export const PENDING_UPDATE_FILE = path.join(AYA_HOME, "pending-update.json");

/** ShipIt's working/cache dir (macOS). A failed attempt can leave poisoned
 *  "attempt N" state here that the issue reports blocking later attempts; we
 *  clear it after a detected rollback so the next try starts fresh. */
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
  /** How many times we have quit with this version pending, counting this one.
   *  The marker only survives a launch that did NOT come back on the target
   *  version, so a count above 1 is itself evidence that an earlier attempt
   *  failed - which is what lets the grace window stay per-attempt without
   *  deferring the diagnosis forever. */
  attempts: number;
}

export type RelaunchDiagnosis = "none" | "applied" | "rolled-back";

/** The marker's schema, applied to whatever JSON.parse produced. Both readers
 *  (the async one and the sync quit-path one) go through here so the two can
 *  never validate the same file differently. */
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

/** How many attempts a marker represents. Normalization guarantees at least 1,
 *  so in production this only ever reads the field back - it is the one place
 *  that decides what a missing or nonsensical count means, rather than three
 *  call sites deciding it slightly differently. */
function attemptsOf(marker: Partial<PendingUpdate>): number {
  return typeof marker.attempts === "number" && marker.attempts >= 1
    ? marker.attempts
    : 1;
}

/** How soon after an install request a relaunch is still "too early to judge".
 *  ShipIt installs in a separate process AFTER we quit; if we are already back
 *  up on the old version within this window the install is most likely still
 *  running, not failed. Declaring a rollback there would be wrong twice over -
 *  a false warning, and a recursive wipe of ShipIt's cache underneath a live
 *  install. */
export const ROLLBACK_GRACE_MS = 90_000;

/** Attempts at which we stop extending the benefit of the doubt. The FIRST
 *  attempt gets its grace window; a second quit with the same version still
 *  pending means the first one demonstrably did not land, so a quick relaunch
 *  is no longer ambiguous. Without this the window would slide forever (every
 *  quit re-stamps it); with a frozen stamp instead, retries would get NO window
 *  at all and we would wipe ShipIt's cache under a live install. */
export const ROLLBACK_GRACE_MAX_ATTEMPTS = 1;

/** Pure: given the marker (or null), the version we actually launched as, and
 *  the current time, decide what happened. No marker -> a normal launch. Same
 *  version -> the update applied. Different version -> ShipIt rolled us back,
 *  unless this is the first attempt and it is so recent that the install
 *  cannot have finished yet. */
export function diagnoseRelaunch(
  pending: PendingUpdate | null,
  currentVersion: string,
  nowMs: number = Date.now(),
): RelaunchDiagnosis {
  if (!pending || !pending.targetVersion) return "none";
  if (pending.targetVersion === currentVersion) return "applied";
  // A repeat attempt is already proof the previous one failed - judge it now
  // rather than granting another window this marker would keep renewing.
  if (attemptsOf(pending) <= ROLLBACK_GRACE_MAX_ATTEMPTS) {
    // `requestedAt` is what makes the grace window possible; an unparsable or
    // absent stamp falls back to judging immediately, as before.
    const requestedAt = Date.parse(pending.requestedAt || "");
    const age = nowMs - requestedAt;
    // Bounded on BOTH sides: a negative age means the wall clock moved
    // backwards (NTP correction, dual-boot RTC, VM resume), and a one-sided
    // `age <` test would then suppress the diagnosis on every launch until the
    // clock caught up. A nonsensical age falls through to the judgement.
    if (!Number.isNaN(requestedAt) && age >= 0 && age < ROLLBACK_GRACE_MS) {
      return "none";
    }
  }
  return "rolled-back";
}

/** Whether a rollback is established firmly enough to justify the DESTRUCTIVE
 *  half of the response - recursively removing ShipIt's cache. The notice is
 *  cheap and truthful either way ("the update did not install"), but the wipe
 *  can land underneath a live install, so it waits for a repeat failure, which
 *  is also the only case the poisoned-cache theory is about. */
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

/** The marker to write for a new install request. Each attempt gets its OWN
 *  timestamp, so each gets its own grace window; the COUNT is what stops that
 *  window renewing indefinitely, because a marker only survives a launch that
 *  failed to bring us back on the target version. Exported for tests. */
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

/** The same marker, written synchronously, for the quit path.
 *
 *  On macOS this is NOT electron-updater's doing: MacUpdater extends AppUpdater,
 *  not BaseUpdater, so `autoInstallOnAppQuit` there only makes it hand the zip
 *  to Squirrel.Mac eagerly - it registers no quit handler. Squirrel applies the
 *  staged bundle when the app exits. On Windows/Linux BaseUpdater's real
 *  addQuitHandler does the install. Either way an ordinary quit can install,
 *  which is what the app's own "Restart Aya to install" notification asks for -
 *  and Electron's `before-quit` awaits nothing, so the async version would lose
 *  the race with app exit.
 *
 *  Best-effort: a marker we fail to write only costs us the diagnosis. */
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
    // best-effort; a quit-path install just stays undiagnosable, as before
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
