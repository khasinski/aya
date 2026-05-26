import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { ProjectConfig, TerminalState } from "../types";

export function useDockBadge(
  terminals: Record<string, TerminalState>,
): void {
  useEffect(() => {
    const waitingCount = Object.values(terminals).filter((t) => t.bell).length;
    void window.aya.setDockBadge(waitingCount > 0 ? String(waitingCount) : "");
  }, [terminals]);
}

interface NotificationOptions {
  projects: ProjectConfig[];
  terminals: Record<string, TerminalState>;
  setActiveProjectId: Dispatch<SetStateAction<string | null>>;
  setActiveTabByProject: Dispatch<SetStateAction<Record<string, string | null>>>;
}

export function useTerminalNotifications({
  projects,
  terminals,
  setActiveProjectId,
  setActiveTabByProject,
}: NotificationOptions): void {
  const prevBellRef = useRef<Record<string, boolean>>({});

  useEffect(() => {
    return window.aya.onTerminalNotificationSelect(
      ({ projectSlug, terminalId }) => {
        setActiveProjectId(projectSlug);
        setActiveTabByProject((p) => ({ ...p, [projectSlug]: terminalId }));
      },
    );
  }, [setActiveProjectId, setActiveTabByProject]);

  useEffect(() => {
    const prev = prevBellRef.current;
    const current: Record<string, boolean> = {};
    for (const [id, t] of Object.entries(terminals)) {
      current[id] = t.bell;
      const becameBell = t.bell && !prev[id];
      if (!becameBell) continue;
      if (typeof document !== "undefined" && document.hasFocus()) continue;
      const project = projects.find((p) => p.slug === t.projectSlug);
      void window.aya.showWaitingNotification({
        projectSlug: t.projectSlug,
        terminalId: id,
        body: project ? `${t.name} in ${project.name}` : t.name,
      });
    }
    prevBellRef.current = current;
  }, [projects, terminals]);
}

interface RecentActivity {
  lastActivityRef: MutableRefObject<Record<string, number>>;
  recentlyActiveIds: Set<string>;
}

export function useRecentTerminalActivity(): RecentActivity {
  const lastActivityRef = useRef<Record<string, number>>({});
  const [activityTick, setActivityTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setActivityTick((t) => t + 1), 800);
    return () => clearInterval(id);
  }, []);

  const activityWindowMs = 3000;
  const now = Date.now();
  const recentlyActiveIds = new Set<string>();
  for (const [tid, ts] of Object.entries(lastActivityRef.current)) {
    if (now - ts < activityWindowMs) recentlyActiveIds.add(tid);
  }
  void activityTick;

  return { lastActivityRef, recentlyActiveIds };
}
