import { promises as fs } from "node:fs";
import * as path from "node:path";
import { ownStartTime, readProcInfo } from "./pty-host-registry";

/** Runs each call once every earlier call with its key has settled, whether it failed or not. */
export function oneAtATime(): <T>(key: string, work: () => Promise<T>) => Promise<T> {
  const running = new Map<string, Promise<unknown>>();
  return async (key, work) => {
    const mine = (running.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
    running.set(key, mine);
    try {
      return await mine;
    } finally {
      if (running.get(key) === mine) running.delete(key);
    }
  };
}

/** A lock file is taken over when the process that wrote it is gone, or it is older than this. */
export const STALE_LOCK_MS = 10_000;
/** A held lock is tried again after LOCK_RETRY_MIN_MS plus up to LOCK_RETRY_JITTER_MS, so waiters do not retry in step. */
export const LOCK_RETRY_MIN_MS = 5;
export const LOCK_RETRY_JITTER_MS = 20;

let ownLockText: string | undefined;
/** `<pid> <OS start time>`: the start time tells this process from a later one given the same pid. */
const lockText = () => (ownLockText ??= [process.pid, ownStartTime()].filter(Boolean).join(" "));

/** Runs `work` while this process holds `lockFile`, so another process (Aya and Aya Dev) waits for it.
 *  A dir where the lock cannot be made is one `work` cannot write either: it runs and fails as it would. */
export async function withFileLock<T>(lockFile: string, work: () => Promise<T>): Promise<T> {
  // Outside the loop: mkdir under a file says EEXIST, which there would read as a lock held by another process.
  await fs.mkdir(path.dirname(lockFile), { recursive: true }).catch(() => {});
  // One ps per holder, not one per retry: the answer for a given lock text does not change.
  const reused = new Map<string, boolean>();
  for (;;) {
    try {
      await fs.writeFile(lockFile, lockText(), { flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return work();
    }
    if (await isStale(lockFile, reused)) await fs.rm(lockFile, { force: true });
    else await new Promise((r) => setTimeout(r, LOCK_RETRY_MIN_MS + Math.random() * LOCK_RETRY_JITTER_MS));
  }
  try {
    return await work();
  } finally {
    await fs.rm(lockFile, { force: true });
  }
}

async function isStale(lockFile: string, reused: Map<string, boolean>): Promise<boolean> {
  try {
    const [text, stat] = await Promise.all([fs.readFile(lockFile, "utf8"), fs.stat(lockFile)]);
    if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) return true;
    const [, pidText = "", startTime] = /^(\d*)(?: (.+))?$/.exec(text.trim()) ?? [];
    const pid = Number(pidText);
    if (!pidText || !Number.isInteger(pid) || pid <= 0) return false; // written but its pid not yet
    process.kill(pid, 0);
    if (!startTime) return false;
    if (!reused.has(text)) {
      const info = readProcInfo(pid);
      // A failed ps is no proof: the lock stays held until it goes or turns 10 s old.
      reused.set(text, !info.probeFailed && (!info.alive || (info.startTime !== null && info.startTime !== startTime)));
    }
    return reused.get(text)!;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}
