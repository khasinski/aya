import type { ProjectConfig, ProjectEvent, TerminalState } from "../types";
import { closeFromBackdropClick, markBackdropMouseDown } from "./modal-backdrop";

// Max number of recent events shown in the attention center.
const VISIBLE_EVENTS_LIMIT = 18;

interface Props {
  projects: ProjectConfig[];
  terminals: Record<string, TerminalState>;
  events: ProjectEvent[];
  onSelectTerminal: (projectSlug: string, terminalId: string) => void;
  onRestartTerminal: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
  onClose: () => void;
}

interface AttentionRow {
  project: ProjectConfig;
  terminal: TerminalState;
  level: "waiting" | "error" | "done" | "idle";
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
  if (
    terminal.status === "idle" ||
    terminal.stopped ||
    (terminal.exitCode !== null && terminal.exitCode !== 0)
  ) {
    return {
      project,
      terminal,
      level: "idle",
      title: `${terminal.name} is idle`,
      detail:
        terminal.stopped
          ? "Stopped by PTY host restart"
          : terminal.exitCode !== null
            ? `Exited with code ${terminal.exitCode}`
            : "No active process",
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
  onRestartTerminal,
  onCloseTerminal,
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
      const rank = { error: 4, waiting: 3, done: 2, idle: 1 };
      return rank[b.level] - rank[a.level] || a.project.name.localeCompare(b.project.name);
    });
  const groupedRows = {
    error: rows.filter((row) => row.level === "error"),
    waiting: rows.filter((row) => row.level === "waiting"),
    done: rows.filter((row) => row.level === "done"),
    idle: rows.filter((row) => row.level === "idle"),
  };
  const visibleEvents = events.slice(0, VISIBLE_EVENTS_LIMIT);
  const rowGroups: Array<{
    id: AttentionRow["level"];
    title: string;
    rows: AttentionRow[];
  }> = [
    { id: "error", title: "Failed", rows: groupedRows.error },
    { id: "waiting", title: "Waiting", rows: groupedRows.waiting },
    { id: "done", title: "Finished", rows: groupedRows.done },
    { id: "idle", title: "Idle", rows: groupedRows.idle },
  ];

  const focus = (row: AttentionRow) => {
    onSelectTerminal(row.project.slug, row.terminal.id);
    onClose();
  };

  return (
    <div
      className="aya-modal-backdrop"
      role="presentation"
      onMouseDown={markBackdropMouseDown}
      onClick={(e) => closeFromBackdropClick(e, onClose)}
    >
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
                {rowGroups.map((group) =>
                  group.rows.length === 0 ? null : (
                    <div className="aya-attention-group" key={group.id}>
                      <div className="aya-attention-group-title">
                        {group.title}
                        <span>{group.rows.length}</span>
                      </div>
                      {group.rows.map((row) => (
                        <div
                          key={row.terminal.id}
                          className={`aya-attention-row aya-attention-row--${row.level}`}
                        >
                          <span className="aya-attention-dot" />
                          <span className="aya-attention-row-main">
                            <strong>{row.title}</strong>
                            <span>{row.project.name} · {row.detail}</span>
                          </span>
                          <span className="aya-attention-row-actions">
                            <button type="button" onClick={() => focus(row)}>
                              Focus
                            </button>
                            <button
                              type="button"
                              onClick={() => onRestartTerminal(row.terminal.id)}
                            >
                              Restart
                            </button>
                            <button
                              type="button"
                              onClick={() => onCloseTerminal(row.terminal.id)}
                            >
                              Close
                            </button>
                          </span>
                        </div>
                      ))}
                    </div>
                  ),
                )}
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
