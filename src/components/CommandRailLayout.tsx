import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { CLAUDE_BRAND_COLOR, CODEX_BRAND_COLOR } from "../colors";
import { useDragReorder } from "../hooks/useDragReorder";
import type { ProjectConfig, TeamSummary, UsageAccount } from "../types";
import type { SettingsTab } from "../settings-tabs";
import { unreadTotal } from "../team-view";
import { averageUsagePct, UsageChip } from "./UsageChip";
import { LinuxWindowControls, MacWindowControls } from "./WindowControls";
import { compactDir } from "../project-path";
import { RecentProjectsMenu } from "./RecentProjectsMenu";
import { moveItem } from "../keyboard-navigation";
import { ProjectContextMenu } from "./ProjectContextMenu";

interface ProjectAttention {
  count: number;
  level: "active" | "done" | "waiting" | "error";
}

const NO_TEAMS_BY_PROJECT: Record<string, TeamSummary[]> = {};

function projectPath(project: ProjectConfig, home: string): string {
  return project.remote
    ? `${project.remote.label}:${project.remote.directory}`
    : compactDir(project.directory, home);
}

function initial(name: string): string {
  return (name.trim().charAt(0) || "?").toUpperCase();
}

interface Props {
  projects: ProjectConfig[];
  closedProjects: ProjectConfig[];
  activeProjectId: string | null;
  homeDir: string;
  isDev: boolean;
  platform: NodeJS.Platform;
  isFullScreen: boolean;
  isMaximized: boolean;
  blockChrome: boolean;
  onSelectProject: (slug: string) => void;
  onOpenProject: (slug: string) => void;
  onNewProject: () => void;
  onCloseProject: (slug: string) => void;
  /** Multi-window: move a project (with its running terminals) to a new
   *  window or an existing one. Absent = the menu items are hidden. */
  onMoveProjectToWindow?: (
    slug: string,
    target: number | "new",
    at?: { x: number; y: number },
  ) => void;
  onReorderProjects: (orderedSlugs: string[]) => void;
  onOpenSearch: () => void;
  onOpenSettings: (tab?: SettingsTab) => void;
  onMinimizeWindow: () => void;
  onToggleMaximizeWindow: () => void;
  onToggleFullScreenWindow: () => void;
  onCloseWindow: () => void;
  projectBadges?: Record<string, ProjectAttention>;
  projectSummaries?: Record<string, string>;
  teamsByProject?: Record<string, TeamSummary[]>;
  /** The terminal list column (App's Sidebar, with the command-rail header,
   *  projects and usage sections mixed in). */
  sidebar: ReactNode;
  sidebarWidth: number;
  /** The terminal panes. */
  panes: ReactNode;
  /** Loading / empty state; replaces the sidebar + panes while set. */
  body: ReactNode;
  activeProjectName?: string;
  activeTerminalName?: string;
}

/** "Command Rail" window layout: a narrow rail of project avatars, a column
 *  with the project's terminals / other projects / usage, a breadcrumb over
 *  the panes. The chrome selected by Settings > Interface style, replacing
 *  both classic layouts. */
