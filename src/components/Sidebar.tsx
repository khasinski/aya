import { useEffect, useRef, useState, type DragEvent } from "react";
import { getPreset, type Preset, type TerminalState } from "../types";

interface Props {
  terminals: TerminalState[];
  activeId: string | null;
  sidebarWidth: number;
  presets: Preset[];
  // Set of terminal ids whose PTY emitted output in the last few seconds.
  // The status dot only pulses while in this set; otherwise it sits steady.
  recentlyActiveIds: Set<string>;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onLaunch: (preset: Preset) => void;
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
}

/** "Agent is waiting for input" indicator — small red dot, the same shape
 *  used on project tabs and the dock badge. */
function BellIcon() {
  return <span className="aya-bell aya-bell--alert" />;
}

export function Sidebar({
  terminals,
  activeId,
  sidebarWidth,
  presets,
  recentlyActiveIds,
  onSelect,
  onClose,
  onRename,
  onLaunch,
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

  // Vertical drag-and-drop state for reordering terminal rows.
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    id: string;
    before: boolean;
  } | null>(null);

  const handleRowDragStart = (
    e: DragEvent<HTMLDivElement>,
    id: string,
  ) => {
    setDragId(id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  };
  const handleRowDragOver = (
    e: DragEvent<HTMLDivElement>,
    id: string,
  ) => {
    if (!dragId || dragId === id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    setDropTarget((prev) =>
      prev && prev.id === id && prev.before === before
        ? prev
        : { id, before },
    );
  };
  const handleRowDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!dragId || !dropTarget) {
      setDragId(null);
      setDropTarget(null);
      return;
    }
    const order = terminals.map((t) => t.id);
    const fromIdx = order.indexOf(dragId);
    const targetIdx = order.indexOf(dropTarget.id);
    if (fromIdx < 0 || targetIdx < 0) {
      setDragId(null);
      setDropTarget(null);
      return;
    }
    order.splice(fromIdx, 1);
    let insertIdx = targetIdx;
    if (fromIdx < targetIdx) insertIdx -= 1;
    if (!dropTarget.before) insertIdx += 1;
    order.splice(insertIdx, 0, dragId);
    onReorder(order);
    setDragId(null);
    setDropTarget(null);
  };
  const handleRowDragEnd = () => {
    setDragId(null);
    setDropTarget(null);
  };

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
      const w = Math.max(180, Math.min(380, e.clientX));
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

  return (
    <aside className="aya-sidebar" style={{ width: sidebarWidth }}>
      <div className="aya-sidebar-header">
        <span>{terminals.length} terminals</span>
      </div>
      <div className="aya-sidebar-list">
        {terminals.map((t) => {
          const isActive = t.id === activeId;
          const preset = getPreset(presets, t.presetId);
          const isDragging = dragId === t.id;
          const isDropTarget = dropTarget?.id === t.id;
          const dropClass = isDropTarget
            ? dropTarget.before
              ? "aya-sidebar-row--drop-before"
              : "aya-sidebar-row--drop-after"
            : "";
          const isRenamingRow = renamingId === t.id;
          return (
            <div
              key={t.id}
              className={`aya-sidebar-row ${isActive ? "aya-sidebar-row--active" : ""} ${
                isDragging ? "aya-sidebar-row--dragging" : ""
              } ${dropClass}`}
              draggable={!isRenamingRow}
              onDragStart={(e) => handleRowDragStart(e, t.id)}
              onDragOver={(e) => handleRowDragOver(e, t.id)}
              onDrop={handleRowDrop}
              onDragEnd={handleRowDragEnd}
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
        })}
      </div>
      <div className="aya-launcher">
        <div className="aya-launcher-label">New terminal</div>
        <div className="aya-launcher-row">
          {presets.map((p) => (
            <button
              key={p.id}
              className="aya-launcher-btn"
              onClick={() => onLaunch(p)}
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
