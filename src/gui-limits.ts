// A Conversation GUI pane stopped by a usage or rate limit ("Limited"): what stopped it, when the limit resets, and
// what the user chose to do about it (resume at reset, snooze until reset). Saved with the conversation, so a
// scheduled resume survives a renderer reload.

import type { GuiPaneStatus } from "./gui-status";

export interface GuiUsageLimit {
  message: string;
  /** Epoch ms, or null when the agent did not say. */
  resetsAt: number | null;
  /** "5-hour", "weekly"… */
  window?: string;
  /** Send "continue" when the limit resets. */
  resumeAtReset?: boolean;
  /** Quiet until the reset: no status, no attention. */
  snoozed?: boolean;
}

/** How long after the reset a scheduled resume waits, so the provider has reopened the window. */
export const RESUME_GRACE_MS = 3000;
/** A scheduled resume this long past its reset (Aya was closed, the machine slept) is dropped: the card offers
 *  "Continue now" instead of sending "continue" the moment the pane reconnects, maybe the next day. */
export const RESUME_STALE_MS = 15 * 60 * 1000;
/** What a scheduled resume sends. */
export const RESUME_PROMPT = "continue";

const obj = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const str = (value: unknown) => typeof value === "string" ? value : "";
const LIMIT_CODES = new Set(["usageLimitExceeded", "rateLimitExceeded"]);
/** The agents' own limit messages, at the start of a line (an error that only mentions a rate limit is not one). */
const LIMIT_TEXT = /(?:^|\n)\s*(?:(?:Claude(?: AI)? )?usage limit (?:reached|exceeded)|You(?:'|\u2019)ve (?:hit|reached) your (?:usage |session |weekly )?limit|(?:[\w-]+ )?limit reached\s*[∙·•|]|(?:API Error: (?:429 )?)?Rate limit (?:reached|exceeded)|API Error: 429\b|(?:Quota exceeded|You exceeded your current quota)\b)/i;

/** A saved limit, or null when the value is not one. */
export function parseUsageLimit(value: unknown): GuiUsageLimit | null {
  const v = obj(value);
  if (!str(v.message)) return null;
  const resetsAt = typeof v.resetsAt === "number" && Number.isFinite(v.resetsAt) ? v.resetsAt : null;
  return {
    message: str(v.message), resetsAt,
    ...(str(v.window) ? { window: str(v.window) } : {}),
    ...(v.resumeAtReset === true && resetsAt !== null ? { resumeAtReset: true } : {}),
    ...(v.snoozed === true && resetsAt !== null ? { snoozed: true } : {}),
  };
}

/** Codex's latest rate-limit windows, from `account/rateLimits/updated` (sparse) or `account/rateLimits/read`. */
export interface CodexLimitWindow { usedPercent: number; resetsAt: number | null; windowDurationMins: number | null }
export type CodexRateLimits = { primary?: CodexLimitWindow; secondary?: CodexLimitWindow; reached?: string };

const codexWindow = (value: unknown): CodexLimitWindow | undefined => {
  const w = obj(value);
  if (typeof w.usedPercent !== "number") return undefined;
  return { usedPercent: w.usedPercent, resetsAt: typeof w.resetsAt === "number" ? w.resetsAt : null, windowDurationMins: typeof w.windowDurationMins === "number" ? w.windowDurationMins : null };
};

/** Merges a sparse `account/rateLimits/updated` into what was known: a missing window keeps its last reading. */
export function mergeCodexRateLimits(previous: CodexRateLimits | null, params: unknown): CodexRateLimits {
  const snapshot = obj(obj(params).rateLimits);
  const primary = codexWindow(snapshot.primary) ?? previous?.primary;
  const secondary = codexWindow(snapshot.secondary) ?? previous?.secondary;
  const reached = str(snapshot.rateLimitReachedType) || previous?.reached;
  return { ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}), ...(reached ? { reached } : {}) };
}

