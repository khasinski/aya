import type { DividerRect } from "../split-tree";

/** Geometry lives in src/split-tree.ts; App only wires it to state.
 *  A divider is dragged in pixels and converted to a ratio against the area
 *  ITS split governs — measuring against the whole container would make a
 *  divider nested inside a half-width pane move at twice the pointer's speed. */
export function SplitResizeHandle({
  divider,
  onResize,
}: {
  divider: DividerRect;
  onResize: (ratio: number) => void;
}) {
  const vertical = divider.direction === "row";
  return (
    <div
      className={`aya-split-resize aya-split-resize--${vertical ? "col" : "row"}`}
      style={{
        left: `${divider.rect.left}%`,
        top: `${divider.rect.top}%`,
        ...(vertical
          ? { height: `${divider.rect.height}%` }
          : { width: `${divider.rect.width}%` }),
      }}
      onMouseDown={(event) => {
        event.preventDefault();
        const host = event.currentTarget.parentElement;
        if (!host) return;
        const hostRect = host.getBoundingClientRect();
        const { bounds } = divider;
        const spanPx = vertical
          ? (hostRect.width * bounds.width) / 100
          : (hostRect.height * bounds.height) / 100;
        const originPx = vertical
          ? hostRect.left + (hostRect.width * bounds.left) / 100
          : hostRect.top + (hostRect.height * bounds.top) / 100;
        if (spanPx <= 0) return;
        const move = (moveEvent: MouseEvent) => {
          const pointer = vertical ? moveEvent.clientX : moveEvent.clientY;
          onResize((pointer - originPx) / spanPx);
        };
        const up = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
          document.body.style.cursor = "";
        };
        document.body.style.cursor = vertical ? "col-resize" : "row-resize";
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      }}
    />
  );
}
