// Pure reducer: given the current terminal-state map and an incoming PtyEvent,
// produce the next map. Extracted from usePtyEventRouter so the state-machine
// can be tested without standing up React or jsdom.
//
// The reducer never mutates the input. If the event would not change anything
// (unknown ptyId, exited terminal, equal status/bell after recompute), it
// returns the same map reference so React's shallow check can skip a re-render.

import { detectApproval, looksBusy } from "./bell";
import type { PtyEvent, TerminalState } from "./types";

export function applyPtyEvent(
  prev: Record<string, TerminalState>,
  event: PtyEvent,
): Record<string, TerminalState> {
  if (event.type === "spawn-failed") {
    const t = prev[event.ptyId];
    if (!t) return prev;
    return {
      ...prev,
      [event.ptyId]: {
        ...t,
        status: "error",
        bell: false,
        spawnFailure: { reason: event.reason, detail: event.detail },
      },
    };
  }

  if (event.type === "exit") {
    const t = prev[event.ptyId];
    if (!t) return prev;
    return {
      ...prev,
      [event.ptyId]: {
        ...t,
        status: event.exitCode === 0 ? "idle" : "error",
        bell: false,
        exitCode: event.exitCode,
      },
    };
  }

  // event.type === "data"
  const t = prev[event.ptyId];
  if (!t) return prev;
  // Exited terminals should not flicker back to "running" from late chunks
  // (e.g. final newline after exit).
  if (t.exitCode !== null) return prev;

  const isApproval = detectApproval(event.chunk);
  const busy = looksBusy(event.chunk);
  let status = t.status;
  let bell = t.bell;
  if (isApproval) {
    status = "waiting";
    bell = true;
  } else if (busy && t.status === "waiting") {
    // The agent resumed work after the user approved: clear the bell.
    status = "running";
    bell = false;
  } else if (t.status !== "waiting") {
    // Any other output while not waiting means the terminal is running.
    status = "running";
  }
  if (status === t.status && bell === t.bell) return prev;
  return {
    ...prev,
    [event.ptyId]: { ...t, status, bell },
  };
}

/** True if the event should update the lastActivity timestamp for its ptyId.
 *  spawn-failed and exit are terminal lifecycle events, not activity. */
export function eventTouchesActivity(event: PtyEvent): boolean {
  return event.type === "data";
}
