// The lead's round as "now + what changed": blocked panes, who waits on the lead, refused sends, the deltas
// since the last round and idle roles. Pure: the round (team-runner.ts) and `aya team stats --now` (team-stats.ts)
// read the team's records their own way and both call roundDigest. Totals stay in `aya team stats`.

import { HOLD_APPROVAL, HOLD_APPROVE_AYA, HOLD_CHOICE, HOLD_DRAFT, HOLD_NOT_RUNNING, HOLD_SHELL, HOLD_STARTING, HOLD_USAGE_LIMIT, NO_PANE_HOLD } from "./pane-holds";
import { TEAM_SYSTEM_SENDER } from "./team-definition";
import { pendingWaits, type StatusWait } from "./team-supervision";
import { clock, WALL_MINUTE_MS } from "./team-times";
import type { TeamMessage } from "./types";

// Wall-clock minutes, not cadence ones: they measure people and agents, and the CLI must give the round's answer.
/** A screen or held message younger than this is a prompt being answered, not a block. */
export const DIGEST_BLOCKED_MIN = 5;
/** A wait between two roles other than the lead shorter than this is a reply still being worked on. */
export const DIGEST_WAIT_MIN = 30;
/** A role with no message, turn or typed message for this long has nothing to do: the lead can give it work. */
export const DIGEST_IDLE_MIN = 20;
/** Enough of a refused text to tell which message it was; the round is no place for the whole of it. */
export const REFUSED_TEXT_CHARS = 40;
/** Lines per section: a long list in a round is a page the lead skims past. */
export const SECTION_ITEMS_SHOWN = 8;
export const COMMITS_SHOWN = 5;

/** A send `aya team send` refused, as refused.jsonl keeps it (team-store.ts recordRefusal). */
export interface RefusedSend {
  time: string;
  from: string;
  to: string;
  reason: string;
  text: string;
}

/** refused.jsonl's lines; a torn or hand-edited one is skipped, as the log's are. */
export function parseRefused(text: string | null): RefusedSend[] {
  const out: RefusedSend[] = [];
  for (const line of (text ?? "").split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line) as RefusedSend;
      if ([r.time, r.from, r.to, r.reason, r.text].every((v) => typeof v === "string")) out.push(r);
    } catch {
      // skipped
    }
  }
  return out;
}

export interface DigestSection {
  title: string;
  items: string[];
}

export interface Digest {
  header: string;
  sections: DigestSection[];
}

/** What progress.json says about screens, read loosely: the CLI parses it without the app's modules. */
export interface DigestScreens {
  commit?: string | null;
  blocked?: Record<string, { reason: string; since: string; goneSince?: string; freeReads?: number }>;
}

export interface DigestInput {
  roles: readonly string[];
  lead: string | null;
  /** The log with each message's delivery state (team-records deliveryState). */
  log: readonly TeamMessage[];
  progress: DigestScreens | null;
  refused: readonly RefusedSend[];
  /** Turns a typed message started per receiver (debug.jsonl "turn"); null without a debug log. */
  turns: readonly { role: string; time: string }[] | null;
  /** Roles whose agent is mid-turn now; null when not known (Aya closed, the CLI reading files). */
  busy: readonly string[] | null;
  /** What roles said with `aya status waiting` (on: the teammate, null: the user); absent when not known (the CLI). */
  statusWaits?: readonly StatusWait[];
  nowMs: number;
}

// Each hold Aya names, said short. All of them wait for the user: a dialog, a draft, a pane to open, restart or wait for.
const HOLD_LABELS: [string, string][] = [
  [HOLD_APPROVAL, "approval prompt"],
  [HOLD_CHOICE, "numbered choice"],
  [HOLD_APPROVE_AYA, "aya command approval"],
  [HOLD_USAGE_LIMIT, "out of credits or at its usage limit"],
  [HOLD_DRAFT, "user typing"],
  [HOLD_NOT_RUNNING, "pane not running"],
  [NO_PANE_HOLD, "no pane"],
  [HOLD_SHELL, "runs a shell"],
  [HOLD_STARTING, "still starting"],
];

/** A hold reason as the round says it, and whether only the user can clear it; a draft hold carries a note after it. */
export function holdLabel(reason: string): { label: string; onlyUser: boolean } {
  const known = HOLD_LABELS.find(([hold]) => reason === hold || reason.startsWith(`${hold};`));
  return known ? { label: known[1], onlyUser: true } : { label: reason.replace(/; .*$/, ""), onlyUser: false };
}

