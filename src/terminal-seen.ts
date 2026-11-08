// A finished agent is "done, not yet seen" until the user looks. The terminal in front of a focused window is
// being looked at, so its done is born seen; any other keeps it until it is visited (useTerminalActions) or the
// window comes back to it.
import type { TerminalState } from "./types";
import { isWatchingTerminal } from "./terminal-sound-prefs";

export function doneToAcknowledge(
  terminals: Record<string, Pick<TerminalState, "externalStatus" | "status">>,
  activeTerminalId: string | null | undefined,
  windowFocused: boolean,
): string | null {
  if (!activeTerminalId || !isWatchingTerminal(activeTerminalId, activeTerminalId, windowFocused)) return null;
  const t = terminals[activeTerminalId];
  return t?.externalStatus?.level === "done" && t.status !== "waiting" ? activeTerminalId : null;
}
