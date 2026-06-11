// Pure matcher: which terminal should a control-status update apply to?
// Extracted from App.tsx's onControlStatus handler so the precedence rules can
// be tested without React (same pattern as pty-event-reducer).

import type { ControlStatusUpdate, TerminalState } from "./types";

/** Resolve the target terminal for a control-status update.
 *
 *  An exact terminalId match always wins. bin/aya sends terminalId AND
 *  projectSlug AND cwd whenever the AYA_* env vars are present, and the
 *  slug/cwd match every sibling terminal in the project - a single-pass
 *  "any field matches" search let the project's first terminal shadow the
 *  real sender, so per-terminal statuses always landed on the first tab (#40).
 *
 *  projectSlug/cwd remain as fallbacks for senders without AYA_TERMINAL_ID
 *  (e.g. `aya status` run from a plain shell in the project directory). */
export function findStatusTarget(
  terminals: Record<string, TerminalState>,
  update: Pick<ControlStatusUpdate, "terminalId" | "projectSlug" | "cwd">,
): [string, TerminalState] | undefined {
  const entries = Object.entries(terminals);
  if (update.terminalId) {
    const exact = entries.find(([, t]) => t.id === update.terminalId);
    if (exact) return exact;
  }
  return entries.find(
    ([, t]) =>
      (update.projectSlug !== undefined &&
        t.projectSlug === update.projectSlug) ||
      (update.cwd !== undefined && t.cwd === update.cwd),
  );
}
