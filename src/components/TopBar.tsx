import type { ProjectConfig } from "../types";

interface Props {
  projects: ProjectConfig[];
  activeProjectId: string | null;
  homeDir: string;
  isDev: boolean;
  onSelectProject: (slug: string) => void;
  onNewProject: () => void;
  /** Closes the project in the current session. Does NOT delete the JSON
   *  file — on restart, the project reopens. */
  onCloseProject: (slug: string) => void;
  onOpenSettings: () => void;
  projectBadges?: Record<string, number>;
}

function compactDir(directory: string, home: string): string {
  if (!directory) return "";
  if (!home) return directory;
  if (directory === home) return "~";
  if (directory.startsWith(home + "/")) return "~" + directory.slice(home.length);
  return directory;
}

export function TopBar({
  projects,
  activeProjectId,
  homeDir,
  isDev,
  onSelectProject,
  onNewProject,
  onCloseProject,
  onOpenSettings,
  projectBadges = {},
}: Props) {
  return (
    <header className="aya-topbar">
      <div className="aya-brand">
        <span
          className="aya-brand-dot"
          style={isDev ? { background: "#a371f7" } : undefined}
        />
        <span>{isDev ? "aya dev" : "aya"}</span>
      </div>
      <div className="aya-tabs">
        {projects.map((p) => {
          const isActive = p.slug === activeProjectId;
          const badge = projectBadges[p.slug] ?? 0;
          return (
            <div
              key={p.slug}
              className={`aya-tab ${isActive ? "aya-tab--active" : ""}`}
              onClick={() => onSelectProject(p.slug)}
              title={`${p.name} — ${p.directory}`}
            >
              <span className="aya-tab-name">{p.name}</span>
              <span className="aya-tab-path">{compactDir(p.directory, homeDir)}</span>
              {badge > 0 && <span className="aya-tab-badge">{badge}</span>}
              <span
                className="aya-tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseProject(p.slug);
                }}
                title={`Close this session — the project file stays in ~/.aya/projects/${p.slug}.json and reopens next launch`}
              >
                ×
              </span>
            </div>
          );
        })}
        <div className="aya-tab-new" title="New project" onClick={onNewProject}>
          ＋
        </div>
      </div>
      <div className="aya-topbar-right">
        <button
          className="aya-iconbtn"
          title="Settings"
          onClick={onOpenSettings}
        >
          <span style={{ fontFamily: "Material Symbols Outlined" }}>settings</span>
        </button>
      </div>
    </header>
  );
}
