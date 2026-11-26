// The body of a pane while it switches between terminal and Conversation (src/pane-mode-transition.ts): one calm
// placeholder over whichever view is mounted, the same size as the pane and below its header, which stays live.
// It fades in over the old view, holds while the agent restarts underneath, and fades out over the new one.

import { useLayoutEffect, useRef, type CSSProperties } from "react";
import type { PaneModeTransition } from "../pane-mode-transition";
import { paneHeaderElement } from "./PaneHeader";

export function PaneModeVeil({ terminalId, transition, style }: { terminalId: string; transition: PaneModeTransition; style?: CSSProperties }) {
  const veil = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  // Leave the header uncovered when it sits at the top of the pane (not in the stacked layout's top bar).
  useLayoutEffect(() => {
    const outer = veil.current, inner = body.current;
    if (!outer || !inner) return;
    const header = paneHeaderElement(terminalId);
    const v = outer.getBoundingClientRect(), h = header.getBoundingClientRect();
    const inside = header.isConnected && h.height > 0 && h.top >= v.top - 1 && h.bottom <= v.bottom && h.left < v.right && h.right > v.left;
    inner.style.top = `${inside ? Math.max(0, h.bottom - v.top) : 0}px`;
  });
  return (
    <div ref={veil} className="aya-pane-mode-veil" data-phase={transition.phase} data-terminal-id={terminalId} style={style}>
      <div ref={body} className="aya-pane-mode-veil-body" role="status" aria-live="polite" data-testid="pane-mode-veil">
        <span className="aya-pane-mode-veil-spinner" aria-hidden="true" />
        <strong>{transition.title}</strong>
        <small>{transition.detail}</small>
      </div>
    </div>
  );
}
