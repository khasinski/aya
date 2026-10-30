// "debug on": every decision a team's runner makes, one JSON line each in the team's debug.jsonl, for
// `aya team debug <team>`. Off (the default) nothing is formatted or written.
// A leaf: the team store, files and runner import it, so it imports none of them. Finding the team a pane
// or a socket answer belongs to is in team-debug-route.ts.

import * as fs from "node:fs";
import * as path from "node:path";
import { OWNER_ONLY_FILE_MODE } from "./paths";
import { DEBUG_LOG_FILE, DEBUG_LOG_OLD_FILE } from "./team-records";

export const DEBUG_SWITCH_FILE = "debug.json";
export { DEBUG_LOG_FILE, DEBUG_LOG_OLD_FILE };
export const DEBUG_LOG_MAX_BYTES = 5 * 1024 * 1024;
const DEBUG_SWITCH_MAX_BYTES = 4 * 1024;
// What agents or the user wrote is kept to its start; other strings (hold reasons) are Aya's own and kept longer.
export const MESSAGE_CHARS = 80;
export const OTHER_CHARS = 300;
const MESSAGE_FIELDS = new Set(["text", "output", "question"]);
// Events that report a state: written when it changes, not at every look.
const STATE_EVENTS = new Set(["liveness", "launch"]);

const fromEnv = process.env.AYA_DEBUG === "1";
let fromFile = false;
let debugSwitchPath: string | null = null;
let debugSwitchStat: { mtimeMs: number; ino: number; size: number } | null = null;
type DebugSwitchWatcher = { path: string; read: () => void; watcher: fs.FSWatcher | null };
const debugSwitchWatchers: DebugSwitchWatcher[] = [];
let activeDebugSwitchWatcher: DebugSwitchWatcher | null = null;
const sizes = new Map<string, number>();
const states = new Map<string, string>();

export const debugOn = (): boolean => {
  if (fromEnv) return true;
  // The watcher is asynchronous. While enabled, stat the switch so a log call
  // after `aya debug off` can notice its atomic replacement without reparsing it
  // on every decision.
  if (fromFile && debugSwitchPath) refreshDebugSwitch();
  return fromFile;
};

/** The switch as $AYA_HOME/debug.json has it ({"on": true}); off when absent or unreadable. */
export function readDebugSwitch(ayaHome: string): boolean {
  const file = path.join(ayaHome, DEBUG_SWITCH_FILE);
  let fd: number | null = null;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > DEBUG_SWITCH_MAX_BYTES) return false;
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
    fd = fs.openSync(file, flags);
    const after = fs.fstatSync(fd);
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size > DEBUG_SWITCH_MAX_BYTES) return false;
    const bytes = Buffer.allocUnsafe(DEBUG_SWITCH_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = fs.readSync(fd, bytes, length, bytes.length - length, length);
      if (read === 0) break;
      length += read;
    }
    if (length > DEBUG_SWITCH_MAX_BYTES) return false;
    return (JSON.parse(bytes.subarray(0, length).toString("utf8")) as { on?: unknown })?.on === true;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // A switch read is best-effort; a close failure still means debug is off.
      }
    }
  }
}

function refreshDebugSwitch(forceRead = false): void {
  if (!debugSwitchPath) return;
  let current: { mtimeMs: number; ino: number; size: number } | null = null;
  try {
    const stat = fs.statSync(debugSwitchPath);
    current = { mtimeMs: stat.mtimeMs, ino: stat.ino, size: stat.size };
  } catch {
    // A missing switch is off. Other stat failures are also fail-closed.
  }
  if (!current) {
    debugSwitchStat = null;
    fromFile = false;
    return;
  }
  if (forceRead || !debugSwitchStat || current.mtimeMs !== debugSwitchStat.mtimeMs || current.ino !== debugSwitchStat.ino || current.size !== debugSwitchStat.size) {
    debugSwitchStat = current;
    fromFile = readDebugSwitch(path.dirname(debugSwitchPath));
  }
}

/** Reads the switch now and again whenever debug.json changes (aya debug on|off), with no restart; returns a stop. */
export function watchDebugSwitch(ayaHome: string, onRead?: (enabled: boolean) => void): () => void {
  const entry: DebugSwitchWatcher = { path: path.join(ayaHome, DEBUG_SWITCH_FILE), read: () => {}, watcher: null };
  entry.read = () => {
    if (activeDebugSwitchWatcher !== entry) return;
    refreshDebugSwitch(true);
    onRead?.(fromFile);
  };
  debugSwitchWatchers.push(entry);
  activeDebugSwitchWatcher = entry;
  debugSwitchPath = entry.path;
  debugSwitchStat = null;
  try {
    entry.watcher = fs.watch(ayaHome, (_event, name) => (!name || String(name) === DEBUG_SWITCH_FILE ? entry.read() : undefined));
    entry.watcher.unref();
  } catch {
    entry.watcher = null;
  }
  entry.read();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    entry.watcher?.close();
    const index = debugSwitchWatchers.indexOf(entry);
    if (index >= 0) debugSwitchWatchers.splice(index, 1);
    if (activeDebugSwitchWatcher !== entry) return;
    const previous = debugSwitchWatchers.at(-1) ?? null;
    activeDebugSwitchWatcher = previous;
    debugSwitchPath = previous?.path ?? null;
    debugSwitchStat = null;
    if (previous) previous.read();
    else fromFile = false;
  };
}

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}...` : text);
const trimmed = (key: string, value: unknown): unknown => (typeof value === "string" ? cut(value, MESSAGE_FIELDS.has(key) ? MESSAGE_CHARS : OTHER_CHARS) : value);

/** One decision of the team whose directory is `team.dir`. A removed team's directory is not made again. */
export function debugLog(team: { dir: string }, event: string, fields: Record<string, unknown> = {}): void {
  if (!debugOn()) return;
  if (STATE_EVENTS.has(event)) {
    const key = `${team.dir}\0${event}\0${String(fields.pane ?? "")}`;
    const state = JSON.stringify(fields, trimmed);
    if (states.get(key) === state) return;
    states.set(key, state);
  }
  const line = `${JSON.stringify({ time: new Date().toISOString(), event, ...fields }, trimmed)}\n`;
  const file = path.join(team.dir, DEBUG_LOG_FILE);
  try {
    let size = sizes.get(file) ?? fileSize(file);
    if (size > 0 && size + Buffer.byteLength(line) > DEBUG_LOG_MAX_BYTES) {
      fs.renameSync(file, path.join(team.dir, DEBUG_LOG_OLD_FILE));
      size = 0;
    }
    fs.appendFileSync(file, line, { mode: OWNER_ONLY_FILE_MODE });
    sizes.set(file, size + Buffer.byteLength(line));
  } catch {
    // A removed team or a full disk: debugging must never stop the team.
  }
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}
