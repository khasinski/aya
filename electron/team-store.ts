// A team's per-machine state, kept out of the repo: pane ids exist on this
// machine only, and messages may hold secrets.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { atomicTempPath, writeFileAtomic } from "./atomic-write";
import { oneAtATime } from "./keyed-queue";
import { debugLog } from "./team-debug";
import { OWNER_ONLY_FILE_MODE } from "./paths";
import { ID_RE, TEAM_SYSTEM_SENDER, TEAM_USER_SENDER } from "./team-definition";
import { FRESH_PROGRESS, parseProgress, type TeamProgress } from "./team-progress";
import type { TeamMessage } from "./types";

export type { TeamMessage };

const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Names come over IPC: only a slug may become a path under ~/.aya/teams. */
export function teamDir(ayaHome: string, project: string, team: string): string {
  if (!PROJECT_RE.test(project) || project.includes("..")) throw new Error(`bad project slug "${project}"`);
  if (!ID_RE.test(team)) throw new Error(`bad team name "${team}"`);
  return path.join(ayaHome, "teams", project, team);
}

const TEAM_FILES = {
  assignments: "assignments.json",
  state: "state.json",
  saved: "saved.md",
  log: "log.jsonl",
  read: "read.json",
  typing: "typing.json",
  progress: "progress.json",
  deliveryNotes: "delivery-notes.json",
} as const;

// The log keeps its newest messages only; ids go on counting, so read marks and
// unread messages (always among the newest) are unaffected.
export const TEAM_LOG_MAX_ENTRIES = 2_000;
export const TEAM_LOG_KEEP_ENTRIES = 1_000;
// Every log operation reads this much of the end and no more: messages are capped, but 2,000 of them still add up.
export const TEAM_LOG_READ_BYTES = 2 * 1024 * 1024;
/** A trim keeps this much: half the read window, so the next trim is many messages away. */
export const TEAM_LOG_TRIM_BYTES = TEAM_LOG_READ_BYTES / 2;
export const DELIVERY_NOTES_KEEP = 500;

/** Why a logged message was not typed yet, or how it got to its receiver other than a plain paste: read with
 *  `aya team inbox`, or typed with its Enter withheld. */
export type DeliveryNote = { kind: "held"; reason: string } | { kind: "inbox" } | { kind: "withheld"; reason: string; afterEnter?: boolean };

const CRASHED_MID_TYPING: DeliveryNote = { kind: "withheld", reason: "Aya went down while typing it; it may be in the composer without its Enter, or not there at all - check the pane" };

/** Aya's own rounds and delivery tests go stale while held (a later one replaces them); anything else stays owed. */
export const goesStale = (m: Pick<TeamMessage, "from">): boolean => m.from === TEAM_SYSTEM_SENDER;

/** Not typed yet and past its receiver's read mark; owed unless it goesStale. */
const unreadIn = (read: Record<string, number>) => (m: TeamMessage): boolean => !m.delivered && m.id > (read[m.to] ?? 0);

/** A logged message as the window shows it, from its log entry, delivery note and the receiver's read mark: held,
 *  reserved, written (at once, later, via the inbox) or typed without its Enter; a refused one is never logged. */
function deliveryState(m: TeamMessage, note: DeliveryNote | undefined, readMark: number): TeamMessage {
  // Aya's own were marked read with the inbox, not printed: they stay held (stale).
  if (note?.kind === "inbox") return { ...m, viaInbox: true, ...(goesStale(m) ? {} : { delivered: true }) };
  if (note?.kind === "withheld") return { ...m, delivered: true, held: note.reason, typedOnly: true, ...(note.afterEnter ? { afterEnter: true } : {}) };
  // Taken for typing or typed later (the read mark passed it): it reached the pane.
  if (!m.delivered && !goesStale(m) && m.id <= readMark) return { ...m, delivered: true, ...(note?.kind === "held" ? { held: note.reason } : {}) };
  return note?.kind === "held" ? { ...m, held: note.reason } : m;
}

/** What a trim keeps within TEAM_LOG_TRIM_BYTES: messages still owed to their role first (a quiet role's must not be
 *  cut by the others' talk), then the newest TEAM_LOG_KEEP_ENTRIES of the rest; in log order. */
