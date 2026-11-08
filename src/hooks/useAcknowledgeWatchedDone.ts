import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import { clearedTerminalStatus } from "../pty-event-reducer";
import { doneToAcknowledge } from "../terminal-seen";
import type { TerminalState } from "../types";

/** The terminal the user is looking at, in a focused window, does not keep a "done" badge for work they watched finish. */
export function useAcknowledgeWatchedDone(
  terminals: Record<string, TerminalState>,
  activeTerminalId: string | null | undefined,
  setTerminals: Dispatch<SetStateAction<Record<string, TerminalState>>>,
): void {
  useEffect(() => {
    const acknowledge = () => {
      const id = doneToAcknowledge(terminals, activeTerminalId, document.hasFocus());
      if (id) setTerminals((prev) => (prev[id]?.externalStatus?.level === "done" ? { ...prev, [id]: clearedTerminalStatus(prev[id]) } : prev));
    };
    acknowledge();
    window.addEventListener("focus", acknowledge);
    return () => window.removeEventListener("focus", acknowledge);
  }, [terminals, activeTerminalId, setTerminals]);
}
