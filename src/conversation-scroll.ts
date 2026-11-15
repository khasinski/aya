/** Detect user movement before either a scroll event or a streaming layout can overwrite it.
 * A lower maximum means the browser clamped the viewport after a resize. */
export function movedUpFromFollowedPosition(top: number, maximum: number, followedTop: number | null): boolean {
  const epsilon = 0.01;
  return followedTop !== null && top < followedTop - epsilon && maximum >= followedTop - epsilon;
}

/** A nested tool/output scroller consumes its own wheel gestures. */
export function wheelTargetsConversation(target: EventTarget | null, viewport: HTMLElement, deltaY: number): boolean {
  let node = target instanceof Element ? target : null;
  if (!node || !viewport.contains(node)) return false;
  while (node && node !== viewport) {
    if (node instanceof HTMLElement) {
      const style = getComputedStyle(node);
      if (/auto|scroll/.test(style.overflowY)) {
        // Containment also traps native wheel gestures when the list is too
        // short to overflow; they must not change the outer follow state.
        if (/contain|none/.test(style.overscrollBehaviorY)) return false;
        const canMove = deltaY < 0 ? node.scrollTop > 0 : node.scrollTop + node.clientHeight < node.scrollHeight;
        if (canMove) return false;
      }
    }
    node = node.parentElement;
  }
  return viewport.scrollHeight > viewport.clientHeight;
}