function keptByTrim(log: TeamMessage[], owed: (m: TeamMessage) => boolean): TeamMessage[] {
  const recent = new Set(log.slice(-TEAM_LOG_KEEP_ENTRIES));
  const kept = new Set<TeamMessage>();
  let bytes = 0;
  for (const pick of [owed, (m: TeamMessage) => recent.has(m)]) {
    for (let i = log.length - 1; i >= 0; i -= 1) {
      const m = log[i];
      if (kept.has(m) || !pick(m)) continue;
      bytes += JSON.stringify(m).length + 1;
      if (bytes > TEAM_LOG_TRIM_BYTES && kept.size > 0) break;
      kept.add(m);
    }
  }
  return log.filter((m) => kept.has(m));
}

type StateFile = { paused?: boolean; pausedBy?: unknown; started?: boolean; lastRound?: unknown; roundClockAt?: unknown; silenceRoundAt?: unknown; agentAuthored?: boolean; pendingTask?: unknown };

export interface PendingTask {
  to: string;
  text: string;
  /** Who gave it: the user, or the role whose pane ran aya team start; the user when absent. */
  from?: string;
  after?: number;
}

// One write queue per team directory, shared by every store opened on it.
const oneWriteAtATime = oneAtATime();
// Bumped by remove: a store opened before it writes nothing after, so a write in flight cannot recreate the team.
const removals = new Map<string, number>();
// Pauses set in this process, per team directory: a send that waited for a pane lock sees a Pause that came since.
const pauses = new Map<string, number>();
// Talk seen by this process, per team directory: a message logged by a role or the user, or progress moved by talk
// typed later. A silence round decided before it waited for the lead's pane is stale once this moves.
const talk = new Map<string, number>();
const bump = (counts: Map<string, number>, dir: string) => counts.set(dir, (counts.get(dir) ?? 0) + 1);
function changedSince(counts: Map<string, number>, dir: string): () => boolean {
  const seen = counts.get(dir) ?? 0;
  return () => (counts.get(dir) ?? 0) !== seen;
}
// A reservation in typing.json: the id once its paste began (or written by older code), `queued` while it waits for the pane.
type TypingMark = number | { queued: number };
const markId = (mark: TypingMark): number => (typeof mark === "number" ? mark : mark.queued);
// Typing reservations made by this process ("dir\0role"); one in typing.json that is not here was left by a crash.
const typingNow = new Set<string>();

export async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf-8");
  } catch {
    return null;
  }
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

export class TeamStore {
  private readonly removedSince: () => boolean;

  constructor(readonly dir: string) {
    this.removedSince = changedSince(removals, dir);
  }

  private file(name: string): string {
    return path.join(this.dir, name);
  }

  private readonly typingKey = (role: string): string => `${this.dir}\0${role}`;

  private serial<T>(work: () => Promise<T>, removing = false): Promise<T> {
    return oneWriteAtATime(this.dir, async () => {
      if (!removing && this.removedSince()) throw new Error("team was removed; nothing was written");
      return work();
    });
  }

  assignments(): Promise<Record<string, string>> {
    return readJson(this.file(TEAM_FILES.assignments), {});
  }

  /** One pane per role and one role per pane; taking one gives up the other. */
  assign(role: string, paneId: string): Promise<void> {
    return this.reassign(paneId, role);
  }

  releasePane(paneId: string): Promise<void> {
    return this.reassign(paneId);
  }

  private reassign(paneId: string, role?: string): Promise<void> {
    return this.serial(async () => {
      const next = Object.fromEntries(Object.entries(await this.assignments()).filter(([, p]) => p !== paneId));
      if (role) next[role] = paneId;
      await writeFileAtomic(this.file(TEAM_FILES.assignments), JSON.stringify(next, null, 2));
    });
  }

  async paneOf(role: string): Promise<string | null> {
    return (await this.assignments())[role] ?? null;
  }

  async roleOf(paneId: string): Promise<string | null> {
    const entry = Object.entries(await this.assignments()).find(([, p]) => p === paneId);
    return entry ? entry[0] : null;
  }

  private readState(): Promise<StateFile> {
    return readJson<StateFile>(this.file(TEAM_FILES.state), {});
  }

  private updateState(change: (state: StateFile) => StateFile): Promise<void> {
    return this.serial(async () => {
      await writeFileAtomic(this.file(TEAM_FILES.state), JSON.stringify(change(await this.readState())));
    });
  }

