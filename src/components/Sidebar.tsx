import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import {
  getPreset,
  type Preset,
  type TerminalState,
  type Worktree,
} from "../types";
import { useDragReorder } from "../hooks/useDragReorder";

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
  /** Experimental worktrees: when enabled and the project has >1 worktree, the
   *  launcher offers a target worktree and rows show their branch. */
  worktreesEnabled?: boolean;
  worktrees?: Worktree[];
  /** The project's own directory (the "main" worktree cwd). */
  projectDir?: string;
  /** Create a worktree (opens a prompt). Absent = the action is hidden. */
  onCreateWorktree?: () => void;
  /** Remove a worktree. Never offered for the main checkout. */
  onRemoveWorktree?: (worktree: Worktree) => void;
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
}

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
  worktreesEnabled = false,
  worktrees = [],
  projectDir,
  onCreateWorktree,
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
}: Props) {
  // Right-click context menu state. Positioned at the cursor; closes on
  // outside click, Esc, or after the user picks an item.
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    terminalId: string;
  } | null>(null);

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
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Experimental worktrees: group terminals under their worktree, and launch new
  // terminals into the selected group. Only kicks in with >1 worktree; defaults
  // to the project's own dir (main), reset when the active project changes.
  // Shown whenever worktrees are enabled and the directory is a repo at all —
  // gating on >1 used to hide the section entirely, which left no way to
  // create the FIRST worktree.
  const showWorktrees = worktreesEnabled && worktrees.length > 0;
  const [targetCwd, setTargetCwd] = useState<string>(projectDir ?? "");
  useEffect(() => {
    setTargetCwd(projectDir ?? "");
  }, [projectDir]);
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
    return (
      <div
        key={t.id}
        data-testid="sidebar-terminal"
        data-terminal-id={t.id}
        data-terminal-name={t.name}
        className={`aya-sidebar-row ${isActive ? "aya-sidebar-row--active" : ""} ${
          isDragging ? "aya-sidebar-row--dragging" : ""
        } ${dropClass}`}
        draggable={!isRenamingRow}
        {...itemHandlers(t.id)}
        onClick={() => onSelect(t.id)}
        onContextMenu={(e) => {
          e.preventDefault();
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
        <span
          className={`aya-sidebar-statusdot aya-sidebar-statusdot--${t.status} ${
            recentlyActiveIds.has(t.id)
              ? "aya-sidebar-statusdot--blinking"
              : ""
          }`}
        />
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
              {t.name}
            </span>
          )}
          {!isRenamingRow && summary && (
            <span className="aya-sidebar-summary">{summary}</span>
          )}
        </span>
        {t.bell && <BellIcon />}
        {splitAssignments[t.id] !== undefined && (
          <span className="aya-sidebar-pane-chip">
            {splitAssignments[t.id] + 1}
          </span>
        )}
        <span
          className="aya-sidebar-close"
          onClick={(e) => {
            e.stopPropagation();
            onClose(t.id);
          }}
          title="Close terminal"
        >
          ×
        </span>
      </div>
    );
  };

  return (
    <aside className="aya-sidebar" style={{ width: sidebarWidth }}>
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
                        onRemoveWorktree(g.worktree);
                      }}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter" && e.key !== " ") return;
                        e.stopPropagation();
                        onRemoveWorktree(g.worktree);
                      }}
                    >
                      ×
                    </span>
                  )}
                </button>
                {g.terminals.length > 0 ? (
                  g.terminals.map(renderRow)
                ) : (
                  <div className="aya-worktree-empty">No terminals yet</div>
                )}
              </div>
            ))
          : terminals.map(renderRow)}
        {groups && onCreateWorktree && (
          <button
            type="button"
            className="aya-worktree-add"
            onClick={onCreateWorktree}
            title="Create a new git worktree for this repository"
          >
            + New worktree…
          </button>
        )}
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
          className="aya-context-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="aya-context-menu-item"
            onClick={() => {
              const terminal = terminals.find((t) => t.id === menu.terminalId);
              if (terminal) startRename(terminal);
              setMenu(null);
            }}
          >
            Rename terminal
          </button>
          <button
            className="aya-context-menu-item"
            onClick={() => {
              onRestart(menu.terminalId);
              setMenu(null);
            }}
          >
            Restart terminal
          </button>
          <button
            className="aya-context-menu-item"
            onClick={() => {
              onAssignToSplit(menu.terminalId);
              setMenu(null);
            }}
          >
            Show in active pane
          </button>
          {canSplitRight && (
            <button
              className="aya-context-menu-item"
              onClick={() => {
                onSplitRight(menu.terminalId);
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
                onSplitBelow(menu.terminalId);
                setMenu(null);
              }}
            >
              Split below
            </button>
          )}
          {splitAssignments[menu.terminalId] !== undefined && (
            <button
              className="aya-context-menu-item"
              onClick={() => {
                onRemoveFromSplit(menu.terminalId);
                setMenu(null);
              }}
            >
              Remove from split
            </button>
          )}
          <button
            className="aya-context-menu-item aya-context-menu-item--danger"
            onClick={() => {
              onClose(menu.terminalId);
              setMenu(null);
            }}
          >
            Close terminal
          </button>
        </div>
      )}
    </aside>
  );
}

/** Memoized: App re-renders on every poll tick / terminal status flip; with
 *  the derived props memoized in App (R1) and the handlers useCallback'd,
 *  the shallow compare lets the chrome skip those renders entirely. */
export const Sidebar = memo(SidebarImpl);
