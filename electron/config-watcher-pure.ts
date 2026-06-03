// Pure mapping from a changed filename to the config "slice" the renderer
// should reload — extracted from config-watcher so it can be unit-tested
// without fs.watch or Electron (mirrors window-state-pure.ts).
//
// Minimal scope (first cut): only the user-editable, safely
// hot-reloadable files live here — snippets, presets, themes. projects/*.json
// and projects-state.json are deliberately excluded: they back live terminals
// and are rewritten by the app constantly, so hot-reloading them needs a
// separate, more careful policy.

import type { ConfigSlice } from "./types";

/** Basename → slice for the files we watch and hot-reload. The keys are exact
 *  basenames, so the `<file>.<pid>.<rand>.tmp` scratch files written by
 *  writeFileAtomic never match and are ignored for free. */
export const WATCHED_CONFIG_FILES: Readonly<Record<string, ConfigSlice>> = {
  "snippets.json": "snippets",
  "presets.json": "presets",
  "themes.json": "themes",
};

/** The slice to reload for a changed filename, or null if the file isn't one we
 *  hot-reload (a .tmp scratch file, projects-state, window-state, an unrelated
 *  name, etc.). */
export function sliceForFilename(filename: string): ConfigSlice | null {
  // Own-property check: a bare lookup would resolve inherited Object.prototype
  // keys ("constructor", "hasOwnProperty", "toString"), returning a truthy
  // function that `?? null` and the caller's `if (!slice)` both wave through —
  // and a function can't cross IPC (DataCloneError).
  return Object.hasOwn(WATCHED_CONFIG_FILES, filename)
    ? WATCHED_CONFIG_FILES[filename]
    : null;
}
