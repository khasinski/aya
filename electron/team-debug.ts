// "debug on": every decision a team's runner makes, one JSON line each in the team's debug.jsonl, for
// `aya team debug <team>`. Off (the default) a call costs one boolean read: nothing is formatted or written.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ControlCaller, ControlRequest } from "./control-protocol";
import { OWNER_ONLY_FILE_MODE } from "./paths";
import { callerProject } from "./team-author";
import { paneTeamRole } from "./team-files";
import { openTeamStore } from "./team-store";
import type { ProjectConfig } from "./types";

export const DEBUG_SWITCH_FILE = "debug.json";
export const DEBUG_LOG_FILE = "debug.jsonl";
export const DEBUG_LOG_OLD_FILE = "debug.1.jsonl";
export const DEBUG_LOG_MAX_BYTES = 5 * 1024 * 1024;
// What agents or the user wrote is kept to its start; other strings (hold reasons) are Aya's own and kept longer.
export const MESSAGE_CHARS = 80;
export const OTHER_CHARS = 300;
const MESSAGE_FIELDS = new Set(["text", "output", "question"]);
// Events that report a state: written when it changes, not at every look.
const STATE_EVENTS = new Set(["liveness", "launch"]);

const fromEnv = process.env.AYA_DEBUG === "1";
let fromFile = false;
const sizes = new Map<string, number>();
const states = new Map<string, string>();

export const debugOn = (): boolean => fromEnv || fromFile;

/** The switch as $AYA_HOME/debug.json has it ({"on": true}); off when absent or unreadable. */
export function readDebugSwitch(ayaHome: string): boolean {
  try {
    return (JSON.parse(fs.readFileSync(path.join(ayaHome, DEBUG_SWITCH_FILE), "utf8")) as { on?: unknown })?.on === true;
  } catch {
    return false;
  }
}

/** Reads the switch now and again whenever debug.json changes (aya debug on|off), with no restart; returns a stop. */
export function watchDebugSwitch(ayaHome: string): () => void {
  const read = () => void (fromFile = readDebugSwitch(ayaHome));
  read();
  try {
    const watcher = fs.watch(ayaHome, (_event, name) => (!name || String(name) === DEBUG_SWITCH_FILE ? read() : undefined));
    watcher.unref();
    return () => watcher.close();
  } catch {
    return () => {};
  }
}

type DebugDeps = { teamHome: string; listProjects: () => Promise<ProjectConfig[]> };

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

/** A decision about a pane, in the debug log of the team it plays a role in, if any. */
export async function debugPane(deps: DebugDeps, paneId: string, event: string, fields: Record<string, unknown>): Promise<void> {
  if (!debugOn()) return;
  try {
    const project = (await deps.listProjects()).find((p) => p.tabs.some((t) => t.id === paneId));
    const plays = project ? await paneTeamRole(deps.teamHome, project, paneId) : null;
    if (plays) debugLog(plays.store, event, { pane: paneId, role: plays.role, ...fields });
  } catch {
    // as above
  }
}

/** The socket's answer to an aya team command, in a team's debug log (the team it names, else its pane's team). */
export async function debugAnswer<T>(
  deps: DebugDeps | undefined,
  request: ControlRequest,
  caller: ControlCaller,
  answer: Promise<T>,
): Promise<T> {
  if (!debugOn() || !deps || !request.type.startsWith("team-")) return answer;
  const fields = { command: request.type, caller: caller.terminalId ?? null, ...(request.type === "team-send" ? { to: request.role, text: request.text } : {}) };
  const log = async (outcome: Record<string, unknown>) => {
    try {
      const named = "team" in request ? request.team : undefined;
      const project = "cwd" in request ? await callerProject(await deps.listProjects(), caller.terminalId, request) : null;
      if (named && project) return debugLog(openTeamStore(deps.teamHome, project.slug, named), "socket", { ...fields, ...outcome });
      if (caller.terminalId) await debugPane(deps, caller.terminalId, "socket", { ...fields, ...outcome });
    } catch {
      // as above
    }
  };
  try {
    const value = await answer;
    const output = (value as { output?: unknown } | undefined)?.output;
    await log({ ok: true, ...(typeof output === "string" ? { output } : {}) });
    return value;
  } catch (err) {
    await log({ ok: false, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
