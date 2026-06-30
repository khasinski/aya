import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { applyPtyEvent, eventTouchesActivity } from "../pty-event-reducer";
import { markSpawned } from "../spawnSession";
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
      setTerminals((prev) => {
        // Mark a CONFIRMED live session only on genuine live output, so a later
        // re-mount attaches (and surfaces "stopped" if the process is gone).
        // Skip when the terminal: is spawn-failed (the synthetic failure banner
        // is also a data event but no PTY exists), has already exited (a
        // straggler chunk after a kill must not re-mark), or is gone (closed).
        // Set.add is idempotent, so running inside the updater is safe.
        const t = prev[event.ptyId];
        if (event.type === "data" && t && !t.spawnFailure && t.exitCode === null) {
          markSpawned(event.ptyId);
        }
        return applyPtyEvent(prev, event);
      });
    });
  }, [lastActivityRef, onPtyEvent, setTerminals]);
}
