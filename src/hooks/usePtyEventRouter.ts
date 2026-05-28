import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { applyPtyEvent, eventTouchesActivity } from "../pty-event-reducer";
import type { PtyEvent, TerminalState } from "../types";

interface Options {
  lastActivityRef: MutableRefObject<Record<string, number>>;
  setTerminals: Dispatch<SetStateAction<Record<string, TerminalState>>>;
  onPtyEvent?: (event: PtyEvent) => void;
}

export function usePtyEventRouter({
  lastActivityRef,
  setTerminals,
  onPtyEvent,
}: Options): void {
  useEffect(() => {
    return window.aya.onPtyEvent((event) => {
      onPtyEvent?.(event);
      if (eventTouchesActivity(event)) {
        lastActivityRef.current[event.ptyId] = Date.now();
      }
      setTerminals((prev) => applyPtyEvent(prev, event));
    });
  }, [lastActivityRef, onPtyEvent, setTerminals]);
}
