// Watches AYA_HOME for EXTERNAL edits to the user-editable config files
// (snippets/presets/themes) and tells the renderer to reload that slice — so a
// hand-edit made while Aya is running isn't silently clobbered by the next
// in-app save.
//
// Two things make this non-trivial and are handled here:
//   1. Aya writes these files itself (writeFileAtomic), so a naive watcher
//      would fire on our own saves and reload-storm. The config-echo registry
//      records a hash of what we wrote; an event whose on-disk content matches
//      the last write we made is an echo and is ignored.
//   2. writeFileAtomic does tmp-file + rename, so one save fires several raw
//      events (the .tmp create, the rename). We debounce per slice and skip
//      anything that isn't an exact watched basename, then read once + compare.
//
// We watch the AYA_HOME directory, not the individual files: the atomic rename
// swaps the file's inode, which a file-level watch would lose track of. The dir
// is watched non-recursively (recursive watch isn't supported on Linux), which
// is fine — snippets/presets/themes.json all live directly in AYA_HOME.

import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { BrowserWindow } from "electron";
import { isEcho, recordWrite } from "./config-echo";
import { sliceForFilename } from "./config-watcher-pure";
import { AYA_HOME } from "./paths";
import type { ConfigSlice } from "./types";

// Coalesce the burst of raw fs events from one save (tmp create + rename, plus
// any editor double-writes) into a single reload per slice.
const WATCH_DEBOUNCE_MS = 200;

/** Start watching AYA_HOME and push "config:changed" to the renderer on an
 *  external edit. Returns a stop function which closes the watcher and clears timers. */
export function startConfigWatcher(win: BrowserWindow): () => void {
  const timers = new Map<ConfigSlice, NodeJS.Timeout>();
  let watcher: FSWatcher | null = null;

  const emitIfExternal = async (slice: ConfigSlice, filePath: string) => {
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch {
      // Ignore errors reading the file, the next save will re-sync it.
      return;
    }
    if (isEcho(filePath, content)) return;
    // Re-baseline to the bytes we're about to hand the renderer, so the echo
    // registry tracks "what the renderer was last told to load" — not only what
    // Aya itself wrote. Without this, reverting the file back to Aya's previous
    // bytes (editor undo, git checkout) would still match the stale baseline,
    // be mis-read as an echo, suppressed, and clobbered by the next save.
    recordWrite(filePath, content);
    if (!win.isDestroyed()) win.webContents.send("config:changed", { slice });
  };

  const handle = (filename: string | null) => {
    if (!filename) return; // some platforms omit the name; nothing actionable
    const slice = sliceForFilename(filename);
    if (!slice) return; // .tmp scratch file, projects-state, or out of scope
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
    // The dir is created on first write anyway; ensure it exists so the watcher
    // always attaches (avoids an ENOENT on a brand-new install before boot
    // seeds the config files).
    mkdirSync(AYA_HOME, { recursive: true });
    watcher = watch(AYA_HOME, { persistent: false }, (_event, filename) =>
      handle(typeof filename === "string" ? filename : null),
    );
  } catch {
    // Non-fatal: external-edit watching just won't be active this session.
  }

  return () => {
    if (watcher) watcher.close();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };
}
