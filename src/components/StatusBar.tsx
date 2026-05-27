import type { ProjectConfig, TerminalState } from "../types";

interface GitInfo {
  branch: string | null;
  dirty: number;
}

interface Props {
  project: ProjectConfig | null;
  git: GitInfo | null;
  terminal: TerminalState | null;
  onOpenProjectDirectory: (directory: string) => void;
}

export function StatusBar({
  project,
  git,
  terminal,
  onOpenProjectDirectory,
}: Props) {
  const waiting = terminal?.status === "waiting";
  const externalStatus = terminal?.externalStatus;
  return (
    <footer className="aya-statusbar">
      {project && (
        <button
          className="aya-statusbar-item aya-statusbar-button"
          type="button"
          title="Open project directory"
          onClick={() => onOpenProjectDirectory(project.directory)}
        >
          <span style={{ fontFamily: "Material Symbols Outlined", fontSize: 13 }}>
            folder
          </span>
          {project.directory}
        </button>
      )}
      {terminal && waiting && (
        <span className="aya-statusbar-item aya-statusbar-item--warn">
          <span
            style={{
              fontFamily: "Material Symbols Outlined",
              fontSize: 13,
              fontVariationSettings: '"FILL" 1',
            }}
          >
            notifications_active
          </span>
          {terminal.name} is waiting for your approval
        </span>
      )}
      {externalStatus && !waiting && (
        <span
          className={`aya-statusbar-item aya-statusbar-item--agent aya-statusbar-item--agent-${externalStatus.level}`}
          title={new Date(externalStatus.updatedAt).toLocaleString()}
        >
          <span style={{ fontFamily: "Material Symbols Outlined", fontSize: 13 }}>
            smart_toy
          </span>
          {externalStatus.text}
        </span>
      )}
      <div className="aya-statusbar-spacer" />
      {git?.branch && (
        <span className="aya-statusbar-item">
          <span style={{ fontFamily: "Material Symbols Outlined", fontSize: 13 }}>
            fork_right
          </span>
          {git.branch}
        </span>
      )}
      {git && git.dirty > 0 ? (
        <span className="aya-statusbar-item aya-statusbar-item--warn">
          <span style={{ fontFamily: "Material Symbols Outlined", fontSize: 13 }}>
            edit_note
          </span>
          {git.dirty} dirty
        </span>
      ) : git?.branch ? (
        <span
          className="aya-statusbar-item"
          style={{ color: "var(--status-active)" }}
        >
          <span style={{ fontFamily: "Material Symbols Outlined", fontSize: 13 }}>
            check_circle
          </span>
          clean
        </span>
      ) : null}
    </footer>
  );
}
