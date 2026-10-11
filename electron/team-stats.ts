// `aya team stats <team>`: what Aya did for a team, read from the team's files only. The CLI runs this file with
// plain node beside the app (it works with Aya closed), so it imports pure modules only (see team-records.ts).

import * as fs from "node:fs";
import * as path from "node:path";
import { parseTeamFile, savedStatusCommand } from "./team-definition";
import { DEBUG_LOG_FILE, DEBUG_LOG_OLD_FILE, debugTurns, deliveryState, goesStale, TEAM_FILES, unreadIn, type DeliveryNote } from "./team-records";
import { betweenRoles, pendingWaits, roleLoad, type RoleWait } from "./team-supervision";
import { digestLines, duration, parseRefused, roundDigest, type Digest } from "./team-digest";
import { formatStatusForStats, statusForStats } from "./team-status-command";
import { clock, WALL_MINUTE_MS } from "./team-times";
import type { TeamMessage } from "./types";

/** The team's files as text, null when absent. `debug` is debug.1.jsonl then debug.jsonl. */
export interface TeamFiles {
  saved: string | null;
  state: string | null;
  log: string | null;
  read: string | null;
  typing: string | null;
  notes: string | null;
  progress: string | null;
  assignments: string | null;
  debug: string | null;
  /** refused.jsonl; absent from older callers. */
  refused?: string | null;
  /** status.json, the status command's last run a round recorded. */
  status?: string | null;
}

export type Count = { key: string; count: number };

export interface TeamStats {
  team: string;
  status: { state: "running" | "paused" | "not started"; pausedBy: string | null };
  /** First to last entry of log.jsonl; it keeps messages #firstId..#lastId (older ones are trimmed). */
  runTime: { from: string; to: string; minutes: number; firstId: number; lastId: number } | null;
  /** First to last entry of the debug log, null without one. */
  debugTime: { from: string; to: string } | null;
  messages: { pairs: { from: string; to: string; count: number }[]; total: number };
  load: { roles: { role: string; got: number; sent: number }[]; top: { role: string; got: number } | null };
  rounds: { last: number; typed: Count[] | null; notTyped: number | null; skipped: Count[] | null; heldUnanswered: number | null };
  /** Messages per current delivery note (delivery-notes.json): held, typed without the Enter, read via the inbox. */
  heldMessages: Count[];
  /** Every decision not to type, from the debug log; a message held five times counts five. */
  holdEvents: Count[] | null;
  redeliveries: { total: number; byHold: Count[] } | null;
  pauses: { pause: number; unpause: number } | null;
  inbox: { role: string; count: number; oldestId: number; oldestTime: string }[];
  readMarks: { role: string; mark: number; lastTo: number | null; typing: number | null }[];
  waits: (RoleWait & { minutes: number })[];
  commits: { head: string | null; knownHeads: number | null; inLog: number; repoChangedAt: string | null };
  /** Rows that need `aya debug on`: absent when the debug log is there. */
  needsDebug: string[];
}

const DEBUG_ROWS = ["rounds typed and skipped", "hold decisions", "redeliveries", "pauses"];
const minutesBetween = (fromMs: number, toMs: number) => Math.round((toMs - fromMs) / WALL_MINUTE_MS);

function json<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return (JSON.parse(text) as T) ?? fallback;
  } catch {
    return fallback;
  }
}

