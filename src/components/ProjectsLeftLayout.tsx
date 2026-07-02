import {
  RECENT_MENU_WIDTH_PX,
  MENU_VIEWPORT_EDGE_PX,
  MENU_ANCHOR_GAP_PX,
} from "../ui-constants";
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { CLAUDE_BRAND_COLOR, CODEX_BRAND_COLOR } from "../colors";
import {
  getPreset,
  type Preset,
  type ProjectConfig,
  type TerminalState,
  type UsageAccount,
} from "../types";
import type { SettingsTab } from "../settings-tabs";
import { useDragReorder } from "../hooks/useDragReorder";
import { UsageChip } from "./UsageChip";
import { LinuxWindowControls, MacWindowControls } from "./WindowControls";

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
  /** Multi-window: move a project (with its running terminals) to a new
   *  window or an existing one. Absent = the menu items are hidden. */
  onMoveProjectToWindow?: (
    slug: string,
    target: number | "new",
    at?: { x: number; y: number },
  ) => void;
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
  onSelectTerminal: (id: string) => void;
  onCloseTerminal: (id: string) => void;
  onRenameTerminal: (id: string, name: string) => void;
  onLaunchTerminal: (preset: Preset) => void;
  onReorderTerminals: (orderedIds: string[]) => void;
  onRestartTerminal: (id: string) => void;

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
function ProjectsLeftLayoutImpl({
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
  onMoveProjectToWindow,
  onRenameProject,
  onReorderProjects,
  projectBadges = {},
  projectSummaries = {},
  terminals,
  activeTerminalId,
  presets,
  recentlyActiveIds,
  terminalSummaries = {},
  onSelectTerminal,
  onCloseTerminal,
  onRenameTerminal,
  onLaunchTerminal,
  onReorderTerminals,
  onRestartTerminal,
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
  const {
    dragId: dragSlug,
    dropTarget: projectDrop,
    itemHandlers: projectDragHandlers,
  } = useDragReorder(
    "y",
    projects.map((p) => p.slug),
    onReorderProjects,
    // Chrome-style tear-out: a rail tab released outside the strip attaches to
    // the window under the cursor or opens a new one (see TopBar for details).
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

  // ---- Terminal top tabs: rename / horizontal drag-reorder / context menu ----
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [termDraft, setTermDraft] = useState("");
  const termInputRef = useRef<HTMLInputElement>(null);
  const {
    dragId,
    dropTarget: termDrop,
    itemHandlers: termDragHandlers,
  } = useDragReorder("x", terminals.map((t) => t.id), onReorderTerminals);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(
    null,
  );
  // Right-click menu on a project rail tab (multi-window move). The
  // other-windows list is fetched when the menu opens, so labels are current.
  const [projectMenu, setProjectMenu] = useState<{
    x: number;
    y: number;
    slug: string;
    windows: Array<{ id: number; activeProject: string | null }>;
  } | null>(null);

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
  const [showLauncher, setShowLauncher] = useState(false);
  // Viewport coords for the launcher dropdown. The menu is position:fixed so it
  // can escape the tab strip's overflow:hidden clip; that means we must anchor
  // it ourselves to the "+" button's on-screen rect.
  const [menuPos, setMenuPos] = useState<
    { top: number; right: number } | { top: number; left: number } | null
  >(null);
  const launcherRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);

  // Toggle the launcher, anchoring the fixed-position menu to the "+" button's
  // current rect. Takes the element so it works for both click and keyboard.
  const toggleLauncher = (anchor: HTMLElement) => {
    // Capture the anchor rect unconditionally (harmless when closing — the menu
    // won't render) and use a functional updater so two fast toggles can't both
    // read a stale `showLauncher` and leave the menu stuck open.
    const r = anchor.getBoundingClientRect();
    const top = Math.round(r.bottom + MENU_ANCHOR_GAP_PX);
    // The fixed menu is right-anchored by default (opens leftward, aligned to the
    // button's right edge). When the "+" sits near the left edge (few / no tabs)
    // that runs off-screen to the left, so anchor by the left edge instead (opens
    // rightward). RECENT_MENU_WIDTH_PX must track `.aya-recent-menu { width }` in
    // overrides.css.
    setMenuPos(
      r.right < RECENT_MENU_WIDTH_PX
        ? {
            top,
            // Clamp so a very narrow window doesn't clip the right edge either.
            left: Math.max(
              MENU_VIEWPORT_EDGE_PX,
              Math.min(Math.round(r.left), window.innerWidth - RECENT_MENU_WIDTH_PX - MENU_VIEWPORT_EDGE_PX),
            ),
          }
        : { top, right: Math.round(window.innerWidth - r.right) },
    );
    setShowLauncher((prev) => !prev);
  };

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
    const close = () => setShowLauncher(false);
    const onPointerDown = (e: PointerEvent) => {
      if (!launcherRef.current?.contains(e.target as Node)) setShowLauncher(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowLauncher(false);
    };
    // The menu is position:fixed at coords captured on open; if the layout
    // shifts under it those coords go stale, so close rather than leave it
    // detached from the "+" button. Only two things move the button: a window
    // resize, and the tab strip scrolling horizontally. Listen on the strip
    // itself (not window) so scrolling the dropdown, terminal, or project rail
    // doesn't dismiss the menu. (scroll events don't bubble, so the dropdown's
    // own overflow scroll never reaches the strip listener.)
    const strip = tabsRef.current;
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    strip?.addEventListener("scroll", close);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      strip?.removeEventListener("scroll", close);
    };
  }, [showLauncher]);

  // Translate wheel deltas over the tab strip into horizontal scroll (same as
  // the classic project tab strip).
  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // Leave wheel scrolling that belongs to the open launcher dropdown alone;
      // otherwise this would hijack it into horizontal tab-strip scroll.
      if (launcherRef.current?.querySelector(".aya-recent-menu")?.contains(e.target as Node)) return;
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
        <MacWindowControls
          platform={platform}
          isFullScreen={isFullScreen}
          onClose={onCloseWindow}
          onMinimize={onMinimizeWindow}
          onToggleFullScreen={onToggleFullScreenWindow}
        />
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
                {...termDragHandlers(t.id)}
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
              role="button"
              tabIndex={0}
              aria-label="New terminal"
              onClick={(e) => toggleLauncher(e.currentTarget)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggleLauncher(e.currentTarget);
                }
              }}
              aria-haspopup="menu"
              aria-expanded={showLauncher}
            >
              <span style={{ fontFamily: "Material Symbols Outlined" }}>add</span>
            </div>
            {showLauncher && menuPos && (
              // position:fixed so the dropdown escapes the tab strip's
              // overflow:hidden clip; anchored to the "+" button's rect.
              <div
                className="aya-recent-menu"
                role="menu"
                style={{
                  position: "fixed",
                  top: menuPos.top,
                  ...("left" in menuPos
                    ? { left: menuPos.left }
                    : { right: menuPos.right }),
                }}
              >
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
          <LinuxWindowControls
            platform={platform}
            isMaximized={isMaximized}
            onMinimize={onMinimizeWindow}
            onToggleMaximize={onToggleMaximizeWindow}
            onClose={onCloseWindow}
          />
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
              const isDropTarget = projectDrop?.id === p.slug;
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
                  {...projectDragHandlers(p.slug)}
                  onClick={() => !isRenaming && onSelectProject(p.slug)}
                  onContextMenu={(e) => {
                    // Remote projects can't be adopted by directory (it lives
                    // on the remote host) - no move menu for them yet.
                    if (isRemote || !onMoveProjectToWindow) return;
                    e.preventDefault();
                    const at = { x: e.clientX, y: e.clientY };
                    void window.aya.listOtherWindows().then((windows) => {
                      setProjectMenu({ ...at, slug: p.slug, windows });
                    });
                  }}
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
      {projectMenu && onMoveProjectToWindow && (
        <div
          className="aya-context-menu"
          style={{ left: projectMenu.x, top: projectMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="aya-context-menu-item"
            onClick={() => {
              onMoveProjectToWindow(projectMenu.slug, "new");
              setProjectMenu(null);
            }}
          >
            Move to New Window
          </button>
          {projectMenu.windows.map((w) => (
            <button
              key={w.id}
              className="aya-context-menu-item"
              onClick={() => {
                onMoveProjectToWindow(projectMenu.slug, w.id);
                setProjectMenu(null);
              }}
            >
              Move to Window: {w.activeProject ?? "(empty)"}
            </button>
          ))}
        </div>
      )}
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
          {/* Split actions are intentionally absent: this layout does not
              support split panes (see App's layoutMode gating). */}
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

/** Memoized: App re-renders on every poll tick / terminal status flip; with
 *  the derived props memoized in App (R1) and the handlers useCallback'd,
 *  the shallow compare lets the chrome skip those renders entirely. */
export const ProjectsLeftLayout = memo(ProjectsLeftLayoutImpl);
