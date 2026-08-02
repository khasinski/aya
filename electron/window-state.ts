// Persists BrowserWindow position/size + fullscreen flag across launches.
//
// Hand-rolled instead of pulling in electron-window-state for a single
// feature. State lives at ~/.aya/window-state.json (or ~/.aya-dev/... in
// dev) so dev and prod don't interfere.
//
// Saves are debounced — `resize` and `move` fire on every pixel of drag —
// so we don't hammer the disk. The atomic write helper guards against
// truncation if the app crashes mid-save.
//
// Pure helpers (validation, display-disconnect fallback) live in
// window-state-pure.ts so they can be unit-tested without Electron.

import { promises as fs } from "node:fs";
import type { BrowserWindow } from "electron";
import { screen } from "electron";
import { writeFileAtomic } from "./atomic-write";
import { WINDOW_STATE_FILE } from "./paths";
import {
  DEFAULT_WINDOW_STATE,
  resolveLoadedWindowState,
  type WindowState,
} from "./window-state-pure";

export type { WindowState } from "./window-state-pure";

const SAVE_DEBOUNCE_MS = 400;

export async function loadWindowState(): Promise<WindowState> {
  try {
    const raw = await fs.readFile(WINDOW_STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return resolveLoadedWindowState(parsed, screen.getAllDisplays());
  } catch {
    return { ...DEFAULT_WINDOW_STATE };
  }
}

/** Attach listeners that save the window's geometry on close + when it
 *  changes. The returned function detaches everything (useful in tests). */
export function trackWindowState(win: BrowserWindow): () => void {
  let timer: NodeJS.Timeout | null = null;

  const snapshot = (): WindowState => {
    // bounds is the windowed rect; if we ask while maximized we lose the
    // restore size. `getNormalBounds()` returns the unmaximized geometry.
    const bounds = win.isNormal()
      ? win.getBounds()
      : (win.getNormalBounds() ?? win.getBounds());
    return {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isFullScreen:
        win.isFullScreen() ||
        (process.platform === "darwin" && win.isSimpleFullScreen()),
      isMaximized: win.isMaximized(),
    };
  };

  const scheduleSave = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const state = snapshot();
      void writeFileAtomic(
        WINDOW_STATE_FILE,
        JSON.stringify(state, null, 2) + "\n",
      ).catch(() => {
        // Non-fatal — config dir might be read-only or full.
      });
    }, SAVE_DEBOUNCE_MS);
  };

  // TypeScript's strict overloads on BrowserWindow.on() resist generic
  // iteration over event names, so register each one explicitly.
  win.on("resize", scheduleSave);
  win.on("move", scheduleSave);
  win.on("maximize", scheduleSave);
  win.on("unmaximize", scheduleSave);
  win.on("enter-full-screen", scheduleSave);
  win.on("leave-full-screen", scheduleSave);

  // Final flush — synchronous-ish, write whatever the last snapshot is.
  const flush = () => {
    if (timer) clearTimeout(timer);
    const state = snapshot();
    void writeFileAtomic(
      WINDOW_STATE_FILE,
      JSON.stringify(state, null, 2) + "\n",
    ).catch(() => {});
  };
  win.on("close", flush);

  return () => {
    win.removeListener("resize", scheduleSave);
    win.removeListener("move", scheduleSave);
    win.removeListener("maximize", scheduleSave);
    win.removeListener("unmaximize", scheduleSave);
    win.removeListener("enter-full-screen", scheduleSave);
    win.removeListener("leave-full-screen", scheduleSave);
    win.removeListener("close", flush);
    if (timer) clearTimeout(timer);
  };
}
