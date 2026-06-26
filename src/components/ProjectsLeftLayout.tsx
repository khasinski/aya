import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import { CLAUDE_BRAND_COLOR, CODEX_BRAND_COLOR } from "../colors";
import {
  getPreset,
  type Preset,
  type ProjectConfig,
  type TerminalState,
  type UsageAccount,
} from "../types";
import type { SettingsTab } from "../settings-tabs";
import { UsageChip } from "./UsageChip";

// Project rail width bounds (px) for the drag-resize handle.
const RAIL_MIN_WIDTH_PX = 160;
const RAIL_MAX_WIDTH_PX = 360;

interface ProjectAttention {
  count: number;
  level: "active" | "done" | "waiting" | "error";
}

interface Props {
  // Projects (left rail)
  projects: ProjectConfig[];
  closedProjects: ProjectConfig[];
  activeProjectId: string | null;
  homeDir: string;
  railWidth: number;
  onRailResize: (width: number) => void;
  onSelectProject: (slug: string) => void;
  onOpenProject: (slug: string) => void;
  onNewProject: () => void;
  onCloseProject: (slug: string) => void;
  onRenameProject: (slug: string, newName: string) => void;
  onReorderProjects: (orderedSlugs: string[]) => void;
  projectBadges?: Record<string, ProjectAttention>;
  projectSummaries?: Record<string, string>;

  // Terminals (top tabs)
  terminals: TerminalState[];
  activeTerminalId: string | null;
  presets: Preset[];
  recentlyActiveIds: ReadonlySet<string>;
  terminalSummaries?: Record<string, string>;
  splitAssignments?: Record<string, number>;
  onSelectTerminal: (id: string) => void;
  onCloseTerminal: (id: string) => void;
  onRenameTerminal: (id: string, name: string) => void;
  onLaunchTerminal: (preset: Preset) => void;
  onReorderTerminals: (orderedIds: string[]) => void;
  onRestartTerminal: (id: string) => void;
  canSplitRight: boolean;
  canSplitBelow: boolean;
  onAssignToSplit: (id: string) => void;
  onSplitRight: (id: string) => void;
  onSplitBelow: (id: string) => void;
  onRemoveFromSplit: (id: string) => void;

  // App chrome
  isDev: boolean;
  platform: NodeJS.Platform;
  isFullScreen: boolean;
  isMaximized: boolean;
  blockChrome: boolean;
  onOpenSearch: () => void;
  onOpenSettings: (tab?: SettingsTab) => void;
  onMinimizeWindow: () => void;
  onToggleMaximizeWindow: () => void;
  onToggleFullScreenWindow: () => void;
  onCloseWindow: () => void;
  usageAccounts?: UsageAccount[];
  codexUsageAccounts?: UsageAccount[];
  showUsageHarnessName: boolean;

  // The shared terminal-panes / empty / loading body.
  body: ReactNode;
}

function compactDir(directory: string, home: string): string {
  if (!directory) return "";
  if (!home) return directory;
  if (directory === home) return "~";
  if (directory.startsWith(home + "/")) return "~" + directory.slice(home.length);
  return directory;
}

/** Alternative window layout: project tabs in a left rail, terminal tabs along
 *  the top. Fully self-contained — App picks between this and the classic
 *  layout with a single switch. */
