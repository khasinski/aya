import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  getPreset,
  type Preset,
  type TeamSummary,
  type TerminalState,
  type Worktree,
} from "../types";
import { useDragReorder } from "../hooks/useDragReorder";
import { handleMenuNavigation, handleRovingItemKeyDown, isContextMenuKey, moveItem } from "../keyboard-navigation";
import { paneRoles } from "../team-view";
import { TerminalStatusDot } from "./TerminalStatusDot";
import { TeamRoleChip, TeamRoleMenuItems } from "./TeamRole";
import { WorktreeCreateDialog, WorktreeRemoveDialog } from "./WorktreeDialogs";

// Clamp bounds for drag-resizing the sidebar (px).
const SIDEBAR_MIN_WIDTH_PX = 180;
const SIDEBAR_MAX_WIDTH_PX = 380;

interface Props {
  terminals: TerminalState[];
  activeId: string | null;
  sidebarWidth: number;
  presets: Preset[];
  // Set of terminal ids whose PTY emitted output in the last few seconds.
  // The status dot only pulses while in this set; otherwise it sits steady.
  recentlyActiveIds: ReadonlySet<string>;
  summaries?: Record<string, string>;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onRename: (id: string, name: string) => void;
  /** Launch a preset. `cwd` targets a git worktree; omitted = the project dir. */
  onLaunch: (preset: Preset, cwd?: string) => void;
  worktrees?: Worktree[];
  /** The project's own directory (the "main" worktree cwd). */
  projectDir?: string;
  projectId?: string;
  projectRemote?: boolean;
  projectRemoteHost?: string;
  onCreateWorktrees?: (req: { directory: string; slug: string; count: number; base: string }) => Promise<{ created: { path: string; branch: string }[]; errors: string[] }>;
  onStartWorktrees?: (projectId: string, preset: Preset, checkouts: { path: string; branch: string }[], prompt: string) => void;
  /** Remove a worktree. Never offered for the main checkout. */
  onRemoveWorktree?: (req: { directory: string; path: string; base: string; deleteBranch: boolean; expectedBranch: string | null }) => Promise<{ ok: true; path: string; branchDeleted: boolean } | { ok: false; error: string }>;
  onResize: (width: number) => void;
  /** Called with the new id order after a successful drag-drop. Only fires
   *  when the order actually changed. */
  onReorder: (orderedIds: string[]) => void;
  /** Kill + re-spawn the PTY for this terminal (right-click → Restart). */
  onRestart: (id: string) => void;
  splitAssignments?: Record<string, number>;
  canSplitRight: boolean;
  canSplitBelow: boolean;
  onAssignToSplit: (id: string) => void;
  onSplitRight: (id: string) => void;
  onSplitBelow: (id: string) => void;
  onRemoveFromSplit: (id: string) => void;
  /** Cross-project attention summary. Kept inside the sidebar so appearing
   *  notifications never reduce the terminal viewport height. */
  statusRail?: ReactNode;
  /** This project's teams, for role chips and the tab menu's Team role items. */
  teams?: TeamSummary[];
  onAssignTeamRole?: (team: string, role: string, paneId: string | null) => void;
}

const NO_TEAMS: TeamSummary[] = [];

/** "Agent is waiting for input" indicator — small red dot, the same shape
 *  used on project tabs and the dock badge. */
function BellIcon() {
  return <span className="aya-bell aya-bell--alert" />;
}

