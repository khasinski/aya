import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { ProjectConfig, TerminalState } from "../types";

// Poll interval (ms) for ticking recent-activity recomputation.
const ACTIVITY_TICK_INTERVAL_MS = 800;
// A terminal counts as "recently active" for this long after its last output.
const ACTIVITY_WINDOW_MS = 3000;
// Stable empty-set reference so an idle app keeps handing memoized children the
// same prop (a fresh `new Set()` each tick would defeat their memoization).
const EMPTY_ACTIVE_IDS: ReadonlySet<string> = new Set<string>();

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
  recentlyActiveIds: ReadonlySet<string>;
}

export function useRecentTerminalActivity(): RecentActivity {
  const lastActivityRef = useRef<Record<string, number>>({});
  const [recentlyActiveIds, setRecentlyActiveIds] =
    useState<ReadonlySet<string>>(EMPTY_ACTIVE_IDS);
  // Sorted-id signature of the current set; we only re-render when it changes.
  const keyRef = useRef("");

  useEffect(() => {
    const recompute = () => {
      const now = Date.now();
      const ids: string[] = [];
      for (const [tid, ts] of Object.entries(lastActivityRef.current)) {
        if (now - ts < ACTIVITY_WINDOW_MS) ids.push(tid);
      }
      ids.sort();
      const key = ids.join("\n");
      if (key === keyRef.current) return; // membership unchanged — no re-render
      keyRef.current = key;
      setRecentlyActiveIds(ids.length === 0 ? EMPTY_ACTIVE_IDS : new Set(ids));
    };
    const id = setInterval(recompute, ACTIVITY_TICK_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  return { lastActivityRef, recentlyActiveIds };
}
