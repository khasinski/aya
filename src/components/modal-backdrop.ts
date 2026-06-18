import type React from "react";

const BACKDROP_MOUSE_DOWN = "ayaBackdropMouseDown";

function hasTextSelection(): boolean {
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && selection.toString()) return true;

  const active = document.activeElement;
  if (
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement
  ) {
    return active.selectionStart !== active.selectionEnd;
  }
  return false;
}

export function markBackdropMouseDown(
  event: React.MouseEvent<HTMLElement>,
): void {
  event.currentTarget.dataset[BACKDROP_MOUSE_DOWN] =
    event.target === event.currentTarget ? "true" : "false";
}

export function closeFromBackdropClick(
  event: React.MouseEvent<HTMLElement>,
  onClose: () => void,
): void {
  const startedOnBackdrop =
    event.currentTarget.dataset[BACKDROP_MOUSE_DOWN] === "true";
  delete event.currentTarget.dataset[BACKDROP_MOUSE_DOWN];

  if (
    startedOnBackdrop &&
    event.target === event.currentTarget &&
    !hasTextSelection()
  ) {
    onClose();
  }
}