/** One JSON object per line; a torn or hand-edited line is skipped, as the team store does. */
function lines<T>(text: string | null, keep: (v: T) => boolean): T[] {
  const out: T[] = [];
  for (const line of (text ?? "").split("\n")) {
    if (!line) continue;
    try {
      const v = JSON.parse(line) as T;
      if (v && typeof v === "object" && keep(v)) out.push(v);
    } catch {
      // skipped
    }
  }
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const numbers = (v: unknown): Record<string, number> =>
  isRecord(v) ? Object.fromEntries(Object.entries(v).filter((e): e is [string, number] => Number.isSafeInteger(e[1]))) : {};

/** One reason per kind of hold: message ids, clock times and the draft owner's details vary, the reason does not. */
export function holdKind(reason: string): string {
  return reason
    .replace(/; it may be message #.*$/, "")
    .replace(/#\d+/g, "#N")
    .replace(/\b\d{2}:\d{2}\b/g, "HH:MM")
    .replace(/ asked the user: .*$/, " asked the user");
}

function tally(keys: string[]): Count[] {
  const counts = new Map<string, number>();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

type DebugEvent = { time?: unknown; event?: unknown; [field: string]: unknown };

function roundStats(events: DebugEvent[]): Pick<TeamStats["rounds"], "typed" | "notTyped" | "skipped" | "heldUnanswered"> {
  const rounds = events.filter((e) => e.event === "round");
  const skipped = rounds.filter((e) => typeof e.skipped === "string");
  return {
    typed: tally(rounds.filter((e) => e.typed === true && e.skipped === undefined).map((e) => String(e.reason))),
    notTyped: rounds.filter((e) => e.typed === false).length,
    skipped: tally(skipped.map((e) => holdKind(String(e.skipped)))),
    heldUnanswered: rounds.filter((e) => e.held === "brake").length,
  };
}

function noteKind(note: DeliveryNote): string {
  if (note.kind === "inbox") return "read via aya team inbox";
  if (note.kind === "held") return `held: ${holdKind(note.reason)}`;
  // A withheld note's reason says it was typed when what came of the Enter is the news.
  return note.reason.startsWith("typed") ? holdKind(note.reason) : `typed, Enter withheld: ${holdKind(note.reason)}`;
}

/** The team's roles and lead from its saved copy, else the roles its files name. */
function teamRoles(team: string, files: TeamFiles, read: Record<string, number>): { roles: string[]; lead: string | null } {
  try {
    if (files.saved !== null) {
      const parsed = parseTeamFile(team, files.saved);
      return { roles: parsed.roles.map((r) => r.id), lead: parsed.lead };
    }
  } catch {
    // A saved copy that no longer parses: the roles come from the files below.
  }
  return { roles: [...new Set([...Object.keys(read), ...Object.keys(json<Record<string, unknown>>(files.assignments, {}))])], lead: null };
}

type Notes = Record<string, Record<string, DeliveryNote>>;

const parseLog = (files: TeamFiles) => lines<TeamMessage>(files.log, (m) => Number.isSafeInteger(m.id) && typeof m.from === "string" && typeof m.to === "string");

/** The log with each message's delivery state, as the team store reads it. */
function annotatedLog(log: TeamMessage[], notes: Notes, read: Record<string, number>): TeamMessage[] {
  return log.map((m) => deliveryState(m, isRecord(notes[m.to]) ? notes[m.to][m.id] : undefined, read[m.to] ?? 0));
}

/** The round's digest from the team's files (`aya team stats --now`): whether a role is busy is not in them. */
export function digestFromFiles(team: string, files: TeamFiles, nowMs: number): Digest {
  const read = numbers(json(files.read, {}));
  const { roles, lead } = teamRoles(team, files, read);
  const progress = json<Record<string, unknown> | null>(files.progress, null);
  return roundDigest({
    roles,
    lead,
    log: annotatedLog(parseLog(files), json<Notes>(files.notes, {}), read),
    progress: isRecord(progress) ? { commit: typeof progress.commit === "string" ? progress.commit : null, ...(isRecord(progress.blocked) ? { blocked: progress.blocked as never } : {}) } : null,
    refused: parseRefused(files.refused ?? null),
    turns: debugTurns(files.debug),
    busy: null,
    nowMs,
  });
}

/** What Aya did for the team, from its files; `nowMs` dates the waits. Pure: the CLI reads, this counts. */
export function teamStats(team: string, files: TeamFiles, nowMs: number): TeamStats {
  const state = json<Record<string, unknown>>(files.state, {});
  const read = numbers(json(files.read, {}));
  const typing = json<Record<string, unknown>>(files.typing, {});
  const notes = json<Notes>(files.notes, {});
  const progress = json<Record<string, unknown>>(files.progress, {});
  const { roles } = teamRoles(team, files, read);

  const log = parseLog(files);
  const debug = files.debug === null ? null : lines<DebugEvent>(files.debug, (e) => typeof e.event === "string");
  const events = debug ?? [];
  const times = (xs: { time?: unknown }[]) => xs.map((x) => String(x.time)).filter((t) => !Number.isNaN(Date.parse(t)));

  const logTimes = times(log);
  const debugTimes = times(events);
  const paused = state.paused === true;
  const pairs = tally(log.map((m) => `${m.from}\0${m.to}`)).map(({ key, count }) => {
    const [from, to] = key.split("\0");
    return { from, to, count };
  });
  const between = betweenRoles(log, roles);
  const { load, top } = roleLoad(between, roles);
  const owed = log.filter(unreadIn(read)).filter((m) => !goesStale(m));
  const holds = events.filter((e) => e.event === "hold");
  const redeliveries = events.filter((e) => e.event === "redelivery");
  const lastRound = Number.isSafeInteger(state.lastRound) ? (state.lastRound as number) : 0;
  const known = Array.isArray(progress.knownCommits) ? progress.knownCommits.length : null;
  const noteList = Object.values(notes).flatMap((byId) => (isRecord(byId) ? Object.values(byId) : [])).filter((n): n is DeliveryNote => isRecord(n) && typeof n.kind === "string");

  return {
    team,
    status: {
      state: paused ? "paused" : state.started === true ? "running" : "not started",
      pausedBy: paused ? (typeof state.pausedBy === "string" && state.pausedBy ? state.pausedBy : "user") : null,
    },
    runTime: logTimes.length
      ? { from: logTimes[0], to: logTimes.at(-1)!, minutes: minutesBetween(Date.parse(logTimes[0]), Date.parse(logTimes.at(-1)!)), firstId: log[0].id, lastId: log.at(-1)!.id }
      : null,
    debugTime: debugTimes.length ? { from: debugTimes[0], to: debugTimes.at(-1)! } : null,
    messages: { pairs, total: log.length },
    load: { roles: load, top: between.length ? top : null },
    rounds: { last: lastRound, ...(debug ? roundStats(events) : { typed: null, notTyped: null, skipped: null, heldUnanswered: null }) },
    heldMessages: tally(noteList.map(noteKind)),
    holdEvents: debug ? tally(holds.map((e) => holdKind(String(e.reason)))) : null,
    redeliveries: debug ? { total: redeliveries.length, byHold: tally(redeliveries.map((e) => (e.hold ? holdKind(String(e.hold)) : "free: typed (or tried)"))) } : null,
    pauses: debug ? { pause: events.filter((e) => e.event === "pause").length, unpause: events.filter((e) => e.event === "unpause").length } : null,
    inbox: roles
      .map((role) => ({ role, mine: owed.filter((m) => m.to === role) }))
      .filter(({ mine }) => mine.length)
      .map(({ role, mine }) => ({ role, count: mine.length, oldestId: mine[0].id, oldestTime: mine[0].time })),
    readMarks: [...new Set([...roles, ...Object.keys(read)])].map((role) => {
      const mark = typing[role];
      const reserved = typeof mark === "number" ? mark : isRecord(mark) && Number.isSafeInteger(mark.queued) ? (mark.queued as number) : null;
      return { role, mark: read[role] ?? 0, lastTo: log.filter((m) => m.to === role).at(-1)?.id ?? null, typing: reserved };
    }),
    waits: pendingWaits(annotatedLog(log, notes, read), roles).map((w) => ({ ...w, minutes: Math.max(0, minutesBetween(Date.parse(w.since), nowMs)) })),
    commits: {
      head: typeof progress.commit === "string" ? progress.commit : null,
      knownHeads: known,
      inLog: new Set(log.map((m) => m.commit).filter((c): c is string => typeof c === "string" && c !== "")).size,
      repoChangedAt: typeof progress.repoChangedAt === "string" ? progress.repoChangedAt : null,
    },
    needsDebug: debug ? [] : DEBUG_ROWS,
  };
}

const pad2 = (n: number) => String(n).padStart(2, "0");
/** Local "YYYY-MM-DD HH:MM": a run often spans midnight. */
function stamp(iso: string): string {
  const t = new Date(iso);
  return `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())} ${clock(iso)}`;
}
const LABEL_WIDTH = 36;
const COUNT_WIDTH = 6;
const row = (label: string, value: string | number) => `  ${label.padEnd(LABEL_WIDTH)} ${value}`.trimEnd();
// Counts first: hold reasons are long, and the numbers line up only before them.
const countRow = (count: number, label: string) => `  ${String(count).padStart(COUNT_WIDTH)}  ${label}`;
const NEEDS_DEBUG = "needs aya debug on (no debug.jsonl)";

/** The stats as the CLI prints them: one section per question, with each count's source file. */
export function formatStats(s: TeamStats): string {
  const out: string[] = [];
  const section = (title: string) => out.push("", title);
  const counts = (list: Count[] | null, prefix = "") => {
    if (list === null) out.push(`  ${NEEDS_DEBUG}`);
    else if (!list.length) out.push("  none");
    else for (const { key, count } of list) out.push(countRow(count, `${prefix}${key}`));
  };

  out.push(`team ${s.team}`);
  out.push(row("state (state.json)", s.status.state === "paused" ? `paused by ${s.status.pausedBy}` : s.status.state));
  out.push(row("pauses / resumes (debug.jsonl)", s.pauses ? `${s.pauses.pause} / ${s.pauses.unpause}` : NEEDS_DEBUG));
  out.push(
    row("run time (log.jsonl)", s.runTime ? `${stamp(s.runTime.from)} to ${stamp(s.runTime.to)}, ${duration(s.runTime.minutes)} (messages #${s.runTime.firstId}..#${s.runTime.lastId})` : "no messages yet"),
  );
  out.push(row("debug log (debug.jsonl)", s.debugTime ? `${stamp(s.debugTime.from)} to ${stamp(s.debugTime.to)}` : NEEDS_DEBUG));

  section("messages, from -> to (log.jsonl)");
  for (const p of s.messages.pairs) out.push(countRow(p.count, `${p.from} -> ${p.to}`));
  out.push(countRow(s.messages.total, "total"));
  if (s.load.top) {
    out.push(row("between roles, got/sent", s.load.roles.map((r) => `${r.role} ${r.got}/${r.sent}`).join(", ")));
    out.push(row("most went to", `${s.load.top.role} (${s.load.top.got})`));
  }

  section("rounds");
  out.push(row("last Aya round (state.json)", s.rounds.last));
  if (s.rounds.typed === null) out.push(row("typed, skipped and why", NEEDS_DEBUG));
  else {
    out.push(row("typed (debug.jsonl)", s.rounds.typed.length ? s.rounds.typed.map((t) => `${t.key} ${t.count}`).join(", ") : 0));
    out.push(row("tried, not typed", s.rounds.notTyped ?? 0));
    if (s.rounds.skipped?.length) counts(s.rounds.skipped, "skipped: ");
    if (s.rounds.heldUnanswered) out.push(countRow(s.rounds.heldUnanswered, "held: the lead did not answer the earlier Aya rounds"));
  }

  section("held messages, by their note now (delivery-notes.json)");
  counts(s.heldMessages);
  section("hold decisions (debug.jsonl)");
  counts(s.holdEvents);
  section("redelivery tries, by what the pane showed (debug.jsonl)");
  counts(s.redeliveries?.byHold ?? null);
  if (s.redeliveries) out.push(countRow(s.redeliveries.total, "total"));

  section("waiting in an inbox, not typed yet (log.jsonl, read.json)");
  if (!s.inbox.length) out.push("  none");
  for (const i of s.inbox) out.push(row(i.role, `${i.count} (oldest #${i.oldestId}, ${stamp(i.oldestTime)})`));

  section("read mark per role (read.json)");
  for (const r of s.readMarks) {
    const last = r.lastTo === null ? "nothing to it in the log" : `last to it #${r.lastTo}`;
    out.push(row(r.role, `#${r.mark} (${last}${r.typing !== null ? `; typing #${r.typing}` : ""})`));
  }

  section("unanswered, who waits on whom (log.jsonl)");
  if (!s.waits.length) out.push("  none");
  for (const w of s.waits) out.push(row(`${w.waiter} waits for ${w.on}`, `since ${stamp(w.since)} (${duration(w.minutes)})`));

  section("commits");
  out.push(row("HEAD (progress.json)", s.commits.head ?? "unknown"));
  out.push(row("HEADs seen (progress.json)", s.commits.knownHeads ?? "unknown"));
  out.push(row("HEADs on messages (log.jsonl)", s.commits.inLog));
  if (s.commits.repoChangedAt) out.push(row("last change to the repo", stamp(s.commits.repoChangedAt)));
  return `${out.join("\n")}\n`;
}


function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** The CLI's only I/O: the team directory's files as text. */
export function readTeamFiles(dir: string): TeamFiles {
  const at = (name: string) => readOrNull(path.join(dir, name));
  const debugParts = [at(DEBUG_LOG_OLD_FILE), at(DEBUG_LOG_FILE)].filter((t): t is string => t !== null);
  return {
    saved: at(TEAM_FILES.saved),
    state: at(TEAM_FILES.state),
    log: at(TEAM_FILES.log),
    read: at(TEAM_FILES.read),
    typing: at(TEAM_FILES.typing),
    notes: at(TEAM_FILES.deliveryNotes),
    progress: at(TEAM_FILES.progress),
    assignments: at(TEAM_FILES.assignments),
    debug: debugParts.length ? debugParts.map((t) => (t.endsWith("\n") ? t : `${t}\n`)).join("") : null,
    refused: at(TEAM_FILES.refused),
    status: at(TEAM_FILES.status),
  };
}

// bin/aya: node team-stats.js <team dir> <team> [--json|--now]
if (require.main === module) {
  const [dir, team, flag] = process.argv.slice(2);
  const files = readTeamFiles(dir);
  const status = statusForStats(savedStatusCommand(team, files.saved), files.status ?? null);
  const statusBlock = status ? formatStatusForStats(status) : "";
  // --now is the lead's round, and the round ends with the status command's output.
  if (flag === "--now") process.stdout.write(digestLines(digestFromFiles(team, files, Date.now())) + statusBlock);
  else {
    const stats = teamStats(team, files, Date.now());
    process.stdout.write(flag === "--json" ? `${JSON.stringify({ ...stats, statusCommand: status }, null, 2)}\n` : formatStats(stats) + statusBlock);
  }
}
