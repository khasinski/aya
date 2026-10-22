import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/** Roving keyboard support for tablists and simple lists. Arrow keys move
 * focus; Enter and Space activate the focused item. */
export function handleRovingItemKeyDown(
  event: ReactKeyboardEvent<HTMLElement>,
  onMoveFocus?: (target: HTMLElement) => void,
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
  if (onMoveFocus) {
    onMoveFocus(target);
    return;
  }
  for (const item of items) item.tabIndex = -1;
  target.tabIndex = 0;
  target.focus();
}

export function isContextMenuKey(event: Pick<KeyboardEvent, "key" | "shiftKey">): boolean {
  return (event.key === "F10" && event.shiftKey) || event.key === "ContextMenu";
}

/** Arrow-key behavior for a focused menu item in a custom context menu. */
export function handleMenuNavigation(event: ReactKeyboardEvent<HTMLElement>): void {
  if (event.key === "Enter" || event.key === " ") {
    const item = (event.target as HTMLElement).closest<HTMLElement>('[role="menuitem"]:not(:disabled):not([aria-disabled="true"])');
    if (!item) return;
    event.preventDefault();
    item.click();
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>(
    '[role="menuitem"]:not(:disabled):not([aria-disabled="true"])',
  )];
  if (!items.length) return;
  const index = items.indexOf(document.activeElement as HTMLElement);
  const next = event.key === "Home"
    ? 0
    : event.key === "End"
      ? items.length - 1
      : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
  event.preventDefault();
  items[next]?.focus();
}

export function moveItem<T>(items: readonly T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (index < 0 || target < 0 || target >= items.length) return [...items];
  const result = [...items];
  [result[index], result[target]] = [result[target], result[index]];
  return result;
}
