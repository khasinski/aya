import { CLAUDE_BRAND_COLOR, CODEX_BRAND_COLOR, GROK_BRAND_COLOR } from "../colors";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useDragReorder } from "../hooks/useDragReorder";
import { handleRovingItemKeyDown, isContextMenuKey, moveItem } from "../keyboard-navigation";
import type {
  GrokUsage,
  MonitoredSession,
  ProjectConfig,
  UsageAccount,
} from "../types";
import type { SettingsTab } from "../settings-tabs";
import { GrokUsageChip, UsageChip } from "./UsageChip";
import { LinuxWindowControls, MacWindowControls } from "./WindowControls";
import { compactDir } from "../project-path";
import { RecentProjectsMenu } from "./RecentProjectsMenu";
import { ProjectContextMenu } from "./ProjectContextMenu";

// Project tab width bounds (px): tabs shrink to min, then overflow the strip.
const TAB_MIN_WIDTH_PX = 120;
const TAB_MAX_WIDTH_PX = 320;
// The sessions menu lists at most this many monitored sessions.
const SESSION_MENU_LIMIT = 8;

interface ProjectAttention {
  count: number;
  level: "active" | "done" | "waiting" | "error";
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
  /** When true, the gear is disabled and the "+ New project" sentinel is
   *  inert. Used while a blocking modal (MissingDir / NewProject) is up
   *  so the user can't stack Settings on top of it. */
  blockChrome: boolean;
  onSelectProject: (slug: string) => void;
  onOpenProject: (slug: string) => void;
  onNewProject: () => void;
  /** Closes the project tab without deleting the project config. */
  onCloseProject: (slug: string) => void;
  /** Multi-window: move a project tab (with its running terminals) to a new
   *  window or an existing one. Absent = the menu items are hidden. */
  onMoveProjectToWindow?: (
    slug: string,
    target: number | "new",
    at?: { x: number; y: number },
  ) => void;
  onRenameProject: (slug: string, newName: string) => void;
  onReorderProjects: (orderedSlugs: string[]) => void;
  onOpenSearch: () => void;
  onOpenSettings: (tab?: SettingsTab) => void;
  onMinimizeWindow: () => void;
  onToggleMaximizeWindow: () => void;
  onToggleFullScreenWindow: () => void;
  onCloseWindow: () => void;
  projectBadges?: Record<string, ProjectAttention>;
  monitoredSessionsByProject?: Record<string, MonitoredSession[]>;
  projectSummaries?: Record<string, string>;
  /** Account-wide Claude usage snapshots. Read-only. */
  usageAccounts?: UsageAccount[];
  /** Account-wide Codex usage snapshots. Read-only. */
  codexUsageAccounts?: UsageAccount[];
  /** Account-wide Grok usage (tokens + cost, last 7 days). Read-only. */
  antigravityUsageAccounts?: UsageAccount[];
  grokUsage?: GrokUsage | null;
  showUsageHarnessName: boolean;
}