function CommandRailLayoutImpl({
  projects,
  closedProjects,
  activeProjectId,
  homeDir,
  isDev,
  platform,
  isFullScreen,
  isMaximized,
  blockChrome,
  onSelectProject,
  onOpenProject,
  onNewProject,
  onCloseProject,
  onMoveProjectToWindow,
  onReorderProjects,
  onOpenSearch,
  onOpenSettings,
  onMinimizeWindow,
  onToggleMaximizeWindow,
  onToggleFullScreenWindow,
  onCloseWindow,
  projectBadges = {},
  projectSummaries = {},
  teamsByProject = NO_TEAMS_BY_PROJECT,
  sidebar,
  sidebarWidth,
  panes,
  body,
  activeProjectName,
  activeTerminalName,
}: Props) {
  const {
    dragId: dragSlug,
    dropTarget: projectDrop,
    itemHandlers: projectDragHandlers,
  } = useDragReorder(
    "y",
    projects.map((p) => p.slug),
    onReorderProjects,
    // Chrome-style tear-out: an avatar released outside the rail attaches to
    // the window under the cursor or opens a new one (see TopBar).
    (slug, e) => {
      if (!onMoveProjectToWindow) return;
      const project = projects.find((pr) => pr.slug === slug);
      if (!project || project.remote) return;
      const at = { x: e.screenX, y: e.screenY };
      void window.aya.resolveProjectDrop(at.x, at.y).then((r) => {
        if (r.kind === "self") return;
        onMoveProjectToWindow(slug, r.kind === "new" ? "new" : r.id, at);
      });
    },
  );

  const [projectMenu, setProjectMenu] = useState<{
    x: number;
    y: number;
    slug: string;
    remote: boolean;
    windows: Array<{ id: number; activeProject: string | null }>;
  } | null>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (projectMenu) projectMenuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [projectMenu]);
  useEffect(() => {
    if (!projectMenu) return;
    const close = () => setProjectMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setProjectMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [projectMenu]);

  const openMenu = (e: React.MouseEvent, project: ProjectConfig) => {
    e.preventDefault();
    const at = { x: e.clientX, y: e.clientY };
    const remote = !!project.remote;
    if (remote || !onMoveProjectToWindow) {
      setProjectMenu({ ...at, slug: project.slug, remote, windows: [] });
      return;
    }
    void window.aya.listOtherWindows().then((windows) => {
      setProjectMenu({ ...at, slug: project.slug, remote, windows });
    });
  };

  return (
    <div className="aya-cr">
      <nav className="aya-cr-rail" aria-label="Projects">
        <div className="aya-cr-rail-controls">
          <MacWindowControls
            platform={platform}
            isFullScreen={isFullScreen}
            onClose={onCloseWindow}
            onMinimize={onMinimizeWindow}
            onToggleFullScreen={onToggleFullScreenWindow}
          />
        </div>
        <div className="aya-cr-rail-list">
          {projects.map((p) => {
            const badge = projectBadges[p.slug];
            const summary = projectSummaries[p.slug]?.trim();
            const teamUnread = unreadTotal(teamsByProject[p.slug] ?? []);
            const drop = projectDrop?.id === p.slug
              ? projectDrop.before
                ? "aya-cr-avatar--drop-before"
                : "aya-cr-avatar--drop-after"
              : "";
            return (
              <button
                key={p.slug}
                type="button"
                data-testid="railtab"
                className={`aya-cr-avatar ${
                  p.slug === activeProjectId ? "aya-cr-avatar--active" : ""
                } ${dragSlug === p.slug ? "aya-cr-avatar--dragging" : ""} ${
                  p.remote ? "aya-cr-avatar--remote" : ""
                } ${drop}`}
                draggable
                {...projectDragHandlers(p.slug)}
                onClick={() => onSelectProject(p.slug)}
                onContextMenu={(e) => openMenu(e, p)}
                title={`${p.name} - ${projectPath(p, homeDir)}${summary ? ` · ${summary}` : ""}`}
                aria-label={p.name}
              >
                {initial(p.name)}
                {(badge || teamUnread > 0) && (
                  <span
                    className={`aya-cr-avatar-dot aya-cr-avatar-dot--${badge?.level ?? "waiting"}`}
                    title={
                      badge
                        ? `${badge.count} monitored session${badge.count > 1 ? "s" : ""}: ${badge.level}`
                        : `${p.name} team messages waiting`
                    }
                  />
                )}
              </button>
            );
          })}
          <button
            type="button"
            className="aya-cr-rail-btn aya-cr-rail-btn--new"
            title="New project"
            aria-label="New project"
            onClick={blockChrome ? undefined : onNewProject}
            aria-disabled={blockChrome}
          >
            <span style={{ fontFamily: "Material Symbols Outlined" }}>add</span>
          </button>
        </div>
        <div className="aya-cr-rail-foot">
          <RecentProjectsMenu
            closedProjects={closedProjects}
            homeDir={homeDir}
            blockChrome={blockChrome}
            onOpenProject={onOpenProject}
            buttonClassName="aya-cr-rail-btn"
            menuClassName="aya-cr-recent-menu"
          />
          <button
            type="button"
            className="aya-cr-rail-btn"
            title={blockChrome ? "Search (close the open dialog first)" : "Search (Cmd/Ctrl+K or Shift Shift)"}
            aria-label="Search"
            onClick={onOpenSearch}
            disabled={blockChrome}
          >
            <span style={{ fontFamily: "Material Symbols Outlined" }}>search</span>
          </button>
          <button
            type="button"
            className="aya-cr-rail-btn"
            title={blockChrome ? "Settings (close the open dialog first)" : "Settings"}
            aria-label="Settings"
            onClick={() => onOpenSettings()}
            disabled={blockChrome}
          >
            <span style={{ fontFamily: "Material Symbols Outlined" }}>settings</span>
          </button>
        </div>
      </nav>
      {body ? (
        <main aria-label="Terminal workspace"><h1 className="aya-visually-hidden">Aya</h1>{body}</main>
      ) : (
        <main aria-label="Terminal workspace"
          className="aya-main aya-cr-main"
          style={{ gridTemplateColumns: `${sidebarWidth}px 1fr` }}
        >
          <h1 className="aya-visually-hidden">Aya</h1>
          {sidebar}
          <div className="aya-cr-stage">
            <header className="aya-cr-crumbs">
              <span className="aya-cr-crumb">{activeProjectName ?? (isDev ? "Aya Dev" : "Aya")}</span>
              {activeTerminalName && (
                <>
                  <span className="aya-cr-crumb-sep">/</span>
                  <span className="aya-cr-crumb aya-cr-crumb--current">{activeTerminalName}</span>
                </>
              )}
              <span className="aya-cr-crumbs-spacer" />
              <LinuxWindowControls
                platform={platform}
                isMaximized={isMaximized}
                onMinimize={onMinimizeWindow}
                onToggleMaximize={onToggleMaximizeWindow}
                onClose={onCloseWindow}
              />
            </header>
            {panes}
          </div>
        </main>
      )}
      {projectMenu && (() => {
        const index = projects.findIndex((project) => project.slug === projectMenu.slug);
        return (
          <ProjectContextMenu
            menuRef={projectMenuRef}
            x={projectMenu.x}
            y={projectMenu.y}
            index={index}
            projectCount={projects.length}
            windows={projectMenu.windows}
            canMoveToWindow={!!onMoveProjectToWindow && !projectMenu.remote}
            onMove={(delta) => {
              onReorderProjects(moveItem(projects.map((project) => project.slug), index, delta));
              setProjectMenu(null);
            }}
            onClose={() => { onCloseProject(projectMenu.slug); setProjectMenu(null); }}
            onMoveToWindow={(target) => { onMoveProjectToWindow?.(projectMenu.slug, target); setProjectMenu(null); }}
          />
        );
      })()}
    </div>
  );
}

