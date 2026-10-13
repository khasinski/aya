import { useCallback, useState, type RefObject } from "react";
import { prependProjectEvent, projectEventForPtyEvent, type ProjectEventInput } from "../project-timeline";
import type { ProjectEvent, PtyEvent, TerminalState } from "../types";
import { uuid } from "../uuid";

export function useProjectTimeline() {
  const [projectEvents, setProjectEvents] = useState<ProjectEvent[]>([]);

  const appendProjectEvent = useCallback(
    (event: ProjectEventInput) => {
      setProjectEvents((prev) => prependProjectEvent(prev, {
        ...event,
        id: uuid(),
        createdAt: event.createdAt ?? Date.now(),
      }));
    },
    [],
  );

  return { projectEvents, appendProjectEvent };
}

interface PtyTimelineEventsOptions {
  terminalsRef: RefObject<Record<string, TerminalState>>;
  rememberTerminalOutput: (terminalId: string, chunk: string) => void;
  appendProjectEvent: (event: ProjectEventInput) => void;
}

// Pass the shared ref and summary callback once App has declared them.
export function usePtyTimelineEvents({
  terminalsRef,
  rememberTerminalOutput,
  appendProjectEvent,
}: PtyTimelineEventsOptions) {
  const handlePtyTimelineEvent = useCallback(
    (event: PtyEvent) => {
      const terminal = terminalsRef.current[event.ptyId];
      if (!terminal) return;
      if (event.type === "data" && !event.replay) {
        rememberTerminalOutput(event.ptyId, event.chunk);
      }
      const projectEvent = projectEventForPtyEvent(event, terminal);
      if (projectEvent) appendProjectEvent(projectEvent);
    },
    [appendProjectEvent, rememberTerminalOutput, terminalsRef],
  );

  return { handlePtyTimelineEvent };
}
