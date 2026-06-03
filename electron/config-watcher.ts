// Watches AYA_HOME for edits made to the user-editable config files
// (snippets/presets/themes) from outside the app, and tells the renderer to
// reload that slice, so an edit made by hand while Aya is running isn't
// quietly overwritten by the next save the app makes.
//
// We watch the AYA_HOME folder rather than the files themselves: the rename
// done by an atomic write replaces the file, and a watch on the file itself
// would lose track of it. The folder is watched non-recursively (recursive
// watching isn't supported on Linux), which is fine since all three files sit
// directly in AYA_HOME.

import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { BrowserWindow } from "electron";
import { isEcho, recordWrite } from "./config-echo";
import { sliceForFilename } from "./config-watcher-pure";
import { AYA_HOME } from "./paths";
import type { ConfigSlice } from "./types";

// A single save can fire a burst of file events, wait a moment so it becomes one reload.
const WATCH_DEBOUNCE_MS = 200;

/** Start watching AYA_HOME and send "config:changed" to the renderer when a
 *  file is edited from outside the app. Returns a function that stops the
 *  watcher and clears any pending timers. */
export function startConfigWatcher(win: BrowserWindow): () => void {
  const timers = new Map<ConfigSlice, NodeJS.Timeout>();
  let watcher: FSWatcher | null = null;

  const emitIfExternal = async (slice: ConfigSlice, filePath: string) => {
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch {
      // If we can't read the file right now, ignore it; the next save will sync it.
      return;
    }
    if (isEcho(filePath, content)) return;
    // Keep track what values the renderer was last given to distinguish in-app and manual edits.
    recordWrite(filePath, content);
    if (!win.isDestroyed()) win.webContents.send("config:changed", { slice });
  };

  const handle = (filename: string | null) => {
    if (!filename) return; // some platforms don't give a name; nothing to do
    const slice = sliceForFilename(filename);
    if (!slice) return; // a .tmp file, projects-state, or something we don't reload
    const filePath = path.join(AYA_HOME, filename);
    const existing = timers.get(slice);
    if (existing) clearTimeout(existing);
    timers.set(
      slice,
      setTimeout(() => {
        timers.delete(slice);
        void emitIfExternal(slice, filePath);
      }, WATCH_DEBOUNCE_MS),
    );
  };

  try {
    mkdirSync(AYA_HOME, { recursive: true });
    watcher = watch(AYA_HOME, { persistent: false }, (_event, filename) =>
      handle(typeof filename === "string" ? filename : null),
    );
  } catch {
    // Ignore outside edits causing exceptions.
  }

  return () => {
    if (watcher) watcher.close();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };
}
