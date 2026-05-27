import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { detectApproval, looksBusy } from "../bell";
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
      if (event.type === "spawn-failed") {
        setTerminals((prev) => {
          const t = prev[event.ptyId];
          if (!t) return prev;
          return {
            ...prev,
            [event.ptyId]: {
              ...t,
              status: "error",
              bell: false,
              spawnFailure: {
                reason: event.reason,
                detail: event.detail,
              },
            },
          };
        });
        return;
      }

      if (event.type === "exit") {
        setTerminals((prev) => {
          const t = prev[event.ptyId];
          if (!t) return prev;
          const status = event.exitCode === 0 ? "idle" : "error";
          return {
            ...prev,
            [event.ptyId]: {
              ...t,
              status,
              bell: false,
              exitCode: event.exitCode,
            },
          };
        });
        return;
      }

      lastActivityRef.current[event.ptyId] = Date.now();
      const isApproval = detectApproval(event.chunk);
      const busy = looksBusy(event.chunk);
      setTerminals((prev) => {
        const t = prev[event.ptyId];
        if (!t) return prev;
        if (t.exitCode !== null) return prev;
        let status = t.status;
        let bell = t.bell;
        if (isApproval) {
          status = "waiting";
          bell = true;
        } else if (busy && t.status === "waiting") {
          status = "running";
          bell = false;
        } else if (t.status !== "waiting") {
          status = "running";
        }
        if (status === t.status && bell === t.bell) return prev;
        return {
          ...prev,
          [event.ptyId]: {
            ...t,
            status,
            bell,
          },
        };
      });
    });
  }, [lastActivityRef, onPtyEvent, setTerminals]);
}
