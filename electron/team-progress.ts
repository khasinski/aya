// Team liveness. Progress is a change to the repo (a new HEAD or working tree); talk holds off the silence's
// round, but a repo unchanged for STALL_AFTER_MS is stalled however much the team talks.

import { HOLD_NOT_RUNNING, HOLD_STARTING, isDialogHold, NO_PANE_HOLD } from "./pane-holds";
import { debugLog, debugOn } from "./team-debug";
import type { TeamStore } from "./team-store";
import { BLOCKED_AFTER_MS, ROUND_SLACK_MS, SILENCE_FIRST_MIN, STALL_AFTER_MIN, STALL_AFTER_MS } from "./team-times";
import { TEAM_SYSTEM_SENDER } from "./team-definition";
import type { TeamLiveness, TeamMessage } from "./types";

/** What a team's clock last saw, kept in the team's progress.json. */
export interface TeamProgress {
  /** Highest peer (not Aya's) message id seen. */
  seenMessageId: number;
  /** Last known project HEAD; null while unknown. */
  commit: string | null;
  /** HEADs the team has had (newest last): going back to one is no change to the repo. */
  knownCommits?: string[];
  /** Last talk, change, wake-up or (re)start seen; ISO. The silence counts from it. */
  changedAt: string;
  /** The lead was told of this stall (by the round due at it). */
  stalledLogged: boolean;
  /** Per role seen on its own CLI's approval screen, and since when (ISO). `goneSince`: its
   *  pane has been closed since then; `freeReads`: consecutive reads of a free screen. */
  blocked: Record<string, { reason: string; since: string; goneSince?: string; freeReads?: number }>;
  /** The lead's pane could not take a due round (not running, a draft, a shell):
   *  `rounds` of them in a row since `since`. A busy pane is not this: its agent is working. */
  unreached?: { role: string; reason: string; since: string; rounds: number; last?: string };
  /** Last working-tree fingerprint (git.ts workingTreeState); null or absent while unknown. */
  tree?: string | null;
  /** Last change to the repo, or the Start, Resume, launch or answered screen that restarted the stall
   *  clock; ISO. Absent in a progress.json from older code: changedAt (never earlier) stands for it. */
  repoChangedAt?: string;
  /** Peer messages of more than one word since repoChangedAt. */
  messages?: number;
  /** The clock's last look (ISO): a relaunch tells a stall from before it apart from the time Aya was closed. */
  lookedAt?: string;
  /** Rounds typed to the lead `role` since its last answer: any message from it (an "ok" too), or a change to the repo. */
  unanswered?: { role: string; rounds: number };
}

/** Due rounds in a row the lead's pane did not take before the window calls it unreachable. */
export const UNREACHED_ROUNDS = 3;

/** Rounds in a row the lead did not answer before the next ones wait for its answer. */
export const UNANSWERED_ROUNDS = 3;

/** HEADs remembered per team: enough for a team's back-and-forth, bounded for progress.json. */
export const KNOWN_COMMITS_KEPT = 200;

/** Consecutive free reads that count as the user having answered a confirmed block. */
const FREE_READS_TO_WAKE = 2;