const minutes = (sinceMs: number, nowMs: number) => Math.max(0, Math.floor((nowMs - sinceMs) / WALL_MINUTE_MS));
export const duration = (min: number) => (min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`);
const who = (onlyUser: boolean) => (onlyUser ? "only the user" : "the team");
/** A round the lead got: one typed with its Enter withheld, or held, is no baseline, or what it would show is lost. */
const isRound = (m: TeamMessage, lead: string | null) => m.from === TEAM_SYSTEM_SENDER && m.to === lead && m.delivered && !m.typedOnly && /^Round \d+:/.test(m.text);
const QUEUED = /^earlier message #\d+ for it is still waiting/;
/** Still held for its receiver; Aya's own held rounds go stale, so they are no block. */
const heldForRole = (m: TeamMessage) => !m.delivered && !!m.held && m.from !== TEAM_SYSTEM_SENDER;
const counted = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const cut = (text: string) => (text.length > REFUSED_TEXT_CHARS ? `${text.slice(0, REFUSED_TEXT_CHARS).trimEnd()} ...` : text);

function capped(items: string[]): string[] {
  return items.length > SECTION_ITEMS_SHOWN ? [...items.slice(0, SECTION_ITEMS_SHOWN), `and ${items.length - SECTION_ITEMS_SHOWN} more`] : items;
}

function padded(rows: [string, string][]): string[] {
  const width = Math.max(0, ...rows.map(([role]) => role.length));
  return rows.map(([role, rest]) => `${role.padEnd(width)}  ${rest}`);
}

/** Per role, the oldest block of DIGEST_BLOCKED_MIN or more: the screen the clock saw (progress.json), else the
 *  first message still held for it (delivery-notes.json via the log). */
function blockedRows(input: DigestInput): { roles: Set<string>; rows: [string, string][] } {
  const { roles, log, progress, nowMs } = input;
  const rows: [string, string][] = [];
  const blocked = new Set<string>();
  for (const role of roles) {
    const screen = progress?.blocked?.[role];
    const stuck = screen ? minutes(Date.parse(screen.since), nowMs) : 0;
    // A screen read free since is being answered.
    if (screen && !screen.freeReads && stuck >= DIGEST_BLOCKED_MIN) {
      const { label, onlyUser } = holdLabel(screen.goneSince ? HOLD_NOT_RUNNING : screen.reason);
      rows.push([role, `stuck ${duration(stuck)}: ${label} (${who(onlyUser)})`]);
      blocked.add(role);
      continue;
    }
    // A message queued behind another names the first one's reason instead.
    const held = log.filter((m) => m.to === role && heldForRole(m));
    const first = held.find((m) => !QUEUED.test(m.held!)) ?? held[0];
    if (!first) continue;
    const heldMin = minutes(Date.parse(first.time), nowMs);
    if (heldMin < DIGEST_BLOCKED_MIN) continue;
    const { label, onlyUser } = QUEUED.test(first.held!) ? { label: "queued behind an earlier message", onlyUser: false } : holdLabel(first.held!);
    rows.push([role, `message #${first.id} held ${duration(heldMin)}: ${label} (${who(onlyUser)})`]);
    blocked.add(role);
  }
  return { roles: blocked, rows };
}

/** The new HEADs since the last round, oldest first: one the team had before it, or the first message's without a
 *  round before, is no change. */
function commitsSince(log: readonly TeamMessage[], prevIndex: number, head: string | null | undefined): string[] {
  const before = new Set(log.slice(0, Math.max(prevIndex, 0) + 1).map((m) => m.commit).filter(Boolean));
  const after = [...log.slice(prevIndex + 1).map((m) => m.commit), head ?? null].filter((c): c is string => !!c && !before.has(c));
  return [...new Set(after)];
}