  /** A paused team takes no sends and no rounds. Unpausing marks it started. `by` (the user, or the lead's
   *  role) is kept with the pause: the user's Pause makes any pause the user's, a lead's never takes the user's over. */
  setPaused(paused: boolean, by: string = TEAM_USER_SENDER): Promise<void> {
    if (paused) bump(pauses, this.dir);
    debugLog(this, paused ? "pause" : "unpause", { by, token: pauses.get(this.dir) ?? 0 });
    return this.updateState(({ pausedBy, ...state }) => {
      const kept = state.paused === true && by !== TEAM_USER_SENDER ? (typeof pausedBy === "string" ? pausedBy : TEAM_USER_SENDER) : by;
      return { ...state, paused, started: state.started === true || !paused, ...(paused ? { pausedBy: kept } : {}) };
    });
  }

  /** True once this process saw the team talk (see `talk`) after this call. */
  talkedSince(): () => boolean {
    return changedSince(talk, this.dir);
  }

  /** True once a Pause was set on the team after this call: what is still being typed stops, as a send and a round do. */
  pausedSince(): () => boolean {
    return changedSince(pauses, this.dir);
  }

  /** Who paused the team: "user" or a role; null when it is not paused. A pause from before this was kept is the user's. */
  async pausedBy(): Promise<string | null> {
    const { paused, pausedBy } = await this.readState();
    if (paused !== true) return null;
    return typeof pausedBy === "string" && pausedBy ? pausedBy : TEAM_USER_SENDER;
  }

  /** running: started with Start team and not paused since. */
  async state(): Promise<{ paused: boolean; running: boolean }> {
    const state = await this.readState();
    return { paused: state.paused === true, running: state.started === true && state.paused !== true };
  }

  /** Saved by an agent from a pane (aya team save): the agent proposes its panes. */
  markAgentAuthored(): Promise<void> {
    return this.updateState((state) => ({ ...state, agentAuthored: true }));
  }

  /** Once a role has a pane or the user saved the team, it is no longer only the
   *  agent's proposal: a team left with no panes later gets the assign prompt again. */
  async clearAgentAuthored(): Promise<void> {
    if (!(await this.agentAuthored())) return;
    await this.updateState(({ agentAuthored: _, ...rest }) => rest);
  }

  async agentAuthored(): Promise<boolean> {
    return (await this.readState()).agentAuthored === true;
  }

  /** The task given with Start, until it is logged: Aya going down in between does not lose it. `after`: the last log id then. */
  setPendingTask(task: PendingTask | null): Promise<void> {
    return this.updateState(({ pendingTask: _, ...rest }) => (task ? { ...rest, pendingTask: task } : rest));
  }

  async pendingTask(): Promise<PendingTask | null> {
    const { pendingTask } = await this.readState();
    const task = pendingTask as { to?: unknown; text?: unknown; from?: unknown; after?: unknown } | undefined;
    if (typeof task?.to !== "string" || typeof task.text !== "string") return null;
    return {
      to: task.to,
      text: task.text,
      ...(typeof task.from === "string" && task.from ? { from: task.from } : {}),
      ...(typeof task.after === "number" && Number.isSafeInteger(task.after) ? { after: task.after } : {}),
    };
  }

  /** The number of the last round Aya typed; 0 before the first. */
  async lastRound(): Promise<number> {
    const { lastRound } = await this.readState();
    return typeof lastRound === "number" && Number.isSafeInteger(lastRound) && lastRound > 0 ? lastRound : 0;
  }

  /** A typed round: its number and the clocks it answers (`roundClockAt` the rhythm's, `silenceRoundAt` the silence's)
   *  in one write, so a crash between them cannot resend the round. */
  recordRound(lastRound: number, clocks: { roundClockAt?: number; silenceRoundAt?: number } = {}): Promise<void> {
    return this.updateState((state) => ({ ...state, lastRound, ...clocks }));
  }

  /** When the quiet-team clock last sent the lead a round (epoch ms), or null since the last Start or Resume. */
  silenceRoundAt(): Promise<number | null> {
    return this.clockAt("silenceRoundAt");
  }

  clearSilenceRoundAt(): Promise<void> {
    return this.updateState(({ silenceRoundAt: _, ...rest }) => rest);
  }

  /** When the round clock last started or ticked (epoch ms), or null: a relaunch waits out the rest of the cadence. */
  roundClockAt(): Promise<number | null> {
    return this.clockAt("roundClockAt");
  }

  private async clockAt(key: "silenceRoundAt" | "roundClockAt"): Promise<number | null> {
    const at = (await this.readState())[key];
    return typeof at === "number" && Number.isFinite(at) ? at : null;
  }