/** "5-hour", "weekly", "2-day": a window's name from its length. */
export function windowName(minutes: number | null): string | undefined {
  if (!minutes || minutes <= 0) return undefined;
  if (minutes === 10080) return "weekly";
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

/** The exhausted Codex window that resets last (the one that keeps the account limited). */
function codexExhausted(limits: CodexRateLimits | null, now: number): { resetsAt: number | null; window?: string } {
  const windows = [limits?.primary, limits?.secondary].filter((w): w is CodexLimitWindow => !!w && w.usedPercent >= 100 && w.resetsAt !== null && w.resetsAt * 1000 > now);
  const last = windows.sort((a, b) => b.resetsAt! - a.resetsAt!)[0];
  if (!last) return { resetsAt: null };
  const name = windowName(last.windowDurationMins);
  return { resetsAt: last.resetsAt! * 1000, ...(name ? { window: name } : {}) };
}

/** The limit a failed turn hit, from Aya's own `usageLimit` (Claude), Codex's error code, or the error text. */
export function turnUsageLimit(turn: unknown, codexLimits: CodexRateLimits | null, now = Date.now()): GuiUsageLimit | null {
  const error = obj(obj(turn).error);
  const message = str(error.message).trim();
  const own = obj(error.usageLimit);
  if (Object.keys(own).length) {
    const resetsAt = typeof own.resetsAt === "number" && Number.isFinite(own.resetsAt) ? own.resetsAt : null;
    return { message: message || "Usage limit reached.", resetsAt, ...(str(own.window) ? { window: str(own.window) } : {}) };
  }
  const code = typeof error.codexErrorInfo === "string" ? error.codexErrorInfo : "";
  if (!LIMIT_CODES.has(code) && !(message && LIMIT_TEXT.test(message))) return null;
  return { message: message || "Usage limit reached.", ...codexExhausted(codexLimits, now) };
}

/** True for a Codex `error` notification that ends the turn on a usage limit (its turn/completed follows). */
export function isUsageLimitError(params: unknown): boolean {
  const p = obj(params), error = obj(p.error);
  return p.willRetry !== true && (LIMIT_CODES.has(str(error.codexErrorInfo)) || LIMIT_TEXT.test(str(error.message)));
}

/** "15:05" today, "Tue 15:05" later this week, else a date: in the user's locale. */
export function formatResetTime(at: number, now = Date.now()): string {
  const date = new Date(at), today = new Date(now);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === today.toDateString()) return time;
  if (at - now < 6 * 24 * 60 * 60 * 1000) return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

/** The pane's Limited line: "Limited · 5-hour limit resets 15:05", "Limited · resumes at 15:05". */
export function limitStatusText(limit: GuiUsageLimit, now = Date.now()): string {
  if (limit.resetsAt === null) return "Limited · reset time unknown";
  if (limit.resetsAt <= now) return "Usage limit reset · ready to continue";
  const when = formatResetTime(limit.resetsAt, now);
  if (limit.resumeAtReset) return `Limited · resumes at ${when}`;
  return `Limited · ${limit.window ? `${limit.window} limit ` : ""}resets ${when}`;
}

/** What a limited pane reports: Limited is an error until the reset, a snoozed pane stays quiet, and a reset that
 *  did not resume says the pane can continue. Null when the pane is not limited. */
export function limitPaneStatus(limit: GuiUsageLimit | null, now = Date.now()): GuiPaneStatus | null {
  if (!limit) return null;
  if (limit.resetsAt !== null && limit.resetsAt <= now) return { level: "done", text: limitStatusText(limit, now) };
  if (limit.snoozed) return "clear";
  return { level: "error", text: limitStatusText(limit, now) };
}

/** What happens next for a limited pane, and in how many ms: the reset wakes a snoozed pane, then a scheduled
 *  resume sends its message a moment later. Null when nothing is scheduled. */
export function nextLimitEvent(limit: GuiUsageLimit | null, now = Date.now()): { action: "wake" | "resume"; inMs: number } | null {
  if (!limit || limit.resetsAt === null) return null;
  if (limit.resetsAt > now) return { action: "wake", inMs: limit.resetsAt - now };
  if (limit.resumeAtReset && now - limit.resetsAt <= RESUME_STALE_MS) return { action: "resume", inMs: Math.max(0, limit.resetsAt + RESUME_GRACE_MS - now) };
  return null;
}

/** setTimeout cannot wait longer than ~24.8 days; a longer wait is re-armed. */
export const timerDelay = (ms: number) => Math.min(Math.max(0, ms), 2 ** 31 - 1);