/** The lead's view of the team now and since the last round (the last "Round N:" Aya logged to the lead). */
export function roundDigest(input: DigestInput): Digest {
  const { roles, lead, log, progress, refused, turns, busy, nowMs } = input;
  let prevIndex = log.length - 1;
  while (prevIndex >= 0 && !isRound(log[prevIndex], lead)) prevIndex -= 1;
  const prev = prevIndex >= 0 ? log[prevIndex] : null;
  const sinceIso = prev?.time ?? log[0]?.time ?? null;
  // Without a round before, every refusal kept is news: one may come before any message.
  const sinceMs = prev ? Date.parse(prev.time) : -Infinity;
  const recent = log.slice(prevIndex + 1);

  const messages = recent.filter((m) => m.from !== TEAM_SYSTEM_SENDER).length;
  const commits = commitsSince(log, prevIndex, progress?.commit);
  const held = recent.filter(heldForRole).length;
  const skipped = recent.filter((m) => m.from === TEAM_SYSTEM_SENDER && m.to === lead && /^round \d+ skipped/.test(m.text)).length;
  const shown = commits.slice(-COMMITS_SHOWN).join(", ");
  const parts = [
    messages ? `+${counted(messages, "message")}` : "no messages",
    commits.length ? `+${counted(commits.length, "commit")} (${commits.length > COMMITS_SHOWN ? "..., " : ""}${shown})` : "no commits",
    ...(held ? [`${held} held`] : []),
    ...(skipped ? [`${counted(skipped, "round")} skipped`] : []),
  ];
  const header = sinceIso === null ? "No messages yet" : `Since ${clock(sinceIso)}${prev ? "" : " (no round before)"}: ${parts.join(", ")}`;

  const sections: DigestSection[] = [];
  const add = (title: string, items: string[]) => void (items.length && sections.push({ title, items: capped(items) }));
  const blocked = blockedRows(input);
  // A question to the user is the user's to answer; a wait on a teammate is the team's, so it is no block.
  const said = input.statusWaits ?? [];
  for (const w of said) {
    if (w.on !== null || blocked.roles.has(w.role)) continue;
    blocked.rows.push([w.role, `asked the user ${duration(minutes(w.since, nowMs))} ago: "${cut(w.text)}" (only the user)`]);
    blocked.roles.add(w.role);
  }
  add("Needs action", padded(blocked.rows));

  const waits = pendingWaits(log, roles);
  const age = (w: { since: string }) => minutes(Date.parse(w.since), nowMs);
  add("Waiting on you", waits.filter((w) => w.on === lead).map((w) => `${w.waiter} #${w.id} for ${duration(age(w))}`));
  add(
    `Waiting over ${DIGEST_WAIT_MIN} min`,
    waits.filter((w) => w.on !== lead && age(w) >= DIGEST_WAIT_MIN).map((w) => `${w.waiter} on ${w.on} #${w.id} for ${duration(age(w))}`),
  );

  add(
    "Refused sends",
    refused.filter((r) => Date.parse(r.time) > sinceMs).map((r) => `${r.from} -> "${r.to}" (${r.reason}): "${cut(r.text)}"`),
  );

  add(
    "Said they wait on a teammate",
    said.filter((w) => w.on !== null && !blocked.roles.has(w.role)).map((w) => `${w.role} on ${w.on} for ${duration(minutes(w.since, nowMs))}: "${cut(w.text)}"`),
  );

  // Not idle: the lead (it reads this), a blocked role, one waiting on a reply, and one working now.
  const waiting = new Set([...waits.map((w) => w.waiter), ...said.map((w) => w.role)]);
  const lastActive = (role: string) =>
    Math.max(
      ...log.filter((m) => m.from === role || (m.to === role && m.delivered && !m.typedOnly)).map((m) => Date.parse(m.time)),
      ...(turns ?? []).filter((t) => t.role === role).map((t) => Date.parse(t.time)),
      Date.parse(log[0]?.time ?? new Date(nowMs).toISOString()),
    );
  const idle = roles.filter((r) => r !== lead && !blocked.roles.has(r) && !waiting.has(r) && !busy?.includes(r) && minutes(lastActive(r), nowMs) >= DIGEST_IDLE_MIN);
  add(`Idle over ${DIGEST_IDLE_MIN} min${busy === null ? " (not known whether busy now)" : ""}`, idle.length ? [idle.join(", ")] : []);

  return { header, sections };
}

/** For a person: one line per item under its section; a section of one item stays on its title's line. */
export function digestLines(d: Digest): string {
  const out = [d.header];
  for (const { title, items } of d.sections) {
    if (items.length === 1) out.push(`${title}: ${items[0]}`);
    else out.push(`${title}:`, ...items.map((i) => `  ${i}`));
  }
  return `${out.join("\n")}\n`;
}

/** For the lead's pane: a team message is one line (team-control oneLine), so sections are sentences. */
export function digestOneLine(d: Digest): string {
  return [`${d.header}.`, ...d.sections.map(({ title, items }) => `${title}: ${items.map((i) => i.replace(/ {2,}/g, " ")).join("; ")}.`)].join(" ");
}
