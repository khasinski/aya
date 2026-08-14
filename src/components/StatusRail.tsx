import { attentionRows, isActionableLevel } from "../attention";
import type { ProjectConfig, TerminalState } from "../types";

interface Props {
  projects: ProjectConfig[];
  terminals: Record<string, TerminalState>;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onSelectTerminal: (projectSlug: string, terminalId: string) => void;
}

/** Always-on strip of the terminals that are blocked or broken, across every
 *  open project. The attention center shows the same triage in more depth, but
 *  only when opened — so a pane waiting inside a project you aren't looking at
 *  stayed invisible until you went hunting for it. */
export function StatusRail({
  projects,
  terminals,
  collapsed,
  onCollapsedChange,
  onSelectTerminal,
}: Props) {
  const rows = attentionRows(projects, terminals).filter((row) =>
    isActionableLevel(row.level),
  );
  if (rows.length === 0) return null;

  const waiting = rows.filter((row) => row.level === "waiting").length;
  const failed = rows.length - waiting;

  return (
    <aside
      className={`aya-status-rail ${collapsed ? "aya-status-rail--collapsed" : ""}`}
      aria-label="Terminals needing attention"
    >
      <button
        type="button"
        className="aya-status-rail-toggle"
        aria-expanded={!collapsed}
        onClick={() => onCollapsedChange(!collapsed)}
      >
        <span className="aya-status-rail-counts">
          {waiting > 0 && (
            <span className="aya-status-rail-count aya-status-rail-count--waiting">
              {waiting} waiting
            </span>
          )}
          {failed > 0 && (
            <span className="aya-status-rail-count aya-status-rail-count--error">
              {failed} failed
            </span>
          )}
        </span>
        <span
          className="aya-status-rail-chevron"
          style={{ fontFamily: "Material Symbols Outlined" }}
          aria-hidden="true"
        >
          {collapsed ? "expand_less" : "expand_more"}
        </span>
      </button>
      {!collapsed && (
        <div className="aya-status-rail-list">
          {rows.map((row) => (
            <button
              key={row.terminal.id}
              type="button"
              className={`aya-status-rail-row aya-status-rail-row--${row.level}`}
              onClick={() => onSelectTerminal(row.project.slug, row.terminal.id)}
              title={`${row.title} — ${row.detail}`}
            >
              <span className="aya-status-rail-dot" aria-hidden="true" />
              <span className="aya-status-rail-name">{row.terminal.name}</span>
              <span className="aya-status-rail-project">{row.project.name}</span>
              <span className="aya-status-rail-detail">{row.detail}</span>
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}