function TopBarImpl({
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
  onRenameProject,
  onReorderProjects,
  onOpenSearch,
  onOpenSettings,
  onMinimizeWindow,
  onToggleMaximizeWindow,
  onToggleFullScreenWindow,
  onCloseWindow,
  projectBadges = {},
  monitoredSessionsByProject = {},
  projectSummaries = {},
  usageAccounts = [],
  codexUsageAccounts = [],
  antigravityUsageAccounts = [],
  grokUsage = null,
  showUsageHarnessName,
}: Props) {
  const [renamingSlug, setRenamingSlug] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const sessionsRef = useRef<HTMLDivElement>(null);
  const tabMenuRef = useRef<HTMLDivElement>(null);
  const tabMenuOpenerRef = useRef<HTMLElement | null>(null);
  const [showSessions, setShowSessions] = useState(false);
  // Right-click menu on a project tab (multi-window move). The other-windows
  // list is fetched when the menu opens, so labels are current.
  const [tabMenu, setTabMenu] = useState<{
    x: number;
    y: number;
    slug: string;
    windows: Array<{ id: number; activeProject: string | null }>;
  } | null>(null);
  const [focusProjectAfterMove, setFocusProjectAfterMove] = useState<{ slug: string; index: number } | null>(null);
  const [focusedProjectSlug, setFocusedProjectSlug] = useState<string | null>(null);
  const pendingRovingProjectFocus = useRef<HTMLElement | null>(null);
  const rovingProjectSlug = projects.some((project) => project.slug === focusedProjectSlug)
    ? focusedProjectSlug
    : activeProjectId;

  useLayoutEffect(() => {
    const target = pendingRovingProjectFocus.current;
    if (!target) return;
    pendingRovingProjectFocus.current = null;
    if (target.isConnected) target.focus();
  }, [focusedProjectSlug]);

  useLayoutEffect(() => {
    if (!focusProjectAfterMove || projects.findIndex((project) => project.slug === focusProjectAfterMove.slug) !== focusProjectAfterMove.index) return;
    const slug = focusProjectAfterMove.slug;
    [...document.querySelectorAll<HTMLElement>('.aya-project-tablist [role="tab"][data-project-slug]')]
      .find((item) => item.dataset.projectSlug === slug)?.focus();
    setFocusProjectAfterMove(null);
  }, [focusProjectAfterMove, projects]);

  const closeTabMenu = useCallback((restoreFocus = true) => {
    const opener = tabMenuOpenerRef.current;
    setTabMenu(null);
    if (restoreFocus) window.setTimeout(() => {
      if (opener?.isConnected) opener.focus();
      else document.querySelector<HTMLElement>('.aya-tab[role="tab"][aria-selected="true"]')?.focus();
    });
  }, []);

  useLayoutEffect(() => {
    if (!tabMenu) return;
    tabMenuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const close = () => closeTabMenu(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeTabMenu();
      }
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [tabMenu, closeTabMenu]);

  const openTabMenu = (slug: string, opener: HTMLElement, x: number, y: number) => {
    tabMenuOpenerRef.current = opener;
    const at = { x, y };
    if (!onMoveProjectToWindow) {
      setTabMenu({ ...at, slug, windows: [] });
      return;
    }
    void window.aya.listOtherWindows().then((windows) => setTabMenu({ ...at, slug, windows }));
  };

  const openTabMenuFromMouse = (e: ReactMouseEvent<HTMLElement>, slug: string) => {
    e.preventDefault();
    openTabMenu(slug, e.currentTarget, e.clientX, e.clientY);
  };

  const openTabMenuFromKeyboard = (e: ReactKeyboardEvent<HTMLElement>, slug: string) => {
    if (!isContextMenuKey(e.nativeEvent)) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    openTabMenu(slug, e.currentTarget, rect.left, rect.bottom);
  };

  // Memoized: these ran (flatMap+sort / filter) on every TopBar render even
  // with both dropdowns closed.
  const monitoredSessions = useMemo(
    () =>
      Object.entries(monitoredSessionsByProject)
        .flatMap(([projectSlug, sessions]) =>
          sessions.map((session) => ({ ...session, projectSlug })),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [monitoredSessionsByProject],
  );
  useEffect(() => {
    if (!showSessions) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!sessionsRef.current?.contains(e.target as Node)) setShowSessions(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [showSessions]);

  // Route ANY wheel/trackpad delta over the tab strip into horizontal
  // scroll. macOS trackpad horizontal swipes default to history navigation
  // in Chromium (we counter that with overscroll-behavior in CSS) and
  // regular mice only emit deltaY, so the safest thing is to always claim
  // the event and translate whichever axis the user gave us.
  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      const delta =
        Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      el.scrollLeft += delta;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Horizontal drag-and-drop for project tab reordering. A drag released
  // outside the strip (possibly outside the window) becomes a Chrome-style
  // tear-out: main hit-tests the release point against the live windows and
  // the tab either attaches to the window under the cursor or opens a new one.
  const handleTabDragOut = (slug: string, e: { screenX: number; screenY: number }) => {
    if (!onMoveProjectToWindow) return;
    const project = projects.find((pr) => pr.slug === slug);
    if (!project || project.remote) return;
    const at = { x: e.screenX, y: e.screenY };
    void window.aya.resolveProjectDrop(at.x, at.y).then((r) => {
      if (r.kind === "self") return;
      onMoveProjectToWindow(slug, r.kind === "new" ? "new" : r.id, at);
    });
  };
  const { dragId: dragSlug, dropTarget, itemHandlers } = useDragReorder(
    "x",
    projects.map((p) => p.slug),
    onReorderProjects,
    handleTabDragOut,
  );

  const startRename = (project: ProjectConfig) => {
    setRenamingSlug(project.slug);
    setDraft(project.name);
    setTimeout(() => inputRef.current?.select(), 0);
  };
  const commitRename = () => {
    if (renamingSlug) {
      const trimmed = draft.trim();
      if (trimmed) onRenameProject(renamingSlug, trimmed);
    }
    setRenamingSlug(null);
  };
  const cancelRename = () => setRenamingSlug(null);

  return (
    <header className="aya-topbar">
      <MacWindowControls
        platform={platform}
        isFullScreen={isFullScreen}
        onClose={onCloseWindow}
        onMinimize={onMinimizeWindow}
        onToggleFullScreen={onToggleFullScreenWindow}
      />
      <div className="aya-brand">
        <span
          className="aya-brand-dot"
          style={isDev ? { background: "#a371f7" } : undefined}
        />
        <span>{isDev ? "Aya Dev" : "Aya"}</span>
      </div>
      <div className="aya-tabs" ref={tabsRef}>
        <div className="aya-project-tablist" role="tablist" aria-label="Projects">
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
          const isDropTarget = dropTarget?.id === p.slug;
          const dropClass = isDropTarget
            ? dropTarget.before
              ? "aya-tab--drop-before"
              : "aya-tab--drop-after"
            : "";
            return (
            <div
              key={p.slug}
              data-project-slug={p.slug}
              role="tab"
              aria-selected={isActive}
              tabIndex={rovingProjectSlug === p.slug ? 0 : -1}
              className={`aya-tab ${isActive ? "aya-tab--active" : ""} ${
                isDragging ? "aya-tab--dragging" : ""
              } ${isRemote ? "aya-tab--remote" : ""} ${dropClass}`}
              // Keep this in sync with the CSS fallback below. Tabs grow to
              // fill spare room, shrink to 120px, then overflow the strip.
              style={{
                flex: "1 1 240px",
                minWidth: TAB_MIN_WIDTH_PX,
                maxWidth: TAB_MAX_WIDTH_PX,
              }}
              draggable={!isRenaming}
              {...itemHandlers(p.slug)}
              onClick={() => !isRenaming && onSelectProject(p.slug)}
              onFocus={() => setFocusedProjectSlug(p.slug)}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === "Delete") {
                  e.preventDefault();
                  onCloseProject(p.slug);
                  return;
                }
                if (!isRemote) openTabMenuFromKeyboard(e, p.slug);
                handleRovingItemKeyDown(e, (target) => {
                  pendingRovingProjectFocus.current = target;
                  setFocusedProjectSlug(target.dataset.projectSlug ?? null);
                });
              }}
              onContextMenu={(e) => {
                // Remote projects can't be adopted by directory (it lives on
                // the remote host) - no move menu for them yet.
                if (!isRemote) openTabMenuFromMouse(e, p.slug);
              }}
              title={
                isRenaming
                  ? undefined
                  : `${p.name} - ${displayPath}${projectSummary ? ` · ${projectSummary}` : ""} · double-click to rename · drag to reorder`
              }
            >
              <span className="aya-tab-text">
                {isRenaming ? (
                  <input
                    ref={inputRef}
                    className="aya-tab-rename"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitRename();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        cancelRename();
                      }
                    }}
                    autoFocus
                  />
                ) : (
                  <span
                    className="aya-tab-name"
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      startRename(p);
                    }}
                  >
                    {isRemote && (
                      <span className="aya-tab-remote-chip" title={`Remote: ${p.remote?.label ?? "host"}`} aria-label={`Remote: ${p.remote?.label ?? "host"}`}>
                        <span aria-hidden="true" style={{ fontFamily: "Material Symbols Outlined" }}>lan</span>
                        Remote: {p.remote?.label ?? "host"}
                      </span>
                    )}
                    {p.name}
                  </span>
                )}
                <span
                  className={`aya-tab-path ${
                    projectSummary ? "aya-tab-path--summary" : ""
                  }`}
                >
                  {displayMeta}
                </span>
              </span>
              {badge && (
                <span
                  className={`aya-tab-bell aya-tab-bell--${badge.level}`}
                  title={`${badge.count} monitored session${badge.count > 1 ? "s" : ""}: ${badge.level}`}
                />
              )}
              <button
                type="button"
                className="aya-tab-close"
                  aria-hidden="true"
                  tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseProject(p.slug);
                }}
                aria-label={`Close project ${p.name}`}
                title={`Close project ${p.name}`}
              >
                ×
              </button>
            </div>
            );
          })}
        </div>
        <button
          type="button"
          className={`aya-tab-new ${blockChrome ? "aya-tab-new--disabled" : ""}`}
          title="New project"
          aria-label="New project"
          onClick={onNewProject}
          disabled={blockChrome}
        >
          <span style={{ fontFamily: "Material Symbols Outlined" }}>add</span>
        </button>
      </div>
      <div className="aya-topbar-right">
        {monitoredSessions.length > 0 && (
          <div className="aya-monitored-sessions" ref={sessionsRef}>
            <button
              className="aya-session-chip"
              title="Claude/Codex sessions"
              aria-label="Claude/Codex sessions"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setShowSessions((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={showSessions}
            >
              <span className="aya-session-chip-bars" aria-hidden="true">
                {(["error", "waiting", "active", "done"] as const).map((level) => {
                  const count = monitoredSessions.filter((s) => s.level === level).length;
                  return count > 0 ? (
                    <span
                      key={level}
                      className={`aya-session-chip-bar aya-session-chip-bar--${level}`}
                      style={{ flexGrow: count }}
                    />
                  ) : null;
                })}
              </span>
              <span>{monitoredSessions.length}</span>
            </button>
            {showSessions && (
              <div className="aya-session-menu" role="menu">
                <div className="aya-session-menu-title">Claude/Codex sessions</div>
                {monitoredSessions.slice(0, SESSION_MENU_LIMIT).map((session) => {
                  const project = projects.find((p) => p.slug === session.projectSlug);
                  const source = session.source === "codex" ? "Codex" : "Claude";
                  return (
                    <button
                      key={`${session.source}:${session.id}`}
                      className={`aya-session-menu-item aya-session-menu-item--${session.level}`}
                      role="menuitem"
                      onClick={() => {
                        setShowSessions(false);
                        onSelectProject(session.projectSlug);
                      }}
                    >
                      <span className="aya-session-dot" aria-hidden="true" />
                      <span className="aya-session-menu-main">
                        <span className="aya-session-menu-name">
                          {project?.name ?? session.projectName ?? session.sessionName ?? source}
                        </span>
                        <span className="aya-session-menu-detail">
                          {source} · {session.text}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
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
        {antigravityUsageAccounts.length > 0 && (
          <UsageChip
            accounts={antigravityUsageAccounts}
            label="Antigravity"
            accent="#4285f4"
            showHarnessName={showUsageHarnessName}
            quotaGroups
          />
        )}
        {grokUsage && (
          <GrokUsageChip
            usage={grokUsage}
            label="Grok"
            accent={GROK_BRAND_COLOR}
            showHarnessName={showUsageHarnessName}
          />
        )}
        <RecentProjectsMenu
          closedProjects={closedProjects}
          openProjects={projects}
          homeDir={homeDir}
          blockChrome={blockChrome}
          onOpenProject={onOpenProject}
          buttonClassName="aya-iconbtn"
        />
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
          aria-label="Settings"
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
      {tabMenu && (() => {
        const index = projects.findIndex((project) => project.slug === tabMenu.slug);
        return (
          <ProjectContextMenu
            menuRef={tabMenuRef}
            x={tabMenu.x}
            y={tabMenu.y}
            index={index}
            projectCount={projects.length}
            windows={tabMenu.windows}
            canMoveToWindow={!!onMoveProjectToWindow}
            onMove={(delta) => {
              setFocusProjectAfterMove({ slug: tabMenu.slug, index: index + delta });
              onReorderProjects(moveItem(projects.map((project) => project.slug), index, delta));
              closeTabMenu(false);
            }}
            onClose={() => { onCloseProject(tabMenu.slug); closeTabMenu(); }}
            onMoveToWindow={(target) => { onMoveProjectToWindow?.(tabMenu.slug, target); closeTabMenu(); }}
          />
        );
      })()}
    </header>
  );
}

/** Memoized: App re-renders on every poll tick / terminal status flip; with
 *  the derived props memoized in App (R1) and the handlers useCallback'd,
 *  the shallow compare lets the chrome skip those renders entirely. */
export const TopBar = memo(TopBarImpl);
