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
  /** When install was requested (ISO). Kept for the log / future heuristics. */
  requestedAt: string;
}

export type RelaunchDiagnosis = "none" | "applied" | "rolled-back";

/** Pure: given the marker (or null) and the version we actually launched as,
 *  decide what happened. No marker -> a normal launch. Same version -> the
 *  update applied. Different version -> ShipIt rolled us back to the old one. */
export function diagnoseRelaunch(
  pending: PendingUpdate | null,
  currentVersion: string,
): RelaunchDiagnosis {
  if (!pending || !pending.targetVersion) return "none";
  return pending.targetVersion === currentVersion ? "applied" : "rolled-back";
}

/** Read + validate the marker; any missing/corrupt marker reads as "none". */
export async function readPendingUpdate(): Promise<PendingUpdate | null> {
  try {
    const raw = await fs.readFile(PENDING_UPDATE_FILE, "utf8");
    const obj = JSON.parse(raw) as unknown;
    if (
      typeof obj === "object" &&
      obj !== null &&
      typeof (obj as PendingUpdate).targetVersion === "string"
    ) {
      const p = obj as PendingUpdate;
      return {
        targetVersion: p.targetVersion,
        requestedAt:
          typeof p.requestedAt === "string" ? p.requestedAt : "",
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function markPendingUpdate(targetVersion: string): Promise<void> {
  await fs.mkdir(path.dirname(PENDING_UPDATE_FILE), { recursive: true });
  await writeFileAtomic(
    PENDING_UPDATE_FILE,
    JSON.stringify({ targetVersion, requestedAt: new Date().toISOString() }) +
      "\n",
  );
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
