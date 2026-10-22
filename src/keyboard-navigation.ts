import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/** Roving keyboard support for tablists and simple lists. Arrow keys move
 * focus; Enter and Space activate the focused item. */
export function handleRovingItemKeyDown(
  event: ReactKeyboardEvent<HTMLElement>,
): void {
  if (event.target !== event.currentTarget) return;
  const current = event.currentTarget;
  const list = current.closest<HTMLElement>('[role="tablist"], [role="list"]');
  if (!list) return;
  const selector = current.getAttribute("role") === "tab"
    ? '[role="tab"]'
    : '[role="listitem"][tabindex]';
  const items = [...list.querySelectorAll<HTMLElement>(selector)];
  const index = items.indexOf(current);
  if (index < 0) return;

  let targetIndex: number | null = null;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    targetIndex = (index + 1) % items.length;
  } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    targetIndex = (index - 1 + items.length) % items.length;
  } else if (event.key === "Home") {
    targetIndex = 0;
  } else if (event.key === "End") {
    targetIndex = items.length - 1;
  } else if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    current.click();
    return;
  }

  if (targetIndex === null || !items[targetIndex]) return;
  event.preventDefault();
  const target = items[targetIndex];
  for (const item of items) item.tabIndex = -1;
  target.tabIndex = 0;
  target.focus();
}

export function isContextMenuKey(event: Pick<KeyboardEvent, "key" | "shiftKey">): boolean {
  return (event.key === "F10" && event.shiftKey) || event.key === "ContextMenu";
}