export const CommandRailLayout = memo(CommandRailLayoutImpl);

/** Top of the terminal column: the active project's name (double-click to
 *  rename) over its one-line summary. */
export function CommandRailSidebarHeader({
  project,
  summary,
  homeDir,
  onRename,
}: {
  project: ProjectConfig | null;
  summary?: string;
  homeDir: string;
  onRename: (slug: string, name: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  if (!project) return null;
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== project.name) onRename(project.slug, trimmed);
    setRenaming(false);
  };
  return (
    <div className="aya-cr-sidehead">
      {renaming ? (
        <input
          className="aya-tab-rename"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setRenaming(false);
            }
          }}
        />
      ) : (
        <div
          className="aya-cr-sidehead-name"
          title="Double-click to rename"
          onDoubleClick={() => {
            setDraft(project.name);
            setRenaming(true);
          }}
        >
          {project.name}
        </div>
      )}
      <div className="aya-cr-sidehead-summary">
        {summary?.trim() || projectPath(project, homeDir)}
      </div>
    </div>
  );
}

/** The other open projects, each with its one-line summary. */
export function CommandRailProjects({
  projects,
  activeProjectId,
  homeDir,
  projectBadges = {},
  projectSummaries = {},
  onSelectProject,
}: {
  projects: ProjectConfig[];
  activeProjectId: string | null;
  homeDir: string;
  projectBadges?: Record<string, ProjectAttention>;
  projectSummaries?: Record<string, string>;
  onSelectProject: (slug: string) => void;
}) {
  const others = projects.filter((p) => p.slug !== activeProjectId);
  if (others.length === 0) return null;
  return (
    <div className="aya-cr-projects">
      <div className="aya-cr-section-label">Projects</div>
      {others.map((p) => {
        const badge = projectBadges[p.slug];
        const summary = projectSummaries[p.slug]?.trim();
        return (
          <button
            key={p.slug}
            type="button"
            className="aya-cr-project"
            onClick={() => onSelectProject(p.slug)}
            title={`${p.name} - ${projectPath(p, homeDir)}`}
          >
            <span className="aya-cr-project-initial">{initial(p.name)}</span>
            <span className="aya-cr-project-main">
              <span className="aya-cr-project-name">{p.name}</span>
              <span className="aya-cr-project-summary">
                {summary || projectPath(p, homeDir)}
              </span>
            </span>
            {badge && (
              <span className={`aya-cr-avatar-dot aya-cr-avatar-dot--${badge.level} aya-cr-project-dot`} />
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Weekly usage per harness as thin bars at the foot of the column. */
export function CommandRailUsage({
  claude = [],
  codex = [],
  antigravity = [],
}: {
  claude?: UsageAccount[];
  codex?: UsageAccount[];
  antigravity?: UsageAccount[];
}) {
  const rows = [
    { label: "Claude", accounts: claude, color: CLAUDE_BRAND_COLOR },
    { label: "Codex", accounts: codex, color: CODEX_BRAND_COLOR },
  ].filter((row) => row.accounts.length > 0);
  if (rows.length === 0 && antigravity.length === 0) return null;
  return (
    <div className="aya-cr-usage">
      {antigravity.length > 0 && <UsageChip accounts={antigravity} label="Antigravity" accent="#4285f4" showHarnessName quotaGroups />}
      {rows.map((row) => {
        const { pct, ring } = averageUsagePct(row.accounts);
        const shown = Math.max(0, Math.min(100, Math.round(pct)));
        return (
          <div key={row.label} className="aya-cr-usage-row">
            <div className="aya-cr-usage-text">
              <span>{row.label}, {ring === "weekly" ? "this week" : "5h window"}</span>
              <span className="aya-cr-usage-pct">{shown}%</span>
            </div>
            <div className="aya-cr-usage-bar">
              <div
                className="aya-cr-usage-fill"
                style={{ width: `${shown}%`, background: row.color }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
