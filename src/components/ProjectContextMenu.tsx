import type { RefObject } from "react";
import { handleMenuNavigation } from "../keyboard-navigation";

/** The right-click menu of a project tab or rail avatar. State and focus handling stay with the
 *  caller (each layout restores focus to its own tab element); this is the shared markup. */
export function ProjectContextMenu({
  menuRef,
  x,
  y,
  index,
  projectCount,
  windows,
  canMoveToWindow,
  onMove,
  onClose,
  onMoveToWindow,
}: {
  menuRef?: RefObject<HTMLDivElement | null>;
  x: number;
  y: number;
  /** Position of the project among the open ones; -1 when it is gone. */
  index: number;
  projectCount: number;
  windows: Array<{ id: number; activeProject: string | null }>;
  /** False when moving to another window is unavailable (no handler, or a remote project). */
  canMoveToWindow: boolean;
  onMove: (delta: -1 | 1) => void;
  onClose: () => void;
  onMoveToWindow: (target: "new" | number) => void;
}) {
  return (
    <div
      ref={menuRef}
      role="menu"
      className="aya-context-menu"
      style={{ left: x, top: y }}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={handleMenuNavigation}
    >
      <button type="button" role="menuitem" tabIndex={-1} disabled={index <= 0} className="aya-context-menu-item" onClick={() => onMove(-1)}>Move left</button>
      <button type="button" role="menuitem" tabIndex={-1} disabled={index < 0 || index >= projectCount - 1} className="aya-context-menu-item" onClick={() => onMove(1)}>Move right</button>
      <button type="button" role="menuitem" tabIndex={-1} className="aya-context-menu-item aya-context-menu-item--danger" onClick={onClose}>Close project</button>
      {canMoveToWindow && (
        <button type="button" role="menuitem" tabIndex={-1} className="aya-context-menu-item" onClick={() => onMoveToWindow("new")}>Move to New Window</button>
      )}
      {canMoveToWindow && windows.map((w) => (
        <button type="button" role="menuitem" tabIndex={-1} key={w.id} className="aya-context-menu-item" onClick={() => onMoveToWindow(w.id)}>
          Move to Window: {w.activeProject ?? "(empty)"}
        </button>
      ))}
    </div>
  );
}
