import type { ProjectConfig, TerminalState } from "../types";

interface GitInfo {
  branch: string | null;
  dirty: number;
}

interface Props {
  project: ProjectConfig | null;
  git: GitInfo | null;
  terminal: TerminalState | null;
}

export function StatusBar({ project, git, terminal }: Props) {
  const waiting = terminal?.status === "waiting";
  return (
    <footer className="aya-statusbar">
      {project && (
        <span className="aya-statusbar-item">
          <span style={{ fontFamily: "Material Symbols Outlined", fontSize: 13 }}>
            folder
          </span>
          {project.directory}
        </span>
      )}
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
      <div className="aya-statusbar-spacer" />
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
      <span className="aya-statusbar-item">UTF-8</span>
    </footer>
  );
}
