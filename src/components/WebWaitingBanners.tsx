import { useEffect, useMemo, useState } from "react";
import type { ProjectConfig, TerminalState } from "../types";

interface Props {
  projects: ProjectConfig[];
  terminals: Record<string, TerminalState>;
  activeProjectId: string | null;
  activeTerminalId: string | null;
  onSelectTerminal: (projectSlug: string, terminalId: string) => void;
}

/** In-page waiting alerts for Aya Web, which remains available over plain HTTP. */
export function WebWaitingBanners({
  projects,
  terminals,
  activeProjectId,
  activeTerminalId,
  onSelectTerminal,
}: Props) {
  const isWeb = typeof document !== "undefined" && document.documentElement.dataset.ayaWeb === "true";
  const waiting = useMemo(
    () => Object.values(terminals).filter((terminal) => terminal.bell),
    [terminals],
  );
  const waitingIds = waiting.map((terminal) => terminal.id).sort().join("\n");
  const [dismissedIds, setDismissedIds] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    const liveIds = new Set(waitingIds.split("\n").filter(Boolean));
    setDismissedIds((current) => {
      const next = new Set([...current].filter((id) => liveIds.has(id)));
      if (next.size === current.size && [...next].every((id) => current.has(id))) return current;
      return next;
    });
  }, [waitingIds]);

  useEffect(() => {
    if (!isWeb) return;
    const originalTitle = document.title;
    document.title = waiting.length > 0 ? `(${waiting.length}) Aya` : "Aya";
    return () => {
      document.title = originalTitle;
    };
  }, [isWeb, waiting.length]);

  if (!isWeb) return null;
  const visible = waiting.filter((terminal) =>
    !dismissedIds.has(terminal.id) &&
    !(terminal.id === activeTerminalId && terminal.projectSlug === activeProjectId),
  );
  if (visible.length === 0) return null;

  const projectNames = new Map(projects.map((project) => [project.slug, project.name]));
  return (
    <div className="aya-web-waiting-banners" role="status" aria-live="polite" aria-label="Waiting panes">
      {visible.map((terminal) => {
        const projectName = projectNames.get(terminal.projectSlug);
        const label = `${terminal.name} is waiting${projectName ? ` in ${projectName}` : ""}`;
        return (
          <button
            className="aya-web-waiting-banner"
            key={terminal.id}
            type="button"
            onClick={() => {
              setDismissedIds((current) => new Set(current).add(terminal.id));
              onSelectTerminal(terminal.projectSlug, terminal.id);
            }}
          >
            <span>{label}</span>
            <span className="aya-web-waiting-banner-action">View pane</span>
          </button>
        );
      })}
    </div>
  );
}
