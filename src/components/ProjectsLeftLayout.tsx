import {
  RECENT_MENU_WIDTH_PX,
  MENU_VIEWPORT_EDGE_PX,
  MENU_ANCHOR_GAP_PX,
} from "../ui-constants";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { CLAUDE_BRAND_COLOR, CODEX_BRAND_COLOR, GROK_BRAND_COLOR } from "../colors";
import {
  getPreset,
  type GrokUsage,
  type Preset,
  type ProjectConfig,
  type TeamSummary,
  type TerminalState,
  type UsageAccount,
} from "../types";
import type { SettingsTab } from "../settings-tabs";
import { useDragReorder } from "../hooks/useDragReorder";
import { handleMenuNavigation, handleRovingItemKeyDown, isContextMenuKey, moveItem } from "../keyboard-navigation";
import { TerminalStatusDot } from "./TerminalStatusDot";
import { GrokUsageChip, UsageChip } from "./UsageChip";
import { LinuxWindowControls, MacWindowControls } from "./WindowControls";
import { paneRoles, unreadTotal } from "../team-view";
import { TeamRoleChip, TeamRoleMenuItems, TeamUnread } from "./TeamRole";

// Project rail width bounds (px) for the drag-resize handle.
const RAIL_MIN_WIDTH_PX = 160;
const RAIL_MAX_WIDTH_PX = 360;

interface ProjectAttention {
  count: number;
  level: "active" | "done" | "waiting" | "error";
}