  setRoundClockAt(roundClockAt: number): Promise<void> {
    return this.updateState((state) => ({ ...state, roundClockAt }));
  }

  assertLive(): Promise<void> {
    return this.serial(async () => {});
  }

  /** Forgets the team: its saved copy, state, panes and log. */
  remove(): Promise<void> {
    return this.serial(async () => {
      bump(removals, this.dir);
      await fs.rm(this.dir, { recursive: true, force: true });
    }, true);
  }

  /** What the team's rounds last saw; null before the first, or when the file is not a progress record. */
  async progress(): Promise<TeamProgress | null> {
    return parseProgress(await readJson<unknown>(this.file(TEAM_FILES.progress), null));
  }

  /** Read-modify-write under the team's write queue: a tick's late write cannot undo a Start. */
  updateProgress(change: (before: TeamProgress) => TeamProgress): Promise<TeamProgress> {
    return this.serial(async () => {
      const before = (await this.progress()) ?? FRESH_PROGRESS;
      const next = change(before);
      if (next.changedAt !== before.changedAt) bump(talk, this.dir);
      if (JSON.stringify(next) !== JSON.stringify(before) || (await readText(this.file(TEAM_FILES.progress))) === null) {
        await writeFileAtomic(this.file(TEAM_FILES.progress), JSON.stringify(next));
      }
      return next;
    });
  }

  /** The definition as the user last saved it; outside edits wait for Save. */
  saveDefinition(text: string): Promise<void> {
    return this.serial(() => writeFileAtomic(this.file(TEAM_FILES.saved), text));
  }

  savedDefinition(): Promise<string | null> {
    return readText(this.file(TEAM_FILES.saved));
  }

