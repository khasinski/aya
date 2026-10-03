// A team's files and how their records read. No I/O and no app imports: `aya team stats` loads this
// from the CLI with plain node, beside the app, and must read the files exactly as the team store does.

import { TEAM_SYSTEM_SENDER } from "./team-definition";
import type { TeamMessage } from "./types";

export const TEAM_FILES = {
  assignments: "assignments.json",
  state: "state.json",
  saved: "saved.md",
  log: "log.jsonl",
  read: "read.json",
  typing: "typing.json",
  progress: "progress.json",
  deliveryNotes: "delivery-notes.json",
  refused: "refused.jsonl",
} as const;

export const DEBUG_LOG_FILE = "debug.jsonl";
export const DEBUG_LOG_OLD_FILE = "debug.1.jsonl";

/** Why a logged message was not typed yet, or how it got to its receiver other than a plain paste: read with
 *  `aya team inbox`, or typed with its Enter withheld. */
export type DeliveryNote = { kind: "held"; reason: string } | { kind: "inbox" } | { kind: "withheld"; reason: string; afterEnter?: boolean };

/** Aya's own rounds and delivery tests go stale while held (a later one replaces them); anything else stays owed. */
export const goesStale = (m: Pick<TeamMessage, "from">): boolean => m.from === TEAM_SYSTEM_SENDER;

/** Not typed yet and past its receiver's read mark; owed unless it goesStale. */
export const unreadIn = (read: Record<string, number>) => (m: TeamMessage): boolean => !m.delivered && m.id > (read[m.to] ?? 0);

/** A logged message as the window shows it, from its log entry, delivery note and the receiver's read mark: held,
 *  reserved, written (at once, later, via the inbox) or typed without its Enter; a refused one is never logged. */
export function deliveryState(m: TeamMessage, note: DeliveryNote | undefined, readMark: number): TeamMessage {
  // Aya's own were marked read with the inbox, not printed: they stay held (stale).
  if (note?.kind === "inbox") return { ...m, viaInbox: true, ...(goesStale(m) ? {} : { delivered: true }) };
  if (note?.kind === "withheld") return { ...m, delivered: true, held: note.reason, typedOnly: true, ...(note.afterEnter ? { afterEnter: true } : {}) };
  // Taken for typing or typed later (the read mark passed it): it reached the pane.
  if (!m.delivered && !goesStale(m) && m.id <= readMark) return { ...m, delivered: true, ...(note?.kind === "held" ? { held: note.reason } : {}) };
  return note?.kind === "held" ? { ...m, held: note.reason } : m;
}