const NO_TEAMS_BY_PROJECT: Record<string, TeamSummary[]> = {};

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
  /** Teams per project slug: role chips, rail unread sums, Team role items. */
  teamsByProject?: Record<string, TeamSummary[]>;
  onAssignTeamRole?: (team: string, role: string, paneId: string | null) => void;

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
  antigravityUsageAccounts?: UsageAccount[];
  grokUsage?: GrokUsage | null;
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
  teamsByProject = NO_TEAMS_BY_PROJECT,
  onAssignTeamRole,
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
  antigravityUsageAccounts = [],
  grokUsage = null,
  showUsageHarnessName,
  body,
}: Props) {
  const activeTeams = (activeProjectId && teamsByProject[activeProjectId]) || [];
  const roles = paneRoles(activeTeams);
  const [renamingSlug, setRenamingSlug] = useState<string | null>(null);
  const [focusedProjectSlug, setFocusedProjectSlug] = useState<string | null>(null);
  const [focusedTerminalId, setFocusedTerminalId] = useState<string | null>(null);
  const rovingProjectSlug = projects.some((project) => project.slug === focusedProjectSlug)
    ? focusedProjectSlug
    : activeProjectId;
  const rovingTerminalId = terminals.some((terminal) => terminal.id === focusedTerminalId)
    ? focusedTerminalId
    : activeTerminalId;
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
  const terminalMenuRef = useRef<HTMLDivElement>(null);
  const terminalMenuOpenerRef = useRef<HTMLElement | null>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const projectMenuOpenerRef = useRef<HTMLElement | null>(null);
  // Right-click menu on a project rail tab (multi-window move). The
  // other-windows list is fetched when the menu opens, so labels are current.
  const [projectMenu, setProjectMenu] = useState<{
    x: number;
    y: number;
    slug: string;
    windows: Array<{ id: number; activeProject: string | null }>;
  } | null>(null);
  const [focusProjectAfterMove, setFocusProjectAfterMove] = useState<{ slug: string; index: number } | null>(null);
  const [focusTerminalAfterMove, setFocusTerminalAfterMove] = useState<{ id: string; index: number } | null>(null);
  const [restoreTerminalFocusId, setRestoreTerminalFocusId] = useState<string | null>(null);
  const [restoreProjectFocusSlug, setRestoreProjectFocusSlug] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (!focusProjectAfterMove || projects.findIndex((project) => project.slug === focusProjectAfterMove.slug) !== focusProjectAfterMove.index) return;
    const slug = focusProjectAfterMove.slug;
    window.requestAnimationFrame(() => [...document.querySelectorAll<HTMLElement>(".aya-projectrail-list .aya-railtab[data-project-slug]")]
      .find((item) => item.dataset.projectSlug === slug)?.focus());
    setFocusProjectAfterMove(null);
  }, [focusProjectAfterMove, projects]);
  useLayoutEffect(() => {
    if (!focusTerminalAfterMove || terminals.findIndex((terminal) => terminal.id === focusTerminalAfterMove.id) !== focusTerminalAfterMove.index) return;
    const id = focusTerminalAfterMove.id;
    window.requestAnimationFrame(() => [...document.querySelectorAll<HTMLElement>('.aya-topbar--alt .aya-termtab-list [role="tab"][data-terminal-id]')]
      .find((item) => item.dataset.terminalId === id)?.focus());
    setFocusTerminalAfterMove(null);
  }, [focusTerminalAfterMove, terminals]);
  useLayoutEffect(() => {
    if (menu || !restoreTerminalFocusId) return;
    const id = restoreTerminalFocusId;
    window.requestAnimationFrame(() => [...document.querySelectorAll<HTMLElement>('.aya-topbar--alt .aya-termtab-list [role="tab"][data-terminal-id]')]
      .find((item) => item.dataset.terminalId === id)?.focus());
    setRestoreTerminalFocusId(null);
  }, [menu, restoreTerminalFocusId, terminals]);
  useLayoutEffect(() => {
    if (projectMenu || !restoreProjectFocusSlug) return;
    const slug = restoreProjectFocusSlug;
    window.requestAnimationFrame(() => [...document.querySelectorAll<HTMLElement>(".aya-projectrail-list .aya-railtab[data-project-slug]")]
      .find((item) => item.dataset.projectSlug === slug)?.focus());
    setRestoreProjectFocusSlug(null);
  }, [projectMenu, restoreProjectFocusSlug, projects]);

  const closeTerminalMenu = useCallback((restoreFocus = true) => {
    const opener = terminalMenuOpenerRef.current;
    const terminalId = opener?.dataset.terminalId;
    setRestoreTerminalFocusId(restoreFocus ? terminalId ?? null : null);
    setMenu(null);
  }, []);
  const closeProjectMenu = useCallback((restoreFocus = true) => {
    const opener = projectMenuOpenerRef.current;
    const projectSlug = opener?.dataset.projectSlug;
    setRestoreProjectFocusSlug(restoreFocus ? projectSlug ?? null : null);
    setProjectMenu(null);
  }, []);
  const openProjectContextMenu = (
    slug: string,
    opener: HTMLElement,
    x: number,
    y: number,
  ) => {
    projectMenuOpenerRef.current = opener;
    if (!onMoveProjectToWindow) {
      setProjectMenu({ x, y, slug, windows: [] });
      return;
    }
    void window.aya.listOtherWindows().then((windows) => {
      setProjectMenu({ x, y, slug, windows });
    });
  };

  useLayoutEffect(() => {
    if (projectMenu) projectMenuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [projectMenu]);
  useLayoutEffect(() => {
    if (menu) terminalMenuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [menu]);

  useEffect(() => {
    if (!projectMenu) return;
    const close = () => closeProjectMenu(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeProjectMenu();
      }
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [projectMenu, closeProjectMenu]);
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
    const close = () => closeTerminalMenu(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeTerminalMenu();
      }
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu, closeTerminalMenu]);

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
          <div className="aya-termtab-list" role="tablist" aria-label="Terminals">
          {terminals.map((t) => {
            const isActive = t.id === activeTerminalId;
            const preset = getPreset(presets, t.presetId);
            const remoteHost = t.remoteHost ?? projects.find((project) => project.slug === t.projectSlug)?.remote?.label;
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
                role="tab"
                aria-selected={isActive}
                tabIndex={rovingTerminalId === t.id ? 0 : -1}
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
                onFocus={() => setFocusedTerminalId(t.id)}
                onKeyDown={(e) => {
                  if (e.key === "Delete") {
                    e.preventDefault();
                    onCloseTerminal(t.id);
                    return;
                  }
                  if (isContextMenuKey(e.nativeEvent)) {
                    e.preventDefault();
                    terminalMenuOpenerRef.current = e.currentTarget;
                    const rect = e.currentTarget.getBoundingClientRect();
                    setMenu({ x: rect.left, y: rect.bottom, id: t.id });
                    return;
                  }
                  handleRovingItemKeyDown(e);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  terminalMenuOpenerRef.current = e.currentTarget;
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
                <TerminalStatusDot terminal={t} recentlyActive={recentlyActiveIds.has(t.id)} />
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
                      {remoteHost && (
                        <span className="aya-tab-remote-chip" title={`Remote: ${remoteHost}`} aria-label={`Remote: ${remoteHost}`}>
                          <span aria-hidden="true" style={{ fontFamily: "Material Symbols Outlined" }}>lan</span>
                          Remote: {remoteHost}
                        </span>
                      )}
                      {t.name}
                    </span>
                  )}
                  {!isRenaming && summary && (
                    <span className="aya-termtab-summary">{summary}</span>
                  )}
                  {roles[t.id] && <TeamRoleChip role={roles[t.id]} />}
                </span>
                {t.bell && <span className="aya-bell aya-bell--alert" />}
                <button
                  type="button"
                  className="aya-tab-close"
                  aria-hidden="true"
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTerminal(t.id);
                  }}
                  aria-label={`Close terminal ${t.name}`}
                  title={`Close terminal ${t.name}`}
                >
                  ×
                </button>
              </div>
            );
          })}
          </div>
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
      </header>
      <main
        className="aya-main aya-main--alt"
        style={{ gridTemplateColumns: `${railWidth}px 1fr` }}
      >
        <h1 className="aya-visually-hidden">Aya</h1>
        <nav className="aya-projectrail" aria-label="Projects and terminals" style={{ width: railWidth }}>
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
          <div className="aya-projectrail-list" role="list" aria-label="Projects">
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
              const teamUnread = unreadTotal(teamsByProject[p.slug] ?? []);
              return (
                <div
                  key={p.slug}
                  role="listitem"
                  data-project-slug={p.slug}
                  aria-current={isActive ? "true" : undefined}
                  tabIndex={rovingProjectSlug === p.slug ? 0 : -1}
                  data-testid="railtab"
                  className={`aya-railtab ${isActive ? "aya-railtab--active" : ""} ${
                    isDragging ? "aya-railtab--dragging" : ""
                  } ${isRemote ? "aya-railtab--remote" : ""} ${dropClass}`}
                  draggable={!isRenaming}
                  {...projectDragHandlers(p.slug)}
                  onClick={() => !isRenaming && onSelectProject(p.slug)}
                  onFocus={() => setFocusedProjectSlug(p.slug)}
                  onKeyDown={(e) => {
                    if (e.key === "Delete") {
                      e.preventDefault();
                      onCloseProject(p.slug);
                      return;
                    }
                    if (isContextMenuKey(e.nativeEvent)) {
                      if (isRemote) return;
                      e.preventDefault();
                      const rect = e.currentTarget.getBoundingClientRect();
                      openProjectContextMenu(p.slug, e.currentTarget, rect.right, rect.top);
                      return;
                    }
                    handleRovingItemKeyDown(e);
                  }}
                  onContextMenu={(e) => {
                    // Remote projects can't be adopted by directory (it lives
                    // on the remote host) - no move menu for them yet.
                    if (isRemote) return;
                    e.preventDefault();
                    openProjectContextMenu(p.slug, e.currentTarget, e.clientX, e.clientY);
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
                          <span className="aya-tab-remote-chip" title={`Remote: ${p.remote?.label ?? "host"}`} aria-label={`Remote: ${p.remote?.label ?? "host"}`}>
                            <span aria-hidden="true" style={{ fontFamily: "Material Symbols Outlined" }}>lan</span>
                            Remote: {p.remote?.label ?? "host"}
                          </span>
                        )}
                        {p.name}
                        <TeamUnread count={teamUnread} label={`${p.name} team messages waiting`} />
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
                  <button
                    type="button"
                    className="aya-railtab-close"
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
        </nav>
        {body}
      </main>
      {projectMenu && (
        <div
          ref={projectMenuRef}
          role="menu"
          className="aya-context-menu"
          style={{ left: projectMenu.x, top: projectMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={handleMenuNavigation}
        >
          {(() => {
            const index = projects.findIndex((project) => project.slug === projectMenu.slug);
            return <>
              <button type="button" role="menuitem" tabIndex={-1} disabled={index <= 0} className="aya-context-menu-item" onClick={() => {
                const slug = projectMenu.slug;
                setFocusProjectAfterMove({ slug, index: index - 1 });
                onReorderProjects(moveItem(projects.map((project) => project.slug), index, -1));
                closeProjectMenu(false);
              }}>Move left</button>
              <button type="button" role="menuitem" tabIndex={-1} disabled={index < 0 || index >= projects.length - 1} className="aya-context-menu-item" onClick={() => {
                const slug = projectMenu.slug;
                setFocusProjectAfterMove({ slug, index: index + 1 });
                onReorderProjects(moveItem(projects.map((project) => project.slug), index, 1));
                closeProjectMenu(false);
              }}>Move right</button>
              <button type="button" role="menuitem" tabIndex={-1} className="aya-context-menu-item aya-context-menu-item--danger" onClick={() => { onCloseProject(projectMenu.slug); closeProjectMenu(); }}>Close project</button>
            </>;
          })()}
          {onMoveProjectToWindow && <button type="button" role="menuitem" tabIndex={-1} className="aya-context-menu-item" onClick={() => { onMoveProjectToWindow(projectMenu.slug, "new"); closeProjectMenu(); }}>Move to New Window</button>}
          {onMoveProjectToWindow && projectMenu.windows.map((w) => (
            <button type="button" role="menuitem" tabIndex={-1}
              key={w.id}
              className="aya-context-menu-item"
              onClick={() => {
                onMoveProjectToWindow(projectMenu.slug, w.id);
                closeProjectMenu();
              }}
            >
              Move to Window: {w.activeProject ?? "(empty)"}
            </button>
          ))}
        </div>
      )}
      {menu && (
        <div
          ref={terminalMenuRef}
          role="menu"
          className="aya-context-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={handleMenuNavigation}
        >
          {(() => {
            const index = terminals.findIndex((terminal) => terminal.id === menu.id);
            return <>
              <button type="button" role="menuitem" tabIndex={-1} disabled={index <= 0} className="aya-context-menu-item" onClick={() => {
                const id = menu.id;
                setFocusTerminalAfterMove({ id, index: index - 1 });
                onReorderTerminals(moveItem(terminals.map((terminal) => terminal.id), index, -1));
                closeTerminalMenu(false);
              }}>Move left</button>
              <button type="button" role="menuitem" tabIndex={-1} disabled={index < 0 || index >= terminals.length - 1} className="aya-context-menu-item" onClick={() => {
                const id = menu.id;
                setFocusTerminalAfterMove({ id, index: index + 1 });
                onReorderTerminals(moveItem(terminals.map((terminal) => terminal.id), index, 1));
                closeTerminalMenu(false);
              }}>Move right</button>
            </>;
          })()}
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="aya-context-menu-item"
            onClick={() => {
              const terminal = terminals.find((t) => t.id === menu.id);
              if (terminal) startTermRename(terminal);
              closeTerminalMenu();
            }}
          >
            Rename terminal
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="aya-context-menu-item"
            disabled={!!terminals.find(t=>t.id===menu.id)?.recoveryBlocked}
            title={terminals.find(t=>t.id===menu.id)?.recoveryBlocked ? terminals.find(t=>t.id===menu.id)?.disconnectedReason ?? "Terminal host recovery is in progress" : undefined}
            onClick={() => {
              onRestartTerminal(menu.id);
              closeTerminalMenu();
            }}
          >
            Restart terminal{terminals.find(t=>t.id===menu.id)?.recoveryBlocked ? " - host recovering" : ""}
          </button>
          {/* Split actions are intentionally absent: this layout does not
              support split panes (see App's layoutMode gating). */}
          {onAssignTeamRole && (
            <TeamRoleMenuItems
              paneId={menu.id}
              teams={activeTeams}
              current={roles[menu.id]}
              onAssign={onAssignTeamRole}
              onDone={() => closeTerminalMenu()}
            />
          )}
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="aya-context-menu-item aya-context-menu-item--danger"
            onClick={() => {
              onCloseTerminal(menu.id);
              closeTerminalMenu();
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