function SidebarImpl({
  terminals,
  activeId,
  sidebarWidth,
  presets,
  recentlyActiveIds,
  summaries = {},
  onSelect,
  onClose,
  onRename,
  onLaunch,
  worktrees = [],
  projectDir,
  projectId,
  projectRemote = false,
  projectRemoteHost,
  onCreateWorktrees,
  onStartWorktrees,
  onRemoveWorktree,
  onResize,
  onReorder,
  onRestart,
  splitAssignments = {},
  canSplitRight,
  canSplitBelow,
  onAssignToSplit,
  onSplitRight,
  onSplitBelow,
  onRemoveFromSplit,
  statusRail,
  teams = NO_TEAMS,
  onAssignTeamRole,
}: Props) {
  const roles = paneRoles(teams);
  // Right-click context menu state. Positioned at the cursor; closes on
  // outside click, Esc, or after the user picks an item.
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    terminalId: string;
  } | null>(null);
  const mobileLauncherRef = useRef<HTMLDivElement>(null);
  const [showMobileLauncher, setShowMobileLauncher] = useState(false);
  const [focusTerminalAfterMove, setFocusTerminalAfterMove] = useState<{ id: string; index: number } | null>(null);
  const [restoreMenuFocusId, setRestoreMenuFocusId] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (!focusTerminalAfterMove || terminals.findIndex((terminal) => terminal.id === focusTerminalAfterMove.id) !== focusTerminalAfterMove.index) return;
    const id = focusTerminalAfterMove.id;
    window.requestAnimationFrame(() => [...document.querySelectorAll<HTMLElement>(".aya-sidebar-row[data-terminal-id]")]
      .find((row) => row.dataset.terminalId === id)?.focus());
    setFocusTerminalAfterMove(null);
  }, [focusTerminalAfterMove, terminals]);
  useLayoutEffect(() => {
    if (menu || !restoreMenuFocusId) return;
    const id = restoreMenuFocusId;
    [...document.querySelectorAll<HTMLElement>(".aya-sidebar-row[data-terminal-id]")]
      .find((row) => row.dataset.terminalId === id)?.focus();
    setRestoreMenuFocusId(null);
  }, [menu, restoreMenuFocusId, terminals]);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuOpenerRef = useRef<HTMLElement | null>(null);
  const closeMenu = useCallback((restoreFocus = true) => {
    const opener = menuOpenerRef.current;
    setRestoreMenuFocusId(restoreFocus ? opener?.dataset.terminalId ?? null : null);
    setMenu(null);
  }, []);

  useLayoutEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const close = () => closeMenu(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
      }
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu, closeMenu]);
  useEffect(() => {
    if (!showMobileLauncher) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!mobileLauncherRef.current?.contains(event.target as Node)) setShowMobileLauncher(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowMobileLauncher(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [showMobileLauncher]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [focusedTerminalId, setFocusedTerminalId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rovingTerminalId = terminals.some((terminal) => terminal.id === focusedTerminalId)
    ? focusedTerminalId
    : activeId;

  // Worktrees are available for local repositories without an opt-in flag.
  const showWorktrees = worktrees.length > 0;
  const [targetCwd, setTargetCwd] = useState<string>(projectDir ?? "");
  const [createWorktreeTarget, setCreateWorktreeTarget] = useState<{
    projectId: string;
    projectDir: string;
  } | null>(null);
  const [removeWorktreeTarget, setRemoveWorktreeTarget] = useState<Worktree | null>(null);
  useEffect(() => {
    setTargetCwd(projectDir ?? "");
  }, [projectDir]);
  useEffect(() => {
    if (
      createWorktreeTarget &&
      (createWorktreeTarget.projectId !== (projectId ?? "") ||
        createWorktreeTarget.projectDir !== projectDir)
    ) {
      setCreateWorktreeTarget(null);
    }
  }, [createWorktreeTarget, projectDir, projectId]);
  const worktreeName = (p: string): string =>
    p.replace(/\/+$/, "").split("/").pop() || p;
  // One section per worktree (main first). Terminals whose cwd matches no known
  // worktree fall under the main/project section so nothing goes missing.
  const wtPaths = new Set(worktrees.map((w) => w.path));
  const groups = showWorktrees
    ? worktrees.map((w) => ({
        worktree: w,
        terminals: terminals.filter(
          (t) => t.cwd === w.path || (w.isMain && !wtPaths.has(t.cwd)),
        ),
      }))
    : null;

  // Vertical drag-and-drop for reordering terminal rows.
  const { dragId, dropTarget, itemHandlers } = useDragReorder(
    "y",
    terminals.map((t) => t.id),
    onReorder,
  );

  const startRename = (t: TerminalState) => {
    setRenamingId(t.id);
    setDraft(t.name);
    setTimeout(() => inputRef.current?.select(), 0);
  };
  const commit = () => {
    if (renamingId) {
      const trimmed = draft.trim();
      if (trimmed) onRename(renamingId, trimmed);
    }
    setRenamingId(null);
  };
  const cancel = () => setRenamingId(null);

  // Drag-resize the sidebar.
  const resizing = useRef(false);
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!resizing.current) return;
      const w = Math.max(SIDEBAR_MIN_WIDTH_PX, Math.min(SIDEBAR_MAX_WIDTH_PX, e.clientX));
      onResize(w);
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
  }, [onResize]);

  const renderRow = (t: TerminalState) => {
    const isActive = t.id === activeId;
    const preset = getPreset(presets, t.presetId);
    const isDragging = dragId === t.id;
    const isDropTarget = dropTarget?.id === t.id;
    const summary = summaries[t.id]?.trim();
    const dropClass = isDropTarget
      ? dropTarget.before
        ? "aya-sidebar-row--drop-before"
        : "aya-sidebar-row--drop-after"
      : "";
    const isRenamingRow = renamingId === t.id;
    const remoteHost = t.remoteHost ?? (projectRemote ? projectRemoteHost : undefined);
    return (
      <div
        key={t.id}
        data-testid="sidebar-terminal"
        data-terminal-id={t.id}
        data-terminal-name={t.name}
        className={`aya-sidebar-row ${isActive ? "aya-sidebar-row--active" : ""} ${
          isDragging ? "aya-sidebar-row--dragging" : ""
        } ${dropClass}`}
        role="listitem"
        aria-current={isActive ? "true" : undefined}
        tabIndex={rovingTerminalId === t.id ? 0 : -1}
        draggable={!isRenamingRow}
        {...itemHandlers(t.id)}
        onClick={() => onSelect(t.id)}
        onFocus={() => setFocusedTerminalId(t.id)}
        onKeyDown={(e) => {
          if (e.key === "Delete") {
            e.preventDefault();
            onClose(t.id);
            return;
          }
          if (isContextMenuKey(e.nativeEvent)) {
            e.preventDefault();
            menuOpenerRef.current = e.currentTarget;
            const rect = e.currentTarget.getBoundingClientRect();
            setMenu({ x: rect.left, y: rect.bottom, terminalId: t.id });
            return;
          }
          handleRovingItemKeyDown(e);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          menuOpenerRef.current = e.currentTarget;
          setMenu({ x: e.clientX, y: e.clientY, terminalId: t.id });
        }}
        title={`${t.name} — ${t.cwd}`}
      >
        <span
          className="aya-sidebar-icon"
          style={preset.color ? { color: preset.color } : undefined}
        >
          {preset.icon}
        </span>
        <TerminalStatusDot terminal={t} recentlyActive={recentlyActiveIds.has(t.id)} />
        <span className="aya-sidebar-copy">
          {renamingId === t.id ? (
            <input
              ref={inputRef}
              className="aya-sidebar-rename"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancel();
                }
              }}
              autoFocus
            />
          ) : (
            <span
              className="aya-sidebar-name"
              onDoubleClick={(e) => {
                e.stopPropagation();
                startRename(t);
              }}
              title="Double-click to rename"
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
          {!isRenamingRow && summary && (
            <span className="aya-sidebar-summary">{summary}</span>
          )}
          {roles[t.id] && <TeamRoleChip role={roles[t.id]} />}
        </span>
        {t.bell && <BellIcon />}
        {splitAssignments[t.id] !== undefined && (
          <span className="aya-sidebar-pane-chip">
            {splitAssignments[t.id] + 1}
          </span>
        )}
        <button
          type="button"
          className="aya-sidebar-close"
          aria-hidden="true"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            onClose(t.id);
          }}
          aria-label={`Close terminal ${t.name}`}
          title={`Close terminal ${t.name}`}
        >
          ×
        </button>
      </div>
    );
  };

  return (
    <nav className="aya-sidebar" aria-label="Terminals" style={{ width: sidebarWidth }}>
      <div className="aya-sidebar-header">
        <span>{terminals.length} terminals</span>
      </div>
      <div className="aya-sidebar-list">
        {groups
          ? groups.map((g) => (
              <div key={g.worktree.path} className="aya-worktree-group">
                <button
                  type="button"
                  className={`aya-worktree-header ${
                    targetCwd === g.worktree.path
                      ? "aya-worktree-header--target"
                      : ""
                  }`}
                  onClick={() => setTargetCwd(g.worktree.path)}
                  title={`${g.worktree.path}${
                    g.worktree.branch ? ` · ${g.worktree.branch}` : ""
                  }\nClick to launch new terminals in this worktree`}
                >
                  <span className="aya-worktree-header-icon">⑂</span>
                  <span className="aya-worktree-header-name">
                    {worktreeName(g.worktree.path)}
                  </span>
                  {g.worktree.branch && !g.worktree.isMain && (
                    <span className="aya-worktree-header-branch">{g.worktree.branch}</span>
                  )}
                  {g.worktree.isMain && (
                    <span className="aya-worktree-header-tag">main</span>
                  )}
                  {g.worktree.prunable && (
                    <span className="aya-worktree-header-tag aya-worktree-header-tag--warn">
                      stale
                    </span>
                  )}
                  {!g.worktree.isMain && onRemoveWorktree && (
                    <span
                      role="button"
                      tabIndex={0}
                      className="aya-worktree-header-remove"
                      title={`Remove worktree ${worktreeName(g.worktree.path)}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setRemoveWorktreeTarget(g.worktree);
                      }}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter" && e.key !== " ") return;
                        e.stopPropagation();
                        setRemoveWorktreeTarget(g.worktree);
                      }}
                    >
                      ×
                    </span>
                  )}
                </button>
                {g.terminals.length > 0 ? (
                  <div role="list" aria-label={`Terminals in ${worktreeName(g.worktree.path)}`}>
                    {g.terminals.map(renderRow)}
                  </div>
                ) : (
                  <div className="aya-worktree-empty">No terminals yet</div>
                )}
              </div>
            ))
          : <div role="list" aria-label="Terminals">{terminals.map(renderRow)}</div>}
        {(groups || projectRemote || onCreateWorktrees) && (
          <button
            type="button"
            className="aya-worktree-add"
            onClick={projectRemote || !projectDir ? undefined : () => setCreateWorktreeTarget({ projectId: projectId ?? "", projectDir })}
            disabled={projectRemote || !onCreateWorktrees || !onStartWorktrees}
            title={projectRemote ? "Worktrees are available for local projects only" : "Create worktrees for this repository"}
          >
            + New worktrees{projectRemote ? " · available for local projects" : "…"}
          </button>
        )}
        <div className="aya-mobile-pane-add" ref={mobileLauncherRef}>
          <button type="button" aria-label="New terminal" title="New terminal" aria-haspopup="menu" aria-expanded={showMobileLauncher} onClick={() => setShowMobileLauncher((open) => !open)}>
            <span aria-hidden="true">+</span>
          </button>
          {showMobileLauncher && (
            <div className="aya-recent-menu aya-mobile-pane-launch-menu" role="menu" aria-label="New terminal">
              <div className="aya-recent-menu-title">New terminal</div>
              {presets.map((preset) => (
                <button key={preset.id} type="button" role="menuitem" className="aya-recent-menu-item" onClick={() => {
                  setShowMobileLauncher(false);
                  onLaunch(preset, showWorktrees && targetCwd ? targetCwd : undefined);
                }}>
                  <span className="aya-launcher-btn-icon" style={preset.color ? { color: preset.color } : undefined}>{preset.icon}</span>
                  <span className="aya-recent-menu-name">{preset.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="aya-launcher">
        <div className="aya-launcher-label">
          {showWorktrees ? (
            <>
              New terminal in{" "}
              <span className="aya-launcher-target">⑂ {worktreeName(targetCwd)}</span>
            </>
          ) : (
            "New terminal"
          )}
        </div>
        <div className="aya-launcher-row">
          {presets.map((p) => (
            <button
              key={p.id}
              className="aya-launcher-btn"
              onClick={() =>
                onLaunch(p, showWorktrees && targetCwd ? targetCwd : undefined)
              }
              title={p.command}
            >
              <span
                className="aya-launcher-btn-icon"
                style={p.color ? { color: p.color } : undefined}
              >
                {p.icon}
              </span>
              <span className="aya-launcher-btn-name">{p.name}</span>
            </button>
          ))}
        </div>
        {statusRail}
      </div>
      {createWorktreeTarget &&
        createWorktreeTarget.projectId === (projectId ?? "") &&
        createWorktreeTarget.projectDir === projectDir &&
        onCreateWorktrees && onStartWorktrees && (
        <WorktreeCreateDialog
          projectId={createWorktreeTarget.projectId}
          projectDir={createWorktreeTarget.projectDir}
          presets={presets}
          onCancel={() => setCreateWorktreeTarget(null)}
          onCreate={onCreateWorktrees}
          onStart={onStartWorktrees}
        />
      )}
      {removeWorktreeTarget && projectDir && onRemoveWorktree && (
        <WorktreeRemoveDialog
          projectDir={projectDir}
          base={worktrees.find((w) => w.isMain)?.branch ?? "HEAD"}
          worktree={removeWorktreeTarget}
          onCancel={() => setRemoveWorktreeTarget(null)}
          onRemove={onRemoveWorktree}
          onRemoved={() => setRemoveWorktreeTarget(null)}
        />
      )}
      <div
        className="aya-sidebar-resize"
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: sidebarWidth - 2,
          width: 4,
        }}
        onMouseDown={() => {
          resizing.current = true;
          document.body.style.cursor = "col-resize";
        }}
      />
      {menu && (
        <div
          ref={menuRef}
          role="menu"
          className="aya-context-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={handleMenuNavigation}
        >
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="aya-context-menu-item"
            onClick={() => {
              const terminal = terminals.find((t) => t.id === menu.terminalId);
              if (terminal) startRename(terminal);
              // The rename input is the next focus target; do not restore focus
              // to the row while it is opening or its blur handler commits it.
              closeMenu(false);
            }}
          >
            Rename terminal
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="aya-context-menu-item"
            disabled={!!terminals.find(t=>t.id===menu.terminalId)?.recoveryBlocked}
            title={terminals.find(t=>t.id===menu.terminalId)?.recoveryBlocked ? terminals.find(t=>t.id===menu.terminalId)?.disconnectedReason ?? "Terminal host recovery is in progress" : undefined}
            onClick={() => {
              onRestart(menu.terminalId);
              closeMenu();
            }}
          >
            Restart terminal{terminals.find(t=>t.id===menu.terminalId)?.recoveryBlocked ? " - host recovering" : ""}
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="aya-context-menu-item"
            onClick={() => {
              onAssignToSplit(menu.terminalId);
              closeMenu();
            }}
          >
            Show in active pane
          </button>
          {(() => {
            const index = terminals.findIndex((terminal) => terminal.id === menu.terminalId);
            return (
              <>
                <button type="button" role="menuitem" tabIndex={-1} disabled={index <= 0} className="aya-context-menu-item" onClick={() => {
                  const id = menu.terminalId;
                  setFocusTerminalAfterMove({ id, index: index - 1 });
                  onReorder(moveItem(terminals.map((terminal) => terminal.id), index, -1));
                  closeMenu(false);
                }}>Move up</button>
                <button type="button" role="menuitem" tabIndex={-1} disabled={index < 0 || index >= terminals.length - 1} className="aya-context-menu-item" onClick={() => {
                  const id = menu.terminalId;
                  setFocusTerminalAfterMove({ id, index: index + 1 });
                  onReorder(moveItem(terminals.map((terminal) => terminal.id), index, 1));
                  closeMenu(false);
                }}>Move down</button>
              </>
            );
          })()}
          {canSplitRight && (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="aya-context-menu-item"
              onClick={() => {
                onSplitRight(menu.terminalId);
                closeMenu();
              }}
            >
              Split right
            </button>
          )}
          {canSplitBelow && (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="aya-context-menu-item"
              onClick={() => {
                onSplitBelow(menu.terminalId);
                closeMenu();
              }}
            >
              Split below
            </button>
          )}
          {splitAssignments[menu.terminalId] !== undefined && (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="aya-context-menu-item"
              onClick={() => {
                onRemoveFromSplit(menu.terminalId);
                closeMenu();
              }}
            >
              Remove from split
            </button>
          )}
          {onAssignTeamRole && (
            <TeamRoleMenuItems
              paneId={menu.terminalId}
              teams={teams}
              current={roles[menu.terminalId]}
              onAssign={onAssignTeamRole}
              onDone={() => closeMenu()}
            />
          )}
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="aya-context-menu-item aya-context-menu-item--danger"
            onClick={() => {
              onClose(menu.terminalId);
              closeMenu();
            }}
          >
            Close terminal
          </button>
        </div>
      )}
    </nav>
  );
}

/** Memoized: App re-renders on every poll tick / terminal status flip; with
 *  the derived props memoized in App (R1) and the handlers useCallback'd,
 *  the shallow compare lets the chrome skip those renders entirely. */
export const Sidebar = memo(SidebarImpl);
