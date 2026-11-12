import { constants, promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-write";
import { oneAtATime } from "./keyed-queue";
import { HOLD_BUSY } from "./pane-holds";
import { inputMayHaveBeenWritten } from "./pane-input-outcome";

export interface BoardNotice {
  id: string;
  projectSlug: string;
  cardId: string;
  paneId: string;
  paneName: string;
  title: string;
  reason: string;
  state: "pending" | "sending" | "typed";
}
const serial = oneAtATime();
const file = (home: string) => join(home, "board-notices.json");

/** The control path invokes this protection under its input lock, before paste and Enter. */
export function createBoardInputProtection<T>(automatic: boolean,
  holdReason: (id: string, pasted?: string) => Promise<string | null>,
  fallback: (id: string, pasted?: string, cancelled?: () => boolean) => Promise<T>) {
  return async (id: string, pasted?: string, cancelled?: () => boolean): Promise<T | string> => {
    if (automatic) {
      const hold = await holdReason(id, pasted);
      if (hold && hold !== HOLD_BUSY) return hold;
    }
    return fallback(id, pasted, cancelled);
  };
}

async function read(home: string): Promise<BoardNotice[]> {
  let handle;
  try {
    handle = await fs.open(file(home), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("Invalid board notification file.");
    const notices: unknown = JSON.parse(await handle.readFile("utf8"));
    if (!Array.isArray(notices) || !notices.every(n => n &&
      ["id", "projectSlug", "cardId", "paneId", "paneName", "title", "reason"].every(k => typeof n[k] === "string") &&
      ["pending", "sending", "typed"].includes(n.state))) throw new Error("Invalid board notifications.");
    return notices;
  } finally { await handle.close(); }
}

async function edit(home: string, change: (notices: BoardNotice[]) => BoardNotice[]): Promise<void> {
  await serial(home, async () => {
    const next = change(await read(home));
    if (next.length > 1000) throw new Error("Too many pending board notifications.");
    await writeFileAtomic(file(home), JSON.stringify(next), 0o600);
  });
}

export async function pendingBoardNotices(home: string, slug: string): Promise<BoardNotice[]> {
  return (await read(home)).filter(n => n.projectSlug === slug);
}

/** Display metadata must not turn a successful board write into an apparent failure. */
export async function displayBoardNotices(home: string, slug: string): Promise<BoardNotice[]> {
  try { return await pendingBoardNotices(home, slug); }
  catch (error) { console.warn("Cannot display board notifications:", error); return []; }
}

export async function acknowledgeBoardNotice(home: string, slug: string, id: string): Promise<void> {
  await edit(home, notices => notices.filter(n => n.projectSlug !== slug || n.id !== id));
}

export function createBoardNotices(deps: {
  home: string;
  currentOwner: (notice: BoardNotice) => Promise<string | undefined>;
  paneOpen: (notice: BoardNotice) => Promise<boolean>;
  paneHold?: (paneId: string) => Promise<string | null>;
  deliveryAllowed?: () => boolean;
  send: (notice: BoardNotice, text: string) => Promise<unknown>;
  changed: (slug: string) => void;
}) {
  let stopped = false;
  let flight: Promise<void> | undefined;
  const remove = async (notice: BoardNotice) => {
    await edit(deps.home, notices => notices.filter(n => n.id !== notice.id));
    deps.changed(notice.projectSlug);
  };
  const flush = (): Promise<void> => {
    if (flight) return flight;
    flight = (async () => {
      // Never hold the outbox lock while reading the board or waiting for a pane.
      for (const notice of await read(deps.home)) {
        if (stopped || deps.deliveryAllowed?.() === false) return;
        try {
        const open = await deps.paneOpen(notice);
        const hold = await deps.paneHold?.(notice.paneId);
        if (stopped || deps.deliveryAllowed?.() === false) return;
        if (!open) {
          await remove(notice);
          continue;
        }
        if (hold && hold !== HOLD_BUSY) continue;
        if (notice.state !== "pending") continue;
        // Only an untyped notice can be superseded. Text already in a composer
        // needs explicit acknowledgement even if the card is assigned again.
        if (await deps.currentOwner(notice) === notice.paneId) {
          await remove(notice);
          continue;
        }
        // A crash or a failed receipt write must never cause the same bytes to be pasted twice.
        await edit(deps.home, notices => notices.map(n => n.id === notice.id ? { ...n, state: "sending" } : n));
        try {
          await deps.send(notice,
            `Aya Board: task ${notice.cardId}: ${notice.title} was ${notice.reason}. Stop work on this task; do not continue it unless it is assigned to you again. Check aya board --json for the current board before choosing another task.`);
        } catch (error) {
          const state = inputMayHaveBeenWritten(error) ? "typed" : "pending";
          await edit(deps.home, notices => notices.map(n => n.id === notice.id ? { ...n, state } : n));
          deps.changed(notice.projectSlug);
          // Holds and temporary transport failures stay on disk for a later attempt.
          continue;
        }
        await remove(notice);
        } catch (error) { console.warn(`Board notification ${notice.cardId}:`, error); }
      }
    })().finally(() => { flight = undefined; });
    return flight;
  };
  const timer = setInterval(() => { void flush().catch(error => console.warn("Board notification retry:", error)); }, 1000);
  timer.unref();
  return {
    async enqueue(notice: Omit<BoardNotice, "id" | "state">) {
      await edit(deps.home, notices => [...notices, { ...notice, id: randomUUID(), state: "pending" }]);
    },
    flush,
    stop() { stopped = true; clearInterval(timer); },
  };
}
