// Pure reducer: given the current terminal-state map and an incoming PtyEvent,
// produce the next map. Extracted from usePtyEventRouter so the state-machine
// can be tested without standing up React or jsdom.
//
// The reducer never mutates the input. If the event would not change anything
// (unknown ptyId, exited terminal, equal status/bell after recompute), it
// returns the same map reference so React's shallow check can skip a re-render.

import { detectApproval, looksBusy } from "./bell";
import type { ControlStatusLevel, PtyEvent, TerminalState, TerminalStatus } from "./types";

/** Map an agent-reported status level — from the control socket or an inline
 *  OSC 9001 `aya.status` sequence (integrations.md) — to the terminal's
 *  status field. Shared so both transports drive identical UI. */
export function controlLevelToTerminalStatus(
  level: ControlStatusLevel,
): TerminalStatus {
  if (level === "waiting") return "waiting";
  if (level === "done") return "idle";
  if (level === "error") return "error";
  return "running";
}

/** Project-event-log title for an agent-reported status. Shared by the
 *  control-socket effect (App.tsx) and the OSC 9001 path so the activity feed
 *  reads identically regardless of which transport delivered the update. */
export function controlStatusEventTitle(
  terminalName: string,
  level: ControlStatusLevel,
): string {
  if (level === "waiting") return `${terminalName} is waiting`;
  if (level === "done") return `${terminalName} finished`;
  if (level === "error") return `${terminalName} reported an error`;
  return `${terminalName} updated status`;
}

/** True once a terminal has finished a real task and gone idle — either
 *  explicitly reported ("done") or inferred from a clean exit on the PTY
 *  lifecycle. Excludes plain shells, which sit idle at rest and would
 *  otherwise read as "done" after every command. Shared by the project-badge
 *  computation (App.tsx) and the completion sound so both agree on what
 *  counts as finished. */
export function isTerminalDone(
  t: Pick<TerminalState, "externalStatus" | "status" | "exitCode" | "presetId">,
): boolean {
  return (
    t.externalStatus?.level === "done" ||
    (t.status === "idle" && t.exitCode === 0 && t.presetId !== "shell")
  );
}

/** The PTY-lifecycle status of a terminal, ignoring any agent-reported overlay.
 *  Single source of truth for "what colour is this terminal from its process
 *  alone": a spawn failure or a non-zero exit is an "error"; a live or
 *  cleanly-exited process is "idle" (the data branch below promotes idle ->
 *  running on the next output). Shared with App.tsx's control-status "clear"
 *  handler so clearing the agent overlay falls back to this same truth (#34). */
export function deriveLifecycleStatus(t: {
  spawnFailure?: TerminalState["spawnFailure"];
  exitCode: number | null;
}): TerminalStatus {
  if (t.spawnFailure) return "error";
  return t.exitCode === null || t.exitCode === 0 ? "idle" : "error";
}

/** Drop the agent-reported status overlay and fall back to PTY-lifecycle truth.
 *  Shared by the control-socket `clear` and by the user clicking the status dot
 *  to dismiss a stuck status (#34). A real PTY condition (spawn failure /
 *  non-zero exit) is preserved by deriveLifecycleStatus, so it cannot be
 *  dismissed this way - only an agent overlay can. */
export function clearedTerminalStatus(terminal: TerminalState): TerminalState {
  const { externalStatus, ...rest } = terminal;
  return {
    ...rest,
    status: deriveLifecycleStatus(rest),
    bell: externalStatus?.level === "waiting" ? false : terminal.bell,
  };
}

export function applyPtyEvent(
  prev: Record<string, TerminalState>,
  event: PtyEvent,
): Record<string, TerminalState> {
  if (event.type === "spawn-failed") {
    const t = prev[event.ptyId];
    if (!t) return prev;
    const next = {
      ...t,
      bell: false,
      spawnFailure: { reason: event.reason, detail: event.detail },
    };
    return {
      ...prev,
      [event.ptyId]: { ...next, status: deriveLifecycleStatus(next) },
    };
  }

  if (event.type === "exit") {
    const t = prev[event.ptyId];
    if (!t) return prev;
    const next = { ...t, bell: false, exitCode: event.exitCode };
    return {
      ...prev,
      [event.ptyId]: { ...next, status: deriveLifecycleStatus(next) },
    };
  }

  if (event.type === "no-session") {
    // Attach-only re-mount found no live PTY: mark the tab stopped/restartable
    // (like a host-restart) instead of letting it look running. exitCode stays
    // null so it never reads as a clean "done" finish.
    const t = prev[event.ptyId];
    if (!t) return prev;
    const next = { ...t, bell: false, stopped: true };
    return {
      ...prev,
      [event.ptyId]: { ...next, status: deriveLifecycleStatus(next) },
    };
  }

  if (event.type === "vt-status") {
    const t = prev[event.ptyId];
    if (!t || t.exitCode !== null) return prev;
    // An agent that reported its own status outranks anything inferred — but
    // only in the CLEARING direction. A blocked agent the user never notices
    // is the expensive failure, so inference may still raise the bell; it just
    // may not silence or downgrade what the agent said about itself.
    if (t.externalStatus && !event.waiting) return prev;
    const status = event.waiting ? "waiting" : "running";
    if (t.status === status && t.bell === event.waiting) return prev;
    return {
      ...prev,
      [event.ptyId]: { ...t, status, bell: event.waiting },
    };
  }

  if (event.type === "osc-session") {
    const t = prev[event.ptyId];
    if (!t || t.sessionId === event.sessionId) return prev;
    return {
      ...prev,
      [event.ptyId]: { ...t, sessionId: event.sessionId },
    };
  }

  if (event.type === "osc-status") {
    const t = prev[event.ptyId];
    if (!t) return prev;
    const text = event.text.trim();
    if (!text) return prev;
    return {
      ...prev,
      [event.ptyId]: {
        ...t,
        status: controlLevelToTerminalStatus(event.level),
        bell: event.level === "waiting",
        externalStatus: { level: event.level, text, updatedAt: event.updatedAt },
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
  // Same precedence rule as vt-status: this is the weakest signal, so it may
  // raise the bell but must never overwrite an agent's own report.
  if (t.externalStatus && !isApproval) return prev;
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
 *  spawn-failed and exit are terminal lifecycle events, not activity;
 *  osc-status is a genuine agent-driven signal, same as data. */
export function eventTouchesActivity(event: PtyEvent): boolean {
  return event.type === "data" || event.type === "osc-status";
}