export const FRESH_PROGRESS: TeamProgress = {
  seenMessageId: 0,
  commit: null,
  changedAt: "",
  stalledLogged: false,
  blocked: {},
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const optional = (v: unknown, ok: (x: unknown) => boolean) => v === undefined || ok(v);
const isString = (v: unknown): v is string => typeof v === "string";

/** A progress.json of another shape (edited, from another version) reads as none; fields older code kept are dropped. */
export function parseProgress(raw: unknown): TeamProgress | null {
  if (!isRecord(raw) || !isRecord(raw.blocked)) return null;
  const { seenMessageId, commit, knownCommits, changedAt, stalledLogged, blocked, unreached, tree, repoChangedAt, messages, lookedAt, unanswered } = raw;
  const ok =
    Number.isSafeInteger(seenMessageId) &&
    (commit === null || isString(commit)) &&
    optional(knownCommits, (k) => Array.isArray(k) && k.every(isString)) &&
    isString(changedAt) &&
    typeof stalledLogged === "boolean" &&
    optional(tree, (t) => t === null || isString(t)) &&
    optional(repoChangedAt, isString) &&
    optional(messages, Number.isSafeInteger) &&
    optional(lookedAt, isString) &&
    Object.values(blocked).every((b) => isRecord(b) && isString(b.reason) && isString(b.since)) &&
    optional(
      unreached,
      (u) => isRecord(u) && isString(u.role) && isString(u.reason) && isString(u.since) && Number.isSafeInteger(u.rounds) && optional(u.last, isString),
    ) &&
    optional(unanswered, (u) => isRecord(u) && isString(u.role) && Number.isSafeInteger(u.rounds));
  if (!ok) return null;
  const kept = { seenMessageId, commit, knownCommits, changedAt, stalledLogged, blocked, unreached, tree, repoChangedAt, messages, lookedAt, unanswered };
  return Object.fromEntries(Object.entries(kept).filter(([, v]) => v !== undefined)) as unknown as TeamProgress;
}

export function teamStatus(input: {
  running: boolean;
  paused: boolean;
  /** No change to the repo for STALL_AFTER_MS. */
  stalled: boolean;
  blocked: readonly string[];
  /** The lead's pane has not taken UNREACHED_ROUNDS due rounds in a row. */
  unreached?: boolean;
  /** Peer messages since the last change to the repo. */
  talking?: boolean;
}): TeamLiveness["status"] {
  if (input.paused) return "paused";
  if (!input.running) return "never started";
  if (input.blocked.length) return "blocked";
  if (input.unreached) return "unreachable";
  if (input.stalled) return "stalled";
  return input.talking ? "talking" : "progressing";
}

/** When the stall clock started: the last change to the repo (or what restarted the clock). */
export const repoSince = (progress: Pick<TeamProgress, "changedAt" | "repoChangedAt">): string => progress.repoChangedAt || progress.changedAt;

/** The one stall rule: no change to the repo for STALL_AFTER_MS, whatever the rounds or the talk did. */
export function quietTooLong(progress: Pick<TeamProgress, "changedAt" | "repoChangedAt">, nowMs: number): boolean {
  const since = Date.parse(repoSince(progress));
  return Number.isFinite(since) && nowMs - since >= STALL_AFTER_MS;
}

/** The once-per-stall mark lasts as long as the stall. */
const markLasts = (progress: TeamProgress, nowMs: number): TeamProgress =>
  progress.stalledLogged && !quietTooLong(progress, nowMs) ? { ...progress, stalledLogged: false } : progress;

/** One word or none, e.g. the "ok" of a delivery test: it says nothing about the work. */
function isAck(text: string): boolean {
  return text.trim().split(/\s+/).filter(Boolean).length <= 1;
}

const confirmed = (since: string, nowMs: number): boolean => nowMs - Date.parse(since) >= BLOCKED_AFTER_MS;

function peerMessages(log: TeamMessage[]): TeamMessage[] {
  return log.filter((m) => m.from !== TEAM_SYSTEM_SENDER);
}

/** The screens now: a role on one screen keeps its first-seen time; a confirmed block ends (and wakes a stall) after
 *  FREE_READS_TO_WAKE free reads in a row; a pane closed longer than a block takes to count is gone, not waiting. */
function withScreens(base: TeamProgress, holds: Record<string, string | null>, now: string): TeamProgress {
  const blocked: TeamProgress["blocked"] = {};
  let woken = false;
  for (const [role, hold] of Object.entries(holds)) {
    const prev = base.blocked[role];
    if (hold === HOLD_NOT_RUNNING) {
      // A restarting pane has not been answered by anyone: keep what we knew, for a while.
      const goneSince = prev?.goneSince ?? now;
      if (prev && !confirmed(goneSince, Date.parse(now))) blocked[role] = { ...prev, goneSince };
    } else if (hold === HOLD_STARTING) {
      if (prev) blocked[role] = prev;
    } else if (isDialogHold(hold)) blocked[role] = prev?.reason === hold ? { reason: hold, since: prev.since } : { reason: hold, since: now };
    else if (prev && confirmed(prev.since, Date.parse(now))) {
      const freeReads = (prev.freeReads ?? 0) + 1;
      if (freeReads >= FREE_READS_TO_WAKE) woken = true;
      else blocked[role] = { ...prev, freeReads };
    }
  }
  // Answering the screen is the user's move: both clocks start over.
  return { ...base, blocked, changedAt: base.changedAt || now, ...(woken ? { stalledLogged: false, changedAt: now, repoChangedAt: now } : {}) };
}

function remember(known: readonly string[], head: string | null): string[] {
  if (head === null) return [...known];
  return [...known.filter((c) => c !== head), head].slice(-KNOWN_COMMITS_KEPT);
}

/** What the log, HEAD and the working tree say since `before`, and the progress that follows. A message counts
 *  from its own time, never later than now, so a look that sees it late does not push the clock. */
function withHeard(before: TeamProgress, peers: TeamMessage[], headCommit: string | null, tree: string | null | undefined, now: string, lead: string | null): TeamProgress {
  const heard = peers.filter((m) => m.id > before.seenMessageId);
  // A report typed with its Enter withheld has not reached the agent: it is nothing yet.
  const talked = heard.filter((m) => m.delivered && !m.typedOnly && !isAck(m.text));
  const known = remember(before.knownCommits ?? [], before.commit);
  // Unknown (null) is no change: a flapping git call must not read as work; nor is the first read, or a HEAD the team had.
  const committed = headCommit !== null && before.commit !== null && !known.includes(headCommit);
  const edited = tree != null && before.tree != null && tree !== before.tree;
  // Any message from the lead answers, an "ok" or one waiting in a busy peer's inbox too: the lead read its rounds.
  const answered = committed || edited || heard.some((m) => m.from === lead);
  const { unanswered, ...prior } = before;
  const seen = {
    ...prior,
    ...(unanswered && !answered && unanswered.role === lead ? { unanswered } : {}),
    seenMessageId: Math.max(before.seenMessageId, ...peers.map((m) => m.id)),
    commit: headCommit ?? before.commit,
    knownCommits: known,
    tree: tree ?? before.tree ?? null,
  };
  if (committed || edited) return { ...seen, changedAt: now, repoChangedAt: now, messages: 0 };
  if (!talked.length) return seen;
  const nowMs = Date.parse(now);
  const newest = talked.reduce((max, m) => Math.max(max, Math.min(nowMs, Date.parse(m.time) || nowMs)), 0);
  return { ...seen, changedAt: new Date(Math.max(newest, Date.parse(before.changedAt) || 0)).toISOString(), messages: (before.messages ?? 0) + talked.length };
}

/** A look of the team's clock: the log, HEAD, the working tree (when read) and each role's hold now; `lead` answers rounds. */
export async function observe(
  store: TeamStore,
  headCommit: string | null,
  holds: Record<string, string | null>,
  now: string,
  tree?: string | null,
  lead: string | null = null,
): Promise<TeamProgress> {
  // As delivered by now: a message is in the log before its paste, and typed or held after it. The look stops at
  // one still being typed: whether it is talk depends on how its Enter goes.
  const inFlight = await store.typingInFlight();
  const peers = peerMessages(await store.annotatedLog()).filter((m) => m.id < inFlight);
  return store.updateProgress((before) => ({ ...markLasts(withScreens(withHeard(before, peers, headCommit, tree, now, lead), holds, now), Date.parse(now)), lookedAt: now }));
}

/** The lead's rounds wait for its answer: it did not answer the last UNANSWERED_ROUNDS. */
export const roundsHeld = (progress: TeamProgress): boolean => (progress.unanswered?.rounds ?? 0) >= UNANSWERED_ROUNDS;

/** A peer message that was held and is typed now: talk, as it would have been had it gone in at once.
 *  A draft left in the composer is not typed and does not call this. */
export async function noteTyped(store: TeamStore, message: Pick<TeamMessage, "text">, now: string): Promise<void> {
  if (isAck(message.text)) return;
  await store.updateProgress((p) => ({ ...p, changedAt: now, messages: (p.messages ?? 0) + 1 }));
}

/** A due round the lead's pane could not take; a null `reason` (busy working) ends the run, a screen waiting for the
 *  user is reported as blocked instead. Tries within one period of the last counted miss are that miss, not another. */
export async function noteRound(store: TeamStore, role: string, reason: string | null, now: string, periodMs: number): Promise<void> {
  if (isDialogHold(reason)) return;
  await store.updateProgress(({ unreached, ...rest }) => {
    if (reason === null) return rest;
    const same = unreached?.role === role;
    const again = same && unreached.last !== undefined && Date.parse(now) - Date.parse(unreached.last) < periodMs - ROUND_SLACK_MS;
    if (again) return { ...rest, unreached: { ...unreached, reason } };
    return { ...rest, unreached: { role, reason, since: same ? unreached.since : now, rounds: (same ? unreached.rounds : 0) + 1, last: now } };
  });
}

/** Stalled at the clock's last look before now: a relaunch keeps that stall, not one that only the time Aya was closed made. */
export const stalledWhenLastLooked = (progress: TeamProgress): boolean => !!progress.lookedAt && quietTooLong(progress, Date.parse(progress.lookedAt));

/** A fresh baseline for a Start or Resume; the HEADs the team had stay known. */
export async function resetProgress(store: TeamStore, headCommit: string | null, now: string): Promise<void> {
  const seenMessageId = peerMessages(await store.log()).reduce((max, m) => Math.max(max, m.id), 0);
  await store.updateProgress((before) => ({
    ...FRESH_PROGRESS,
    seenMessageId,
    commit: headCommit,
    knownCommits: remember(before.knownCommits ?? [], headCommit),
    changedAt: now,
    repoChangedAt: now,
    messages: 0,
  }));
}

/** What a team has to watch it: a cadence (periodic rounds, every `cadence` minutes), a lead (rounds from the silence). */
interface TeamWatch {
  cadence: number | null;
  lead: boolean;
}

/** A confirmed block the user has not answered yet: the pane still shows its screen (read now, not written),
 *  or is restarting within the grace the clock started. */
function stillBlocked(b: TeamProgress["blocked"][string], hold: string | null, nowMs: number): boolean {
  if (b.freeReads || !confirmed(b.since, nowMs)) return false;
  if (hold === HOLD_NOT_RUNNING) return !b.goneSince || !confirmed(b.goneSince, nowMs);
  return hold === HOLD_STARTING || isDialogHold(hold);
}

/** The team's liveness for the teams window, from what the clock recorded and the panes' holds now. Writes nothing. */
export async function teamLiveness(
  store: TeamStore,
  roles: readonly string[],
  holdReason: (paneId: string) => Promise<string | null>,
  watch: TeamWatch,
  nowMs: number = Date.now(),
): Promise<TeamLiveness> {
  const { paused, running } = await store.state();
  const progress = (await store.progress()) ?? FRESH_PROGRESS;
  const holdOf = async (role: string, noPane: string | null = null): Promise<string | null> => {
    const pane = await store.paneOf(role);
    return pane ? holdReason(pane) : noPane;
  };
  const blocked: TeamLiveness["blocked"] = [];
  if (running) {
    for (const [role, b] of Object.entries(progress.blocked)) {
      if (roles.includes(role) && stillBlocked(b, await holdOf(role), nowMs)) blocked.push({ role, reason: b.reason, since: b.since });
    }
  }
  // Not "unreached" once the pane takes a message again: the window sees that before the next look.
  const held = progress.unreached;
  // A lead whose pane was closed is unreached as much as one whose pane does not run.
  const heldNow = running && watch.lead && held && held.rounds >= UNREACHED_ROUNDS ? await holdOf(held.role, NO_PANE_HOLD) : null;
  const unreached = held && heldNow !== null ? { role: held.role, reason: heldNow, since: held.since } : null;
  const stalled = running && quietTooLong(progress, nowMs);
  const messages = progress.messages ?? 0;
  const waiting = running && roundsHeld(progress) ? progress.unanswered : undefined;
  const status = teamStatus({ running, paused, stalled, blocked: blocked.map((b) => b.role), unreached: unreached !== null, talking: messages > 0 });
  if (debugOn()) {
    const why = status === "blocked" ? blocked.map((b) => `${b.role}: ${b.reason}`).join("; ") : status === "unreachable" ? unreached?.reason : status === "stalled" ? `no change to the repo since ${repoSince(progress)}` : undefined;
    debugLog(store, "liveness", { status, why });
  }
  return {
    status,
    stalledSince: stalled ? repoSince(progress) : null,
    repo: running ? { since: repoSince(progress), messages } : null,
    blocked,
    unreached,
    silence: { askAfterMin: watch.lead ? SILENCE_FIRST_MIN : null, everyMin: watch.cadence, stalledAfterMin: STALL_AFTER_MIN },
    roundsHeld: waiting ? { role: waiting.role, rounds: waiting.rounds } : null,
  };
}
