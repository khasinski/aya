// A team's clocks, in one place: the defaults of the product. A cadence "minute" is
// TEAM_MINUTE_MS long (shortened in e2e and in tests), so none of these is waited for in full there.

import { TEAM_MINUTE_MS } from "./paths";

/** A wall-clock minute: what people and agents take, never shortened in tests the way a cadence minute is. */
export const WALL_MINUTE_MS = 60_000;

/** No progress for this long: the lead is asked for a round. */
export const SILENCE_FIRST_MIN = 30;
/** After a round from the silence, the next after this long without progress. */
export const SILENCE_REPEAT_MIN = 10;
/** No progress for this long: the team is stalled, whether or not a round reached the lead. */
export const STALL_AFTER_MIN = 60;

export const SILENCE_FIRST_MS = SILENCE_FIRST_MIN * TEAM_MINUTE_MS;
export const SILENCE_REPEAT_MS = SILENCE_REPEAT_MIN * TEAM_MINUTE_MS;
export const STALL_AFTER_MS = STALL_AFTER_MIN * TEAM_MINUTE_MS;

/** The round clock looks this many times per repeat silence, and never more often than every ROUND_CHECK_MIN_MS. */
export const ROUND_CHECKS_PER_REPEAT = 10;
export const ROUND_CHECK_MIN_MS = 50;
/** How often a team's round clock looks; a round is at most this late. */
export const ROUND_CHECK_MS = Math.max(ROUND_CHECK_MIN_MS, Math.round(SILENCE_REPEAT_MS / ROUND_CHECKS_PER_REPEAT));
/** A due round may come this much early on its period: the clock only looks every ROUND_CHECK_MS. */
export const ROUND_SLACK_MS = ROUND_CHECK_MS / 2;

/** How long a role must sit on a screen waiting for the user before it counts: a short prompt is not a block. Wall-clock
 *  minutes, not cadence ones; AYA_E2E_TEAM_BLOCKED_MS shortens it. */
export const BLOCKED_AFTER_MS = Number(process.env.AYA_E2E_TEAM_BLOCKED_MS) || 2 * 60_000;

/** Local HH:MM of an ISO time, as team messages and status lines show it. */
export function clock(iso: string): string {
  const time = new Date(iso);
  return `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
}
