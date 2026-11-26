// Claude Code usage limits in the Conversation GUI: which limit stopped a turn and when it resets.
// Reset times come from `rate_limit_event` frames (and the same `rate_limit_info` that a blocked assistant
// message carries), else from the text of the failed result. Detection logic ported from T3 Code's Claude
// adapter (MIT, https://github.com/pingdotgg/t3code).

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === 'string' ? value : '');

/** What Aya adds to a failed turn's error when a usage or rate limit stopped it. `resetsAt` is epoch ms. */
export interface GuiUsageLimitInfo {
  resetsAt: number | null;
  window?: string;
}

const WINDOWS: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: '7-day',
  seven_day_opus: '7-day Opus',
  seven_day_sonnet: '7-day Sonnet',
  seven_day_overage_included: '7-day model',
  overage: 'overage',
};
const MAX_WAIT_MS = 30 * 24 * 60 * 60 * 1000;
/** The CLIs' own limit messages, at the start of a line (an error that only mentions a rate limit is not one):
 *  "Claude AI usage limit reached|…", "You've hit your limit · resets 3pm", "5-hour limit reached ∙ resets 3pm",
 *  "API Error: 429 …", "API Error: Rate limit reached", "Rate limit reached for …", and the API's rate_limit_error. */
const LIMIT_TEXT = /(?:^|\n)\s*(?:(?:Claude(?: AI)? )?usage limit (?:reached|exceeded)|You(?:'|\u2019)ve (?:hit|reached) your (?:usage |session |weekly )?limit|(?:[\w-]+ )?limit reached\s*[∙·•|]|(?:API Error: (?:429 )?)?Rate limit (?:reached|exceeded)|API Error: 429\b)|"type"\s*:\s*"rate_limit_error"/i;

/** Claude reports `resetsAt` in epoch seconds; anything implausible is unknown. */
export function claudeResetMs(resetsAt: unknown, now = Date.now()): number | null {
  const ms = typeof resetsAt === 'number' ? resetsAt * 1000 : NaN;
  return Number.isFinite(ms) && ms > now - 60_000 && ms - now <= MAX_WAIT_MS ? ms : null;
}

/** The next moment after `now` at which the clock in time zone `zone` reads hour:minute, or null for an unknown zone. */
function nextWallClock(hour: number, minute: number, zone: string, now: number): number | null {
  let format: Intl.DateTimeFormat;
  try { format = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }); } catch { return null; }
  const parts = (at: number) => Object.fromEntries(format.formatToParts(at).map(p => [p.type, Number(p.value)])) as Record<string, number>;
  const offset = (at: number) => { const p = parts(at); return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(at / 1000) * 1000; };
  const today = parts(now);
  for (let day = 0; day < 3; day++) {
    const guess = Date.UTC(today.year, today.month - 1, today.day + day, hour, minute);
    const at = guess - offset(guess - offset(guess));
    if (at > now) return at;
  }
  return null;
}

/** A reset named only in the result text: `…limit reached|1767225600`, `(reset after 1h 5m)`, `resets 3pm`. */
export function resetFromLimitText(value: string, now = Date.now()): number | null {
  const epoch = /\|(\d{10})\b/.exec(value);
  if (epoch) return claudeResetMs(Number(epoch[1]), now);
  const after = /reset (?:after|in) (?:(\d+)h ?)?(?:(\d+)m(?:in)? ?)?(?:(\d+)s)?/i.exec(value);
  if (after && (after[1] || after[2] || after[3])) {
    return now + ((Number(after[1] || 0) * 60 + Number(after[2] || 0)) * 60 + Number(after[3] || 0)) * 1000;
  }
  const at = /resets?(?: at)? (\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(value);
  if (at) {
    let hour = Number(at[1]);
    const minute = Number(at[2] || 0), meridiem = (at[3] || '').toLowerCase();
    if (!at[2] && !meridiem) return null; // "resets 5" says nothing about the time
    if (hour > 23 || minute > 59 || (meridiem && hour > 12)) return null;
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    const zone = /^\s*\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*)\)/.exec(value.slice(at.index + at[0].length))?.[1];
    const zoned = zone ? nextWallClock(hour, minute, zone, now) : null;
    if (zoned !== null) return zoned;
    const reset = new Date(now);
    reset.setHours(hour, minute, 0, 0);
    if (reset.getTime() <= now) reset.setDate(reset.getDate() + 1);
    return reset.getTime();
  }
  return null;
}

/** Follows one Claude turn's rate-limit frames and classifies the result that ends it. */
export class ClaudeUsageLimitTracker {
  private rejected = new Map<string, number | null>();

  /** Starts a new turn. */
  reset() { this.rejected.clear(); }

  /** Records a `rate_limit_event`, or the `rate_limit_info` of an assistant message Claude could not produce. */
  observe(message: Record<string, unknown>, now = Date.now()) {
    let info: Record<string, unknown> | null = null;
    if (text(message.type) === 'rate_limit_event') info = object(message.rate_limit_info);
    else if (text(message.type) === 'assistant' && text(message.error) === 'rate_limit') {
      info = object(object(message.api_error_params).rate_limit_info);
      if (!Object.keys(info).length) { if (!this.rejected.size) this.rejected.set('unknown', null); return; }
    }
    if (!info) return;
    const type = text(info.rateLimitType) || 'unknown';
    const overage = info.overageStatus === 'allowed' || info.overageStatus === 'allowed_warning' || info.isUsingOverage === true || info.overageInUse === true;
    if (info.status === 'rejected' && !overage) this.rejected.set(type, claudeResetMs(info.resetsAt, now));
    else if (info.status === 'allowed' || info.status === 'allowed_warning' || overage) this.rejected.delete(type);
  }

  /** The limit that stopped the turn this failed `result` ends, or null when it failed for another reason. */
  limitFor(result: Record<string, unknown>, now = Date.now()): GuiUsageLimitInfo | null {
    if (result.is_error !== true) return null;
    const resultText = [text(result.result), ...(Array.isArray(result.errors) ? result.errors.map(text) : [])].join('\n');
    if (!this.rejected.size && result.api_error_status !== 429 && !LIMIT_TEXT.test(resultText)) return null;
    const known = [...this.rejected].filter(([, at]) => at !== null) as [string, number][];
    const latest = known.sort((a, b) => b[1] - a[1])[0];
    const resetsAt = latest ? latest[1] : resetFromLimitText(resultText, now);
    const type = latest?.[0] ?? [...this.rejected.keys()].find(key => key !== 'unknown');
    return { resetsAt, ...(type && WINDOWS[type] ? { window: WINDOWS[type] } : {}) };
  }
}

/** The line a Limited pane shows for a Claude limit. */
export function claudeLimitMessage(limit: GuiUsageLimitInfo, resultText: string): string {
  const said = resultText.replace(/\|\d{10}\b/, '').trim();
  if (said && said.length <= 300 && LIMIT_TEXT.test(said)) return said;
  return `Claude usage limit reached${limit.window ? ` (${limit.window} limit)` : ''}.`;
}
