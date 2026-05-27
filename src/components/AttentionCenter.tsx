import type { ProjectConfig, ProjectEvent, TerminalState } from "../types";

interface Props {
  projects: ProjectConfig[];
  terminals: Record<string, TerminalState>;
  events: ProjectEvent[];
  onSelectTerminal: (projectSlug: string, terminalId: string) => void;
  onClose: () => void;
}

interface AttentionRow {
  project: ProjectConfig;
  terminal: TerminalState;
  level: "waiting" | "error" | "done";
  title: string;
  detail: string;
}

function attentionFor(
  project: ProjectConfig,
  terminal: TerminalState,
): AttentionRow | null {
  if (
    terminal.status === "error" ||
    terminal.externalStatus?.level === "error" ||
    terminal.spawnFailure
  ) {
    return {
      project,
      terminal,
      level: "error",
      title: `${terminal.name} needs recovery`,
      detail:
        terminal.externalStatus?.text ??
        terminal.spawnFailure?.detail ??
        (terminal.exitCode !== null
          ? `Exited with code ${terminal.exitCode}`
          : "Terminal is in an error state"),
    };
  }
  if (
    terminal.bell ||
    terminal.status === "waiting" ||
    terminal.externalStatus?.level === "waiting"
  ) {
    return {
      project,
      terminal,
      level: "waiting",
      title: `${terminal.name} is waiting`,
      detail: terminal.externalStatus?.text ?? "Approval or input needed",
    };
  }
  if (
    terminal.externalStatus?.level === "done" ||
    (terminal.status === "idle" && terminal.exitCode === 0 && terminal.presetId !== "shell")
  ) {
    return {
      project,
      terminal,
      level: "done",
      title: `${terminal.name} finished`,
      detail: terminal.externalStatus?.text ?? "Completed successfully",
    };
  }
  return null;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function AttentionCenter({
  projects,
  terminals,
  events,
  onSelectTerminal,
  onClose,
}: Props) {
  const projectBySlug = new Map(projects.map((project) => [project.slug, project]));
  const rows = Object.values(terminals)
    .map((terminal) => {
      const project = projectBySlug.get(terminal.projectSlug);
      return project ? attentionFor(project, terminal) : null;
    })
    .filter((row): row is AttentionRow => !!row)
    .sort((a, b) => {
      const rank = { error: 3, waiting: 2, done: 1 };
      return rank[b.level] - rank[a.level] || a.project.name.localeCompare(b.project.name);
    });
  const visibleEvents = events.slice(0, 18);

  return (
    <div className="aya-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="aya-attention-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Attention center"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="aya-attention-header">
          <div>
            <p className="aya-attention-eyebrow">Attention</p>
            <h2>Project activity</h2>
          </div>
          <button className="aya-iconbtn" type="button" title="Close" onClick={onClose}>
            <span style={{ fontFamily: "Material Symbols Outlined" }}>close</span>
          </button>
        </header>

        <div className="aya-attention-content">
          <section className="aya-attention-section">
            <h3>Needs a look</h3>
            {rows.length === 0 ? (
              <p className="aya-attention-empty">No waiting, failed, or completed agent terminals.</p>
            ) : (
              <div className="aya-attention-list">
                {rows.map((row) => (
                  <button
                    key={row.terminal.id}
                    className={`aya-attention-row aya-attention-row--${row.level}`}
                    type="button"
                    onClick={() => {
                      onSelectTerminal(row.project.slug, row.terminal.id);
                      onClose();
                    }}
                  >
                    <span className="aya-attention-dot" />
                    <span className="aya-attention-row-main">
                      <strong>{row.title}</strong>
                      <span>{row.project.name} · {row.detail}</span>
                    </span>
                    <span className="aya-attention-row-action">Focus</span>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="aya-attention-section">
            <h3>Recent timeline</h3>
            {visibleEvents.length === 0 ? (
              <p className="aya-attention-empty">No project events yet.</p>
            ) : (
              <div className="aya-timeline-list">
                {visibleEvents.map((event) => {
                  const project = projectBySlug.get(event.projectSlug);
                  return (
                    <button
                      key={event.id}
                      className={`aya-timeline-row aya-timeline-row--${event.level}`}
                      type="button"
                      onClick={() => {
                        if (event.terminalId) {
                          onSelectTerminal(event.projectSlug, event.terminalId);
                          onClose();
                        }
                      }}
                      disabled={!event.terminalId}
                    >
                      <span className="aya-timeline-time">{formatTime(event.createdAt)}</span>
                      <span className="aya-timeline-main">
                        <strong>{event.title}</strong>
                        <span>
                          {project?.name ?? event.projectSlug}
                          {event.detail ? ` · ${event.detail}` : ""}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </section>
    </div>
  );
}