  /** The newest messages, from the last TEAM_LOG_READ_BYTES of the file.
   *  A torn or hand-edited line is skipped, not fatal to the whole team. */
  private async logTail(): Promise<{ entries: TeamMessage[]; size: number }> {
    let text = "";
    let size = 0;
    try {
      const handle = await fs.open(this.file(TEAM_FILES.log), "r");
      try {
        ({ size } = await handle.stat());
        // One byte early: a window starting on a line cuts at the "\n" before it, not through that line.
        const start = Math.max(0, size - TEAM_LOG_READ_BYTES - 1);
        const buffer = Buffer.alloc(size - start);
        await handle.read(buffer, 0, buffer.length, start);
        text = buffer.toString("utf-8");
        if (start > 0) text = text.slice(text.indexOf("\n") + 1);
      } finally {
        await handle.close();
      }
    } catch {
      // no log yet
    }
    const entries: TeamMessage[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as TeamMessage;
        if (entry && Number.isSafeInteger(entry.id)) entries.push(entry);
      } catch {
        // skipped
      }
    }
    return { entries, size };
  }

  async log(): Promise<TeamMessage[]> {
    return (await this.logTail()).entries;
  }

  append(message: Omit<TeamMessage, "id" | "time">): Promise<TeamMessage> {
    return this.serial(async () => {
      const { entries: log, size } = await this.logTail();
      const entry: TeamMessage = { id: (log.at(-1)?.id ?? 0) + 1, time: new Date().toISOString(), ...message };
      if (message.from !== TEAM_SYSTEM_SENDER) bump(talk, this.dir);
      await fs.mkdir(this.dir, { recursive: true });
      // Trimmed before the file outgrows the read window: past it, its oldest lines could no longer be read at all.
      if (log.length >= TEAM_LOG_MAX_ENTRIES || size + JSON.stringify(entry).length + 1 > TEAM_LOG_READ_BYTES) {
        const unread = unreadIn(await this.readMarks());
        const kept = keptByTrim([...log, entry], (m) => unread(m) && !goesStale(m));
        // Owner-only from the first byte: messages may hold secrets.
        const tmp = atomicTempPath(this.file(TEAM_FILES.log));
        await fs.writeFile(tmp, kept.map((m) => `${JSON.stringify(m)}\n`).join(""), { mode: OWNER_ONLY_FILE_MODE });
        await fs.rename(tmp, this.file(TEAM_FILES.log));
      } else {
        await fs.appendFile(this.file(TEAM_FILES.log), `${JSON.stringify(entry)}\n`, {
          mode: OWNER_ONLY_FILE_MODE,
        });
      }
      return entry;
    });
  }

  async sentSince(from: string, sinceMs: number): Promise<number> {
    return (await this.log()).filter((m) => m.from === from && Date.parse(m.time) >= sinceMs).length;
  }

  async unread(role: string): Promise<TeamMessage[]> {
    const unread = unreadIn(await this.readMarks());
    return (await this.log()).filter((m) => m.to === role && unread(m));
  }

  /** What the role is owed, oldest first: its unread messages but Aya's own, which go stale. */
  async owed(role: string): Promise<TeamMessage[]> {
    return (await this.unread(role)).filter((m) => !goesStale(m));
  }

  /** Per role, the last message id it has had: read from its inbox, typed later, or
   *  being typed (a crash mid-typing must not type it a second time). */
  async readMarks(): Promise<Record<string, number>> {
    const read = await this.rawReadMarks();
    for (const [role, mark] of Object.entries(await this.typingMarks())) {
      // One an earlier Aya left before its paste began was never typed: it is still owed.
      if (typeof mark !== "number" && !typingNow.has(this.typingKey(role))) continue;
      read[role] = Math.max(read[role] ?? 0, markId(mark));
    }
    return read;
  }

  private rawReadMarks(): Promise<Record<string, number>> {
    return readJson<Record<string, number>>(this.file(TEAM_FILES.read), {});
  }

  private readonly writeReadMarks = (read: Record<string, number>) => writeFileAtomic(this.file(TEAM_FILES.read), JSON.stringify(read, null, 2));

  private typingMarks(): Promise<Record<string, TypingMark>> {
    return readJson<Record<string, TypingMark>>(this.file(TEAM_FILES.typing), {});
  }

  private readonly writeTyping = (typing: Record<string, TypingMark>) => writeFileAtomic(this.file(TEAM_FILES.typing), JSON.stringify(typing));

  /** Unserialized: the callers hold the write queue. */
  private async raiseReadMark(role: string, id: number): Promise<void> {
    const read = await this.rawReadMarks();
    read[role] = Math.max(read[role] ?? 0, id);
    await this.writeReadMarks(read);
    debugLog(this, "owed", { role, change: "done", upTo: id });
  }

  markRead(role: string, id: number): Promise<void> {
    return this.serial(() => this.raiseReadMark(role, id));
  }

  /** Written before a message is typed and dropped once it is marked read or known not typed.
   *  False when the message was read or taken for typing since the caller looked: it is not typed twice. */
  beginTyping(role: string, id: number): Promise<boolean> {
    return this.serial(async () => {
      await this.foldCrashedTyping(role);
      const typing = await this.typingMarks();
      const taken = typing[role] === undefined ? 0 : markId(typing[role]);
      if (id <= Math.max((await this.rawReadMarks())[role] ?? 0, taken)) return false;
      await this.writeTyping({ ...typing, [role]: { queued: id } });
      typingNow.add(this.typingKey(role));
      debugLog(this, "reserve", { role, id, state: "queued" });
      return true;
    });
  }

  /** The reserved message's paste begins (its pane lock is held): from here a crash may leave it in the composer. */
  typingBegan(role: string, id: number): Promise<void> {
    return this.serial(async () => {
      const typing = await this.typingMarks();
      if (typing[role] === undefined || markId(typing[role]) !== id) return;
      await this.writeTyping({ ...typing, [role]: id });
      debugLog(this, "reserve", { role, id, state: "pasting" });
    });
  }

  /** The role's unread messages, marked read in one step (an inbox read and a redelivery never both get one), none while
   *  one is reserved for typing. `giveBack` makes them owed again for a reply that never reached the reader. */
  takeUnread(role: string): Promise<{ taken: TeamMessage[]; giveBack: () => Promise<void> }> {
    return this.serial(async () => {
      const none = { taken: [], giveBack: async () => {} };
      if (await this.foldCrashedTyping(role)) return none;
      const unread = await this.unread(role);
      if (!unread.length) return none;
      const markBefore = (await this.rawReadMarks())[role];
      const notesBefore = (await this.deliveryNotes())[role] ?? {};
      const last = unread.at(-1)!.id;
      await this.raiseReadMark(role, last);
      await this.writeNotes(role, Object.fromEntries(unread.map((m) => [m.id, { kind: "inbox" } as DeliveryNote])));
      const giveBack = () =>
        this.serial(async () => {
          const read = await this.rawReadMarks();
          if (read[role] !== last) return;
          read[role] = markBefore ?? 0;
          await this.writeReadMarks(read);
          const notes = await this.deliveryNotes();
          const mine = { ...notes[role] };
          for (const { id } of unread) {
            if (notesBefore[id]) mine[id] = notesBefore[id];
            else delete mine[id];
          }
          await this.writeDeliveryNotes({ ...notes, [role]: mine });
          debugLog(this, "owed", { role, change: "given back", after: markBefore ?? 0, upTo: last });
        });
      return { taken: unread, giveBack };
    });
  }

  /** Remembers how a held message reached its receiver, for the window and the draft note (the log itself is append-only). */
  noteDelivery(role: string, id: number, note: DeliveryNote): Promise<void> {
    return this.serial(() => this.writeNotes(role, { [id]: note }));
  }

  private async writeNotes(role: string, add: Record<string, DeliveryNote>): Promise<void> {
    const notes = await this.deliveryNotes();
    const mine = { ...notes[role], ...add };
    const keep = Object.keys(mine).map(Number).sort((x, y) => x - y).slice(-DELIVERY_NOTES_KEEP);
    notes[role] = Object.fromEntries(keep.map((id) => [id, mine[id]]));
    await this.writeDeliveryNotes(notes);
  }

  private deliveryNotes(): Promise<Record<string, Record<string, DeliveryNote>>> {
    return readJson(this.file(TEAM_FILES.deliveryNotes), {});
  }

  private readonly writeDeliveryNotes = (notes: Record<string, Record<string, DeliveryNote>>) => writeFileAtomic(this.file(TEAM_FILES.deliveryNotes), JSON.stringify(notes));

  /** The log as the window shows it, with each message's deliveryState. */
  async annotatedLog(): Promise<TeamMessage[]> {
    const notes = await this.deliveryNotes();
    const read = await this.readMarks();
    const typing = await this.typingMarks();
    // A reservation no typing in this process holds was left by an Aya that went down mid-paste (foldCrashedTyping).
    const crashed = (m: TeamMessage) => typing[m.to] === m.id && !typingNow.has(this.typingKey(m.to));
    return (await this.log()).map((m) => deliveryState(m, crashed(m) ? CRASHED_MID_TYPING : notes[m.to]?.[m.id], read[m.to] ?? 0));
  }

  /** The first message id this process is still typing (its Enter not settled yet), else Infinity. */
  async typingInFlight(): Promise<number> {
    const typing = Object.entries(await this.typingMarks()).filter(([role]) => typingNow.has(this.typingKey(role)));
    return Math.min(Infinity, ...typing.map(([, mark]) => markId(mark)));
  }

  endTyping(role: string): Promise<void> {
    return this.serial(() => this.dropTyping(role));
  }

  private async dropTyping(role: string): Promise<void> {
    typingNow.delete(this.typingKey(role));
    const { [role]: dropped, ...rest } = await this.typingMarks();
    await this.writeTyping(rest);
    if (dropped !== undefined) debugLog(this, "reserve", { role, id: markId(dropped), state: "dropped" });
  }

  /** A reservation an earlier Aya left mid-paste becomes a read mark: that message counts as typed, and nothing waits on it;
   *  one left before its paste began is dropped, the message still owed. True while this process is typing for the role. */
  private async foldCrashedTyping(role: string): Promise<boolean> {
    const id = (await this.typingMarks())[role];
    if (id === undefined) return false;
    if (typingNow.has(this.typingKey(role))) return true;
    debugLog(this, "reserve", { role, id: markId(id), state: "folded", pasting: typeof id === "number" });
    if (typeof id === "number") {
      await this.raiseReadMark(role, id);
      await this.writeNotes(role, { [id]: CRASHED_MID_TYPING });
    }
    await this.dropTyping(role);
    return false;
  }
}

/** Teams the user saved in Aya for this project, whether or not the repo still has the file. */
export async function savedTeamNames(ayaHome: string, project: string): Promise<string[]> {
  const projectDir = path.dirname(teamDir(ayaHome, project, "x"));
  const names = await fs.readdir(projectDir).catch(() => []);
  const saved = await Promise.all(names.filter((n) => ID_RE.test(n)).map(async (n) => ((await readText(path.join(projectDir, n, TEAM_FILES.saved))) === null ? null : n)));
  return saved.filter((n): n is string => n !== null);
}

export function openTeamStore(ayaHome: string, project: string, team: string): TeamStore {
  return new TeamStore(teamDir(ayaHome, project, team));
}
