import { useRef, useState, type DragEvent } from "react";

export interface DropTarget {
  id: string;
  before: boolean;
}

export interface DragReorder {
  dragId: string | null;
  dropTarget: DropTarget | null;
  /** Spread onto each draggable item. Callers still set `draggable` themselves
   *  (they know per-item state like "is renaming"). */
  itemHandlers: (id: string) => {
    onDragStart: (e: DragEvent) => void;
    onDragOver: (e: DragEvent) => void;
    onDrop: (e: DragEvent) => void;
    onDragEnd: () => void;
  };
}

/** Shared HTML5 drag-to-reorder used by the project tabs (horizontal), the
 *  terminal list (vertical), and both strips in the alternative layout. The
 *  splice math is identical everywhere; only the axis differs. `order` is the
 *  current id ordering; `onReorder` fires with the new ordering on drop. */
export function useDragReorder(
  axis: "x" | "y",
  order: string[],
  onReorder: (ordered: string[]) => void,
): DragReorder {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  // Read the latest ordering at drop time without rebinding handlers per item.
  const orderRef = useRef(order);
  orderRef.current = order;

  const reset = () => {
    setDragId(null);
    setDropTarget(null);
  };

  const itemHandlers = (id: string) => ({
    onDragStart: (e: DragEvent) => {
      setDragId(id);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", id);
    },
    onDragOver: (e: DragEvent) => {
      if (!dragId || dragId === id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const before =
        axis === "x"
          ? e.clientX < rect.left + rect.width / 2
          : e.clientY < rect.top + rect.height / 2;
      setDropTarget((prev) =>
        prev && prev.id === id && prev.before === before ? prev : { id, before },
      );
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      if (dragId && dropTarget) {
        const next = [...orderRef.current];
        const fromIdx = next.indexOf(dragId);
        const targetIdx = next.indexOf(dropTarget.id);
        if (fromIdx >= 0 && targetIdx >= 0) {
          next.splice(fromIdx, 1);
          let insertIdx = targetIdx;
          if (fromIdx < targetIdx) insertIdx -= 1;
          if (!dropTarget.before) insertIdx += 1;
          next.splice(insertIdx, 0, dragId);
          onReorder(next);
        }
      }
      reset();
    },
    onDragEnd: reset,
  });

  return { dragId, dropTarget, itemHandlers };
}
