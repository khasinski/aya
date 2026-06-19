// Watches AYA_HOME for edits made to the user-editable config files
// (snippets/presets/themes, and project configs under projects/) from outside
// the app, and tells the renderer to reload that slice, so an edit made by
// hand while Aya is running isn't quietly overwritten by the next save the
// app makes.
//
// We watch folders rather than the files themselves: the rename done by an
// atomic write replaces the file, and a watch on the file itself would lose
// track of it. Folders are watched non-recursively (recursive watching isn't
// supported on Linux), which is why the projects/ subfolder carries its own
// watcher alongside the AYA_HOME one (#4).

import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { BrowserWindow } from "electron";
import { isEcho, recordWrite } from "./config-echo";
import {
  isProjectConfigFilename,
  sliceForFilename,
  WATCHED_CONFIG_FILES,
} from "./config-watcher-pure";
import { AYA_HOME, PROJECTS_DIR } from "./paths";
import type { ConfigSlice } from "./types";

// A single save can fire a burst of file events, wait a moment so it becomes one reload.
const WATCH_DEBOUNCE_MS = 200;
// fs.watch directory events are not equally reliable across macOS/libuv
// versions, especially in temp-like locations. Keep a scoped polling fallback
// so manual config edits still reload even if the native directory watcher is
// quiet.
const WATCH_POLL_MS = 500;

const MISSING = Symbol("missing");
type ObservedContent = string | typeof MISSING;

/** Start watching AYA_HOME (and AYA_HOME/projects) and send "config:changed"
 *  to the renderer when a file is edited from outside the app. Returns a
 *  function that stops the watchers and clears any pending timers. */
export function startConfigWatcher(win: BrowserWindow): () => void {
  // Keyed by debounce identity: the slice name for top-level files, the
  // individual filename for project configs (so edits to two different
  // projects don't swallow each other's reload).
  const timers = new Map<string, NodeJS.Timeout>();
  const watchers: FSWatcher[] = [];
  const observed = new Map<string, ObservedContent>();
  let pollTimer: NodeJS.Timeout | null = null;

  const send = (slice: ConfigSlice) => {
    if (!win.isDestroyed()) win.webContents.send("config:changed", { slice });
  };

  const emitIfExternal = async (
    slice: ConfigSlice,
    filePath: string,
    // Project configs treat a missing file as meaningful (an external delete
    // must reach the renderer so a closed project can drop off the list);
    // top-level slices keep the old "ignore, next save syncs" behavior.
    emitWhenMissing: boolean,
  ) => {
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch {
      if (emitWhenMissing) send(slice);
      return;
    }
    if (isEcho(filePath, content)) return;
    // Keep track what values the renderer was last given to distinguish in-app and manual edits.
    recordWrite(filePath, content);
    observed.set(filePath, content);
    send(slice);
  };

  const debounce = (key: string, run: () => void) => {
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        run();
      }, WATCH_DEBOUNCE_MS),
    );
  };

  const handleHome = (filename: string | null) => {
    if (!filename) return; // some platforms don't give a name; nothing to do
    const slice = sliceForFilename(filename);
    if (!slice) return; // a .tmp file, projects-state, or something we don't reload
    const filePath = path.join(AYA_HOME, filename);
    debounce(slice, () => void emitIfExternal(slice, filePath, false));
  };

  const handleProjects = (filename: string | null) => {
    if (!filename || !isProjectConfigFilename(filename)) return;
    const filePath = path.join(PROJECTS_DIR, filename);
    debounce(`projects:${filename}`, () =>
      void emitIfExternal("projects", filePath, true),
    );
  };

  const readObserved = async (filePath: string): Promise<ObservedContent> => {
    try {
      return await fs.readFile(filePath, "utf-8");
    } catch {
      return MISSING;
    }
  };

  const pollFile = async (
    slice: ConfigSlice,
    filePath: string,
    emitWhenMissing: boolean,
  ) => {
    const content = await readObserved(filePath);
    if (!observed.has(filePath)) {
      observed.set(filePath, content);
      return;
    }
    if (observed.get(filePath) === content) return;
    observed.set(filePath, content);
    if (content === MISSING) {
      if (emitWhenMissing) send(slice);
      return;
    }
    if (isEcho(filePath, content)) return;
    recordWrite(filePath, content);
    send(slice);
  };

  const pollOnce = async () => {
    await Promise.all(
      Object.entries(WATCHED_CONFIG_FILES).map(([filename, slice]) =>
        pollFile(slice, path.join(AYA_HOME, filename), false),
      ),
    );
    let projectFilenames: string[] = [];
    try {
      projectFilenames = (await fs.readdir(PROJECTS_DIR)).filter(
        isProjectConfigFilename,
      );
    } catch {
      // If the directory disappears, the next successful scan will rebuild
      // project observations. startConfigWatcher creates it up front.
    }
    const projectPaths = new Set(
      projectFilenames.map((filename) => path.join(PROJECTS_DIR, filename)),
    );
    await Promise.all(
      projectFilenames.map((filename) =>
        pollFile("projects", path.join(PROJECTS_DIR, filename), true),
      ),
    );
    for (const [filePath, value] of observed) {
      if (
        filePath.startsWith(`${PROJECTS_DIR}${path.sep}`) &&
        !projectPaths.has(filePath) &&
        value !== MISSING
      ) {
        observed.set(filePath, MISSING);
        send("projects");
      }
    }
  };

  const startPolling = () => {
    const tick = () => {
      pollTimer = setTimeout(tick, WATCH_POLL_MS);
      pollTimer.unref();
      void pollOnce();
    };
    void pollOnce();
    pollTimer = setTimeout(tick, WATCH_POLL_MS);
    pollTimer.unref();
  };

  try {
    mkdirSync(PROJECTS_DIR, { recursive: true });
    watchers.push(
      watch(AYA_HOME, { persistent: false }, (_event, filename) =>
        handleHome(typeof filename === "string" ? filename : null),
      ),
      watch(PROJECTS_DIR, { persistent: false }, (_event, filename) =>
        handleProjects(typeof filename === "string" ? filename : null),
      ),
    );
    startPolling();
  } catch {
    // Ignore outside edits causing exceptions.
  }

  return () => {
    for (const w of watchers) w.close();
    for (const timer of timers.values()) clearTimeout(timer);
    if (pollTimer) clearTimeout(pollTimer);
    timers.clear();
  };
}
