// What Aya tells the lead of a quiet team: who waits on whom, and since when. Aya measures
// time and messages only; what the work is, and how to unblock it, is the lead's to decide.

import { TEAM_MINUTE_MS } from "./paths";
import type { TeamMessage } from "./types";
import { clock } from "./team-times";

export interface RoleWait {
  waiter: string;
  on: string;
  /** The first message of the waiter's that the other role has not answered yet (ISO). */
  since: string;
}

/** Pairs where nothing `on` sent since `waiter` wrote to it reached `waiter`, directly or round a ring; a message to a
 *  third role, a held one or one typed without its Enter (annotatedLog) is no answer. Aya's and the user's do not count. */
export function pendingWaits(log: readonly TeamMessage[], roles: readonly string[]): RoleWait[] {
  const own = log.filter((m) => roles.includes(m.from) && roles.includes(m.to) && m.from !== m.to);
  // heard[x][y]: the id of y's latest message that has reached x by then (a vector clock over the log).
  const heard = new Map(roles.map((r) => [r, new Map<string, number>()]));
  for (const m of own) {
    const from = heard.get(m.from)!;
    const to = heard.get(m.to)!;
    from.set(m.from, m.id);
    if (!m.delivered || m.typedOnly) continue;
    for (const [role, id] of from) to.set(role, Math.max(to.get(role) ?? 0, id));
  }
  const waits: RoleWait[] = [];
  for (const waiter of roles) {
    for (const on of roles) {
      const answered = heard.get(waiter)!.get(on) ?? 0;
      const first = own.find((m) => m.from === waiter && m.to === on && m.id > answered);
      if (first) waits.push({ waiter, on, since: first.time });
    }
  }
  return waits.sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
}

function waitsText(waits: readonly RoleWait[], nowMs: number): string {
  return waits.length
    ? `Unanswered: ${waits.map((w) => `${w.waiter} waits for ${w.on} since ${clock(w.since)} (${minutesSince(w.since, nowMs)} min)`).join("; ")}.`
    : "No role has an unanswered message; check that each role is working.";
}

const ASK_USER = 'If you cannot, ask the user with: aya status waiting "<what you need>".';

const minutesSince = (iso: string, nowMs: number) => Math.max(0, Math.round((nowMs - Date.parse(iso)) / TEAM_MINUTE_MS));

/** The round typed to the lead when the team has been quiet: the numbered round, who waits on whom, what to do. Plain ASCII, one line. */
export function supervisionText({ round, quietSince, waits, nowMs }: { round: number; quietSince: string; waits: readonly RoleWait[]; nowMs: number }): string {
  return `Round ${round}: no progress since ${clock(quietSince)} (${minutesSince(quietSince, nowMs)} min). ${waitsText(waits, nowMs)} You lead this team: find out who is stuck and unblock them. ${ASK_USER}`;
}

/** The round due when the team stalls on the repo: talk is not progress; who waits on whom. Plain ASCII, one line. */
export function stalledText({ round, since, messages, waits, nowMs }: { round: number; since: string; messages: number; waits: readonly RoleWait[]; nowMs: number }): string {
  return (
    `Round ${round}: stalled: no change to the repo since ${clock(since)} (${messages} message${messages === 1 ? "" : "s"}). ${waitsText(waits, nowMs)} ` +
    'Messages are not progress: decide the next change to the repo and who makes it, or end the work with aya team pause "why". ' +
    ASK_USER
  );
}

const LOAD_WAIT_MIN = 5;
const LOAD_WAITS_SHOWN = 3;

/** The load since the last round, appended to the rhythm round: messages each role got and sent between roles,
 *  the role most messages went to, and who waits on whom. Aya counts; what to change is the lead's call. */
export function loadText({ log, roles, sinceMs, waits, nowMs }: { log: readonly TeamMessage[]; roles: readonly string[]; sinceMs: number; waits: readonly RoleWait[]; nowMs: number }): string {
  const recent = log.filter((m) => roles.includes(m.from) && roles.includes(m.to) && m.from !== m.to && Date.parse(m.time) >= sinceMs);
  if (!recent.length) return "";
  const got = (r: string) => recent.filter((m) => m.to === r).length;
  const sent = (r: string) => recent.filter((m) => m.from === r).length;
  const rows = roles.filter((r) => got(r) || sent(r)).map((r) => `${r} got ${got(r)} sent ${sent(r)}`);
  const top = [...roles].sort((a, b) => got(b) - got(a))[0];
  // Short waits are a reply on its way: only the three longest of five minutes or more.
  const long = waits.filter((w) => minutesSince(w.since, nowMs) >= LOAD_WAIT_MIN).slice(0, LOAD_WAITS_SHOWN);
  const waiting = long.length ? ` Waiting: ${long.map((w) => `${w.waiter} on ${w.on} ${minutesSince(w.since, nowMs)} min`).join("; ")}.` : "";
  return ` Load since ${clock(new Date(sinceMs).toISOString())}: ${rows.join("; ")}. Most messages went to ${top} (${got(top)}).${waiting}`;
}
