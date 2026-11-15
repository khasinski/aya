import { useEffect,useRef } from "react";
import { MIN_SPLIT_PANE_FRACTION,type DividerRect } from "../split-tree";

/** Pointer geometry is relative to this split's bounds, including nested splits. */
export function SplitResizeHandle({ divider, onResize }: {
  divider: DividerRect;
  onResize: (ratio: number) => void;
}) {
  const vertical = divider.direction === "row";
  const ratio = vertical
    ? (divider.rect.left - divider.bounds.left) / divider.bounds.width
    : (divider.rect.top - divider.bounds.top) / divider.bounds.height;
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  const resize = (next: number) => onResize(Math.max(MIN_SPLIT_PANE_FRACTION, Math.min(1 - MIN_SPLIT_PANE_FRACTION, next)));
  return <div
    role="separator"
    tabIndex={0}
    aria-label={vertical ? "Resize panes horizontally" : "Resize panes vertically"}
    aria-orientation={vertical ? "vertical" : "horizontal"}
    aria-valuemin={MIN_SPLIT_PANE_FRACTION * 100}
    aria-valuemax={(1 - MIN_SPLIT_PANE_FRACTION) * 100}
    aria-valuenow={Math.round(ratio * 100)}
    className={`aya-split-resize aya-split-resize--${vertical ? "col" : "row"}`}
    style={{ left: `${divider.rect.left}%`, top: `${divider.rect.top}%`, touchAction: "none",
      ...(vertical ? { height: `${divider.rect.height}%` } : { width: `${divider.rect.width}%` }) }}
    onKeyDown={event => {
      const decrease = vertical ? "ArrowLeft" : "ArrowUp";
      const increase = vertical ? "ArrowRight" : "ArrowDown";
      if (![decrease, increase, "Home", "End"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const step = event.shiftKey ? .1 : .02;
      resize(event.key === "Home" ? MIN_SPLIT_PANE_FRACTION : event.key === "End" ? 1 - MIN_SPLIT_PANE_FRACTION : ratio + (event.key === decrease ? -step : step));
    }}
    onPointerDown={event => {
      if (event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      cleanup.current?.();
      const node = event.currentTarget;
      const host = node.parentElement;
      if (!host) return;
      const hostRect = host.getBoundingClientRect();
      const { bounds } = divider;
      const span = vertical ? hostRect.width * bounds.width / 100 : hostRect.height * bounds.height / 100;
      const origin = vertical ? hostRect.left + hostRect.width * bounds.left / 100 : hostRect.top + hostRect.height * bounds.top / 100;
      if (span <= 0) return;
      node.focus(); node.setPointerCapture(event.pointerId);
      const pointerId = event.pointerId;
      const previousCursor = document.body.style.cursor;
      const previousSelect = document.body.style.userSelect;
      let frame: number | null = null;
      let pending: number | null = null;
      const flush = () => { frame = null; if (pending !== null) { resize(pending); pending = null; } };
      const move = (e: PointerEvent) => {
        if (e.pointerId !== pointerId) return;
        pending = ((vertical ? e.clientX : e.clientY) - origin) / span;
        if (frame === null) frame = requestAnimationFrame(flush);
      };
      const stop = () => {
        if (frame !== null) cancelAnimationFrame(frame);
        flush();
        node.removeEventListener("pointermove", move);
        node.removeEventListener("pointerup", finish);
        node.removeEventListener("pointercancel", finish);
        node.removeEventListener("lostpointercapture", stop);
        window.removeEventListener("blur", stop);
        if (node.hasPointerCapture(pointerId)) node.releasePointerCapture(pointerId);
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousSelect;
        document.body.classList.remove("aya-split-dragging");
        cleanup.current = null;
      };
      const finish = (e: PointerEvent) => { if (e.pointerId === pointerId) stop(); };
      cleanup.current = stop;
      document.body.style.cursor = vertical ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
      document.body.classList.add("aya-split-dragging");
      node.addEventListener("pointermove", move);
      node.addEventListener("pointerup", finish);
      node.addEventListener("pointercancel", finish);
      node.addEventListener("lostpointercapture", stop);
      window.addEventListener("blur", stop);
    }}
  />;
}
