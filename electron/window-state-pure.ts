// Pure helpers behind window-state. Kept free of Electron imports so the
// validation, display-disconnect fallback, and load fallback can be tested
// directly. window-state.ts wires these into Electron's screen + BrowserWindow.

export interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  isFullScreen: boolean;
  isMaximized: boolean;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayLike {
  workArea: Rect;
}

export const DEFAULT_WINDOW_STATE: WindowState = {
  x: 0,
  y: 0,
  width: 1280,
  height: 800,
  isFullScreen: false,
  isMaximized: false,
};

/** Minimum visible overlap (px) needed to consider a window "on" a display.
 *  100x100 keeps a clearly-visible chunk on screen so the user can drag it. */
export const VISIBLE_OVERLAP_MIN = 100;

export function isWindowState(x: unknown): x is WindowState {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.x === "number" &&
    typeof r.y === "number" &&
    typeof r.width === "number" &&
    typeof r.height === "number" &&
    typeof r.isFullScreen === "boolean" &&
    typeof r.isMaximized === "boolean"
  );
}

/** True if `rect` overlaps any display's work area by at least
 *  VISIBLE_OVERLAP_MIN on both axes. Saved positions become invalid when the
 *  user disconnects the display they were on, so we fall back to defaults in
 *  that case rather than spawning a window off-screen. */
export function isVisibleOnAnyDisplay(
  rect: Rect,
  displays: readonly DisplayLike[],
): boolean {
  for (const display of displays) {
    const a = display.workArea;
    const ix = Math.max(rect.x, a.x);
    const iy = Math.max(rect.y, a.y);
    const ax = Math.min(rect.x + rect.width, a.x + a.width);
    const ay = Math.min(rect.y + rect.height, a.y + a.height);
    if (ax - ix >= VISIBLE_OVERLAP_MIN && ay - iy >= VISIBLE_OVERLAP_MIN) {
      return true;
    }
  }
  return false;
}

/** Decide what window state to use given a loaded JSON value and the
 *  currently-connected displays. Pure: no fs, no Electron. */
export function resolveLoadedWindowState(
  parsed: unknown,
  displays: readonly DisplayLike[],
): WindowState {
  if (!isWindowState(parsed)) return { ...DEFAULT_WINDOW_STATE };
  if (!isVisibleOnAnyDisplay(parsed, displays)) {
    // Saved on a now-disconnected monitor — start centered with the
    // remembered size.
    return {
      ...DEFAULT_WINDOW_STATE,
      width: parsed.width,
      height: parsed.height,
    };
  }
  return parsed;
}
