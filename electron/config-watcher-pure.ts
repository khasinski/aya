// Maps a changed filename to the config "slice" the renderer should reload.
// Kept separate from config-watcher so it can be unit-tested on its own,
// without fs.watch or Electron (same idea as window-state-pure.ts).
//
// Top-level files (snippets, presets, themes) map by exact filename below.
// projects/*.json live in their own subfolder and get their own predicate
// (isProjectConfigFilename) because fs.watch is non-recursive on Linux, so the
// projects dir carries its own watcher. projects-state.json stays out on
// purpose: it is app-owned live state and needs separate conflict semantics
// (see #4).

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

/** True for a project config inside AYA_HOME/projects: `<slug>.json`. The
 *  `.tmp` files atomic writes create end in `.tmp`, so the suffix check
 *  excludes them already; dotfiles are skipped for editor swap files. */
export function isProjectConfigFilename(filename: string): boolean {
  return filename.endsWith(".json") && !filename.startsWith(".");
}