export function ProjectsLeftLayout({
  projects,
  closedProjects,
  activeProjectId,
  homeDir,
  railWidth,
  onRailResize,
  onSelectProject,
  onOpenProject,
  onNewProject,
  onCloseProject,
  onRenameProject,
  onReorderProjects,
  projectBadges = {},
  projectSummaries = {},
  terminals,
  activeTerminalId,
  presets,
  recentlyActiveIds,
  terminalSummaries = {},
  splitAssignments = {},
  onSelectTerminal,
  onCloseTerminal,
  onRenameTerminal,
  onLaunchTerminal,
  onReorderTerminals,
  onRestartTerminal,
  canSplitRight,
  canSplitBelow,
  onAssignToSplit,
  onSplitRight,
  onSplitBelow,
  onRemoveFromSplit,
  isDev,
  platform,
  isFullScreen,
  isMaximized,
  blockChrome,
  onOpenSearch,
  onOpenSettings,
  onMinimizeWindow,
  onToggleMaximizeWindow,
  onToggleFullScreenWindow,
  onCloseWindow,
  usageAccounts = [],
  codexUsageAccounts = [],
  showUsageHarnessName,
  body,
}: Props) {
  // ---- Project rail: rename / vertical drag-reorder ----
  const [renamingSlug, setRenamingSlug] = useState<string | null>(null);
  const [projectDraft, setProjectDraft] = useState("");
  const projectInputRef = useRef<HTMLInputElement>(null);
  const [dragSlug, setDragSlug] = useState<string | null>(null);
  const [projectDrop, setProjectDrop] = useState<{
    slug: string;
    before: boolean;
  } | null>(null);

  const startProjectRename = (project: ProjectConfig) => {
    setRenamingSlug(project.slug);
    setProjectDraft(project.name);
    setTimeout(() => projectInputRef.current?.select(), 0);
  };
  const commitProjectRename = () => {
    if (renamingSlug) {
      const trimmed = projectDraft.trim();
      if (trimmed) onRenameProject(renamingSlug, trimmed);
    }
    setRenamingSlug(null);
  };

  const onProjectDragStart = (e: DragEvent<HTMLDivElement>, slug: string) => {
    setDragSlug(slug);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", slug);
  };
  const onProjectDragOver = (e: DragEvent<HTMLDivElement>, slug: string) => {
    if (!dragSlug || dragSlug === slug) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    setProjectDrop((prev) =>
      prev && prev.slug === slug && prev.before === before
        ? prev
        : { slug, before },
    );
  };
  const onProjectDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (dragSlug && projectDrop) {
      const order = projects.map((p) => p.slug);
      const fromIdx = order.indexOf(dragSlug);
      const targetIdx = order.indexOf(projectDrop.slug);
      if (fromIdx >= 0 && targetIdx >= 0) {
        order.splice(fromIdx, 1);
        let insertIdx = targetIdx;
        if (fromIdx < targetIdx) insertIdx -= 1;
        if (!projectDrop.before) insertIdx += 1;
        order.splice(insertIdx, 0, dragSlug);
        onReorderProjects(order);
      }
    }
    setDragSlug(null);
    setProjectDrop(null);
  };
  const onProjectDragEnd = () => {
    setDragSlug(null);
    setProjectDrop(null);
  };

  // ---- Terminal top tabs: rename / horizontal drag-reorder / context menu ----
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [termDraft, setTermDraft] = useState("");
  const termInputRef = useRef<HTMLInputElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [termDrop, setTermDrop] = useState<{ id: string; before: boolean } | null>(
    null,
  );
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(
    null,
  );
  const [showLauncher, setShowLauncher] = useState(false);
  const launcherRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  useEffect(() => {
    if (!showLauncher) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!launcherRef.current?.contains(e.target as Node)) setShowLauncher(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [showLauncher]);

  // Translate wheel deltas over the tab strip into horizontal scroll (same as
  // the classic project tab strip).
  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      el.scrollLeft += delta;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const startTermRename = (t: TerminalState) => {
    setRenamingId(t.id);
    setTermDraft(t.name);
    setTimeout(() => termInputRef.current?.select(), 0);
  };
  const commitTermRename = () => {
    if (renamingId) {
      const trimmed = termDraft.trim();
      if (trimmed) onRenameTerminal(renamingId, trimmed);
    }
    setRenamingId(null);
  };

  const onTermDragStart = (e: DragEvent<HTMLDivElement>, id: string) => {
    setDragId(id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  };
  const onTermDragOver = (e: DragEvent<HTMLDivElement>, id: string) => {
    if (!dragId || dragId === id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const before = e.clientX < rect.left + rect.width / 2;
    setTermDrop((prev) =>
      prev && prev.id === id && prev.before === before ? prev : { id, before },
    );
  };
  const onTermDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (dragId && termDrop) {
      const order = terminals.map((t) => t.id);
      const fromIdx = order.indexOf(dragId);
      const targetIdx = order.indexOf(termDrop.id);
      if (fromIdx >= 0 && targetIdx >= 0) {
        order.splice(fromIdx, 1);
        let insertIdx = targetIdx;
        if (fromIdx < targetIdx) insertIdx -= 1;
        if (!termDrop.before) insertIdx += 1;
        order.splice(insertIdx, 0, dragId);
        onReorderTerminals(order);
      }
    }
    setDragId(null);
    setTermDrop(null);
  };
  const onTermDragEnd = () => {
    setDragId(null);
    setTermDrop(null);
  };

  // ---- Project rail resize ----
  const resizing = useRef(false);
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!resizing.current) return;
      const w = Math.max(
        RAIL_MIN_WIDTH_PX,
        Math.min(RAIL_MAX_WIDTH_PX, e.clientX),
      );
      onRailResize(w);
    };
    const up = () => {
      resizing.current = false;
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [onRailResize]);

  // ---- Recent projects dropdown ----
  const [showRecent, setShowRecent] = useState(false);
  const recentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showRecent) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!recentRef.current?.contains(e.target as Node)) setShowRecent(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [showRecent]);

  return (
    <>
      <header className="aya-topbar aya-topbar--alt">
        {platform === "darwin" && (
          <div className="aya-mac-window-controls" aria-label="Window controls">
            <button
              className="aya-mac-window-control aya-mac-window-control--close"
              title="Close"
              aria-label="Close"
              onClick={onCloseWindow}
            >
              <svg className="aya-mac-window-control-icon" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M3.25 3.25L8.75 8.75M8.75 3.25L3.25 8.75" />
              </svg>
            </button>
            <button
              className="aya-mac-window-control aya-mac-window-control--minimize"
              title="Minimize"
              aria-label="Minimize"
              onClick={onMinimizeWindow}
            >
              <svg className="aya-mac-window-control-icon" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M3 6H9" />
              </svg>
            </button>
            <button
              className="aya-mac-window-control aya-mac-window-control--fullscreen"
              title={isFullScreen ? "Exit full screen" : "Full screen"}
              aria-label={isFullScreen ? "Exit full screen" : "Full screen"}
              onClick={onToggleFullScreenWindow}
            >
              <svg className="aya-mac-window-control-icon" viewBox="0 0 12 12" aria-hidden="true">
                {isFullScreen ? (
                  <>
                    <path d="M4.5 2.75V4.5H2.75" />
                    <path d="M7.5 9.25V7.5H9.25" />
                  </>
                ) : (
                  <>
                    <path d="M7.5 2.75H9.25V4.5" />
                    <path d="M4.5 9.25H2.75V7.5" />
                  </>
                )}
              </svg>
            </button>
          </div>
        )}
        <div className="aya-tabs aya-termtabs" ref={tabsRef}>
          {terminals.map((t) => {
            const isActive = t.id === activeTerminalId;
            const preset = getPreset(presets, t.presetId);
            const isRenaming = renamingId === t.id;
            const isDragging = dragId === t.id;
            const summary = terminalSummaries[t.id]?.trim();
            const isDropTarget = termDrop?.id === t.id;
            const dropClass = isDropTarget
              ? termDrop.before
                ? "aya-tab--drop-before"
                : "aya-tab--drop-after"
              : "";
            return (
              <div
                key={t.id}
                data-testid="termtab"
                data-terminal-id={t.id}
                data-terminal-name={t.name}
                className={`aya-tab aya-termtab ${isActive ? "aya-tab--active" : ""} ${
                  isDragging ? "aya-tab--dragging" : ""
                } ${dropClass}`}
                style={{ flex: "0 0 auto" }}
                draggable={!isRenaming}
                onDragStart={(e) => onTermDragStart(e, t.id)}
                onDragOver={(e) => onTermDragOver(e, t.id)}
                onDrop={onTermDrop}
                onDragEnd={onTermDragEnd}
                onClick={() => !isRenaming && onSelectTerminal(t.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, id: t.id });
                }}
                title={`${t.name} — ${t.cwd}${summary ? ` · ${summary}` : ""}`}
              >
                <span
                  className="aya-sidebar-icon"
                  style={preset.color ? { color: preset.color } : undefined}
                >
                  {preset.icon}
                </span>
                <span
                  className={`aya-sidebar-statusdot aya-sidebar-statusdot--${t.status} ${
                    recentlyActiveIds.has(t.id)
                      ? "aya-sidebar-statusdot--blinking"
                      : ""
                  }`}
                />
                <span className="aya-termtab-main">
                  {isRenaming ? (
                    <input
                      ref={termInputRef}
                      className="aya-tab-rename"
                      value={termDraft}
                      onChange={(e) => setTermDraft(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={commitTermRename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitTermRename();
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setRenamingId(null);
                        }
                      }}
                      autoFocus
                    />
                  ) : (
                    <span
                      className="aya-tab-name"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        startTermRename(t);
                      }}
                    >
                      {t.name}
                    </span>
                  )}
                  {!isRenaming && summary && (
                    <span className="aya-termtab-summary">{summary}</span>
                  )}
                </span>
                {t.bell && <span className="aya-bell aya-bell--alert" />}
                {splitAssignments[t.id] !== undefined && (
                  <span className="aya-sidebar-pane-chip">
                    {splitAssignments[t.id] + 1}
                  </span>
                )}
                <span
                  className="aya-tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTerminal(t.id);
                  }}
                  title="Close terminal"
                >
                  ×
                </span>
              </div>
            );
          })}
          <div className="aya-termtab-launcher" ref={launcherRef}>
            <div
              className="aya-tab-new"
              title="New terminal"
              onClick={() => setShowLauncher((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={showLauncher}
            >
              <span style={{ fontFamily: "Material Symbols Outlined" }}>add</span>
            </div>
            {showLauncher && (
              <div className="aya-recent-menu" role="menu">
                <div className="aya-recent-menu-title">New terminal</div>
                {presets.map((p) => (
                  <button
                    key={p.id}
                    className="aya-recent-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setShowLauncher(false);
                      onLaunchTerminal(p);
                    }}
                    title={p.command}
                  >
                    <span
                      className="aya-launcher-btn-icon"
                      style={p.color ? { color: p.color } : undefined}
                    >
                      {p.icon}
                    </span>
                    <span className="aya-recent-menu-name">{p.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="aya-topbar-right">
          {usageAccounts.length > 0 && (
            <UsageChip
              accounts={usageAccounts}
              label="Claude"
              accent={CLAUDE_BRAND_COLOR}
              showHarnessName={showUsageHarnessName}
            />
          )}
          {codexUsageAccounts.length > 0 && (
            <UsageChip
              accounts={codexUsageAccounts}
              label="Codex"
              accent={CODEX_BRAND_COLOR}
              showHarnessName={showUsageHarnessName}
            />
          )}
          <button
            className="aya-iconbtn"
            title={
              blockChrome
                ? "Search (close the open dialog first)"
                : "Search (Cmd/Ctrl+K or Shift Shift)"
            }
            onClick={onOpenSearch}
            disabled={blockChrome}
          >
            <span style={{ fontFamily: "Material Symbols Outlined" }}>search</span>
          </button>
          <button
            className="aya-iconbtn"
            title={blockChrome ? "Settings (close the open dialog first)" : "Settings"}
            onClick={() => onOpenSettings()}
            disabled={blockChrome}
          >
            <span style={{ fontFamily: "Material Symbols Outlined" }}>settings</span>
          </button>
          {platform === "linux" && (
            <div className="aya-window-controls" aria-label="Window controls">
              <button
                className="aya-window-control"
                title="Minimize"
                aria-label="Minimize"
                onClick={onMinimizeWindow}
              >
                <span style={{ fontFamily: "Material Symbols Outlined" }}>remove</span>
              </button>
              <button
                className="aya-window-control"
                title={isMaximized ? "Restore" : "Maximize"}
                aria-label={isMaximized ? "Restore" : "Maximize"}
                onClick={onToggleMaximizeWindow}
              >
                <span style={{ fontFamily: "Material Symbols Outlined" }}>
                  {isMaximized ? "filter_none" : "crop_square"}
                </span>
              </button>
              <button
                className="aya-window-control aya-window-control--close"
                title="Close"
                aria-label="Close"
                onClick={onCloseWindow}
              >
                <span style={{ fontFamily: "Material Symbols Outlined" }}>close</span>
              </button>
            </div>
          )}
        </div>
      </header>
      <div
        className="aya-main aya-main--alt"
        style={{ gridTemplateColumns: `${railWidth}px 1fr` }}
      >
        <aside className="aya-projectrail" style={{ width: railWidth }}>
          <div className="aya-projectrail-header">
            <div className="aya-brand">
              <span
                className="aya-brand-dot"
                style={isDev ? { background: "#a371f7" } : undefined}
              />
              <span>{isDev ? "Aya Dev" : "Aya"}</span>
            </div>
            <div className="aya-recent-projects" ref={recentRef}>
              <button
                className="aya-iconbtn"
                title={
                  blockChrome
                    ? "Recent projects (close the open dialog first)"
                    : "Recent projects"
                }
                aria-label="Recent projects"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setShowRecent((v) => !v)}
                disabled={blockChrome}
                aria-haspopup="menu"
                aria-expanded={showRecent}
              >
                <span style={{ fontFamily: "Material Symbols Outlined" }}>
                  folder_open
                </span>
              </button>
              {showRecent && (
                <div className="aya-recent-menu" role="menu">
                  <div className="aya-recent-menu-title">Recent projects</div>
                  {closedProjects.length === 0 ? (
                    <div className="aya-recent-menu-empty">No closed projects</div>
                  ) : (
                    closedProjects.map((p) => (
                      <button
                        key={p.slug}
                        className="aya-recent-menu-item"
                        role="menuitem"
                        onClick={() => {
                          setShowRecent(false);
                          onOpenProject(p.slug);
                        }}
                      >
                        <span className="aya-recent-menu-name">{p.name}</span>
                        <span className="aya-recent-menu-path">
                          {compactDir(p.directory, homeDir)}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="aya-projectrail-list">
            {projects.map((p) => {
              const isActive = p.slug === activeProjectId;
              const badge = projectBadges[p.slug];
              const isRenaming = renamingSlug === p.slug;
              const isDragging = dragSlug === p.slug;
              const isRemote = !!p.remote;
              const displayPath = p.remote
                ? `${p.remote.label}:${p.remote.directory}`
                : compactDir(p.directory, homeDir);
              const projectSummary = projectSummaries[p.slug]?.trim();
              const displayMeta = projectSummary || displayPath;
              const isDropTarget = projectDrop?.slug === p.slug;
              const dropClass = isDropTarget
                ? projectDrop.before
                  ? "aya-railtab--drop-before"
                  : "aya-railtab--drop-after"
                : "";
              return (
                <div
                  key={p.slug}
                  data-testid="railtab"
                  className={`aya-railtab ${isActive ? "aya-railtab--active" : ""} ${
                    isDragging ? "aya-railtab--dragging" : ""
                  } ${isRemote ? "aya-railtab--remote" : ""} ${dropClass}`}
                  draggable={!isRenaming}
                  onDragStart={(e) => onProjectDragStart(e, p.slug)}
                  onDragOver={(e) => onProjectDragOver(e, p.slug)}
                  onDrop={onProjectDrop}
                  onDragEnd={onProjectDragEnd}
                  onClick={() => !isRenaming && onSelectProject(p.slug)}
                  title={
                    isRenaming
                      ? undefined
                      : `${p.name} - ${displayPath}${projectSummary ? ` · ${projectSummary}` : ""} · double-click to rename · drag to reorder`
                  }
                >
                  <div className="aya-railtab-main">
                    {isRenaming ? (
                      <input
                        ref={projectInputRef}
                        className="aya-tab-rename"
                        value={projectDraft}
                        onChange={(e) => setProjectDraft(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={commitProjectRename}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            commitProjectRename();
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            setRenamingSlug(null);
                          }
                        }}
                        autoFocus
                      />
                    ) : (
                      <span
                        className="aya-railtab-name"
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          startProjectRename(p);
                        }}
                      >
                        {isRemote && (
                          <span className="aya-tab-remote-chip" title={displayPath}>
                            SSH
                          </span>
                        )}
                        {p.name}
                      </span>
                    )}
                    <span
                      className={`aya-railtab-path ${
                        projectSummary ? "aya-railtab-path--summary" : ""
                      }`}
                    >
                      {displayMeta}
                    </span>
                  </div>
                  {badge && (
                    <span
                      className={`aya-tab-bell aya-tab-bell--${badge.level}`}
                      title={`${badge.count} monitored session${badge.count > 1 ? "s" : ""}: ${badge.level}`}
                    />
                  )}
                  <span
                    className="aya-railtab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseProject(p.slug);
                    }}
                    title="Close project"
                  >
                    ×
                  </span>
                </div>
              );
            })}
          </div>
          <button
            className={`aya-projectrail-new ${blockChrome ? "aya-tab-new--disabled" : ""}`}
            type="button"
            title="New project"
            onClick={blockChrome ? undefined : onNewProject}
            aria-disabled={blockChrome}
          >
            <span style={{ fontFamily: "Material Symbols Outlined" }}>add</span>
            New project
          </button>
          <div
            className="aya-projectrail-resize"
            onMouseDown={() => {
              resizing.current = true;
              document.body.style.cursor = "col-resize";
            }}
          />
        </aside>
        {body}
      </div>
      {menu && (
        <div
          className="aya-context-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="aya-context-menu-item"
            onClick={() => {
              const terminal = terminals.find((t) => t.id === menu.id);
              if (terminal) startTermRename(terminal);
              setMenu(null);
            }}
          >
            Rename terminal
          </button>
          <button
            className="aya-context-menu-item"
            onClick={() => {
              onRestartTerminal(menu.id);
              setMenu(null);
            }}
          >
            Restart terminal
          </button>
          <button
            className="aya-context-menu-item"
            onClick={() => {
              onAssignToSplit(menu.id);
              setMenu(null);
            }}
          >
            Show in active pane
          </button>
          {canSplitRight && (
            <button
              className="aya-context-menu-item"
              onClick={() => {
                onSplitRight(menu.id);
                setMenu(null);
              }}
            >
              Split right
            </button>
          )}
          {canSplitBelow && (
            <button
              className="aya-context-menu-item"
              onClick={() => {
                onSplitBelow(menu.id);
                setMenu(null);
              }}
            >
              Split below
            </button>
          )}
          {splitAssignments[menu.id] !== undefined && (
            <button
              className="aya-context-menu-item"
              onClick={() => {
                onRemoveFromSplit(menu.id);
                setMenu(null);
              }}
            >
              Remove from split
            </button>
          )}
          <button
            className="aya-context-menu-item aya-context-menu-item--danger"
            onClick={() => {
              onCloseTerminal(menu.id);
              setMenu(null);
            }}
          >
            Close terminal
          </button>
        </div>
      )}
    </>
  );
}
