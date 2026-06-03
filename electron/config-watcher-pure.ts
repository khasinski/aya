// Maps a changed filename to the config "slice" the renderer should reload.
// Kept separate from config-watcher so it can be unit-tested on its own,
// without fs.watch or Electron (same idea as window-state-pure.ts).
//
// For now only the files the user is meant to edit by hand live here:
// snippets, presets and themes. projects/*.json and projects-state.json are
// left out on purpose: they hold live terminal state and the app rewrites them
// all the time, so reloading those safely would need more care.

import type { ConfigSlice } from "./types";

/** Filename to slice, for the files we watch and reload. The keys are exact
 *  filenames, so the temporary `<file>.<pid>.<rand>.tmp` files that atomic
 *  writes create never match and are skipped automatically. */
export const WATCHED_CONFIG_FILES: Readonly<Record<string, ConfigSlice>> = {
  "snippets.json": "snippets",
  "presets.json": "presets",
  "themes.json": "themes",
};

/** The slice to reload for a changed filename, or null if it's not a file we
 *  reload (a .tmp file, projects-state, window-state, anything unrelated). */
export function sliceForFilename(filename: string): ConfigSlice | null {
  // Use hasOwn instead of a plain lookup: a plain lookup would also find
  // built-in keys like "constructor" or "toString" and return a function.
  return Object.hasOwn(WATCHED_CONFIG_FILES, filename)
    ? WATCHED_CONFIG_FILES[filename]
    : null;
}
