import type { ProjectConfig, TerminalState } from "../types";

interface GitInfo {
  branch: string | null;
  dirty: number;
}

interface Props {
  project: ProjectConfig | null;
  git: GitInfo | null;
  terminal: TerminalState | null;
  attentionCount: number;
  onOpenProjectDirectory: (directory: string) => void;
  onOpenAttentionCenter: () => void;
}

export function StatusBar({
  project,
  git,
  terminal,
  attentionCount,
  onOpenProjectDirectory,
  onOpenAttentionCenter,
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
      <button
        className={`aya-statusbar-item aya-statusbar-button ${
          attentionCount > 0 ? "aya-statusbar-item--warn" : ""
        }`}
        type="button"
        title="Open attention center"
        onClick={onOpenAttentionCenter}
      >
        <span style={{ fontFamily: "Material Symbols Outlined", fontSize: 13 }}>
          notifications_active
        </span>
        {attentionCount > 0 ? `${attentionCount} attention` : "activity"}
      </button>
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
