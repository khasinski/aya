// Aya Web (experimental) — keyboard shortcuts in the browser.
//
// The desktop app dispatches shortcuts from the main process
// (before-input-event in electron/main.ts) so they fire even while xterm has
// focus. A browser has no such hook, so the web client maps keydown events
// with this mirror of that table. Browser-reserved combos (Cmd/Ctrl+T, +W)
// are still mapped — preventDefault wins in some browsers/modes and the
// worst case is the browser action running instead.
//
// Pure and DOM-free so tests can drive it directly.

/** Maximum number of keyboard-navigable projects (Cmd/Ctrl+1..9) — mirrors
 *  MAX_KEYBOARD_PROJECTS in electron/main.ts. */
export const WEB_MAX_KEYBOARD_PROJECTS = 9;

export interface ShortcutKeyEvent {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Map a keydown to an Aya shortcut action, or null when the browser should
 *  keep the key. Mirrors electron/main.ts before-input-event. */
export function shortcutForKey(
  e: ShortcutKeyEvent,
  isMacClient: boolean,
): string | null {
  const mod = isMacClient ? e.metaKey : e.ctrlKey;
  if (!mod) return null;
  if (e.altKey && !e.shiftKey) {
    if (e.key === "ArrowLeft") return "focus-pane-left";
    if (e.key === "ArrowRight") return "focus-pane-right";
    if (e.key === "ArrowUp") return "focus-pane-up";
    if (e.key === "ArrowDown") return "focus-pane-down";
    if (e.key === "\\" || e.code === "Backslash") return "split-pane-right";
    if (e.key === "-") return "split-pane-below";
    return null;
  }
  // Extra modifiers we don't bind must not trigger our actions (e.g.
  // Cmd+Shift+T is the browser's reopen-tab, not our new-shell).
  if (e.shiftKey || e.altKey) return null;
  const key = e.key.toLowerCase();
  if (key === "t") return "new-shell";
  if (key === "w") return "close-tab";
  if (key === ",") return "open-settings";
  if (key === "[") return "prev-tab";
  if (key === "]") return "next-tab";
  if (key === "f") return "find-in-pane";
  if (key === "k") return "search";
  if (
    key.length === 1 &&
    key >= "1" &&
    key <= String(WEB_MAX_KEYBOARD_PROJECTS)
  ) {
    return `project-${key}`;
  }
  // NOTE: no "r" mapping — in the browser Cmd/Ctrl+R just reloads the page,
  // which reconnects the web client (a reasonable recovery gesture).
  return null;
}
