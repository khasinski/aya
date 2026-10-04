// Which conversation a codex or grok pane is in, read from the CLI's own store: neither reports it
// over OSC 9001, and `resume --last` would give every pane of a folder the newest conversation.

import { execFile } from "node:child_process";
import { promises as fs, realpath } from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { isSafeSessionId } from "./osc-extractor";
import { pathExists } from "./path-exists";
import { collectDescendants } from "./pty-host-registry";
import { simpleShellWords, type ShellWord } from "./shell-words";
import type { SpawnRequest } from "./types";

const execFileAsync = promisify(execFile);
// The native realpath also settles letter case on a case-insensitive disk.
const nativeRealpath = promisify(realpath.native);

export const AGENT_SESSION_POLL_MS = 5_000;

export const asError = (err: unknown) => (err instanceof Error ? err : new Error(String(err)));

/** Reports every read, not only changes (an event sent with no window connected is lost); a read in flight at a
 *  pane restart is dropped so it cannot overwrite the new process; a throw reaches `onError` once per message. */
export function pollSession(
  read: () => Promise<string | null>,
  report: (sessionId: string) => void,
  intervalMs: number = AGENT_SESSION_POLL_MS,
  onError: (err: Error) => void = () => {},
): () => void {
  let stopped = false;
  let lastError = "";
  const timer = setInterval(async () => {
    let sessionId: string | null = null;
    try {
      sessionId = await read();
    } catch (err) {
      const error = asError(err);
      if (!stopped && error.message !== lastError) onError(error);
      lastError = error.message;
    }
    if (!stopped && sessionId) report(sessionId);
  }, intervalMs);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** `pid` and its descendants: codex runs as a native child of its node launcher. */
export async function processFamily(pid: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,ppid="], { windowsHide: true });
    const procs = stdout.split("\n").map((line) => line.trim().split(/\s+/).map(Number));
    return [pid, ...collectDescendants(pid, procs.filter((p) => p.length === 2 && p.every(Number.isInteger)).map(([child, ppid]) => ({ pid: child, ppid })))];
  } catch {
    return [pid];
  }
}

async function newestDb(dir: string, prefix: string): Promise<string | null> {
  const version = (name: string) => Number(name.slice(prefix.length + 1, -".sqlite".length));
  const names = (await fs.readdir(dir).catch(() => [] as string[]))
    .filter((name) => new RegExp(`^${prefix}_\\d+\\.sqlite$`).test(name))
    .sort((a, b) => version(b) - version(a));
  return names[0] ? path.join(dir, names[0]) : null;
}

// A log row may predate the spawn by the clock's second-resolution rounding.
export const LOG_CLOCK_SLACK_S = 1;
export const LOG_CLOCK_SLACK_MS = LOG_CLOCK_SLACK_S * 1000;

/** The thread of `cwd` one of `pids` logged to since `sinceMs` (state_N.sqlite cwd + logs_N.sqlite pid, codex-cli
 *  0.158.0); the time bound keeps a dead process's reused pid out. Null until a first message creates the thread. */
export async function readCodexSessionId(
  home: string,
  cwd: string,
  pids: number[],
  sinceMs: number,
): Promise<string | null> {
  if (pids.length === 0) return null;
  const [statePath, logsPath] = await Promise.all([newestDb(home, "state"), newestDb(home, "logs")]);
  if (!statePath || !logsPath) return null;
  const { DatabaseSync } = await import("node:sqlite");
  const dbs: Array<InstanceType<typeof DatabaseSync>> = [];
  try {
    const state = new DatabaseSync(statePath, { readOnly: true });
    dbs.push(state);
    const logs = new DatabaseSync(logsPath, { readOnly: true });
    dbs.push(logs);
    const real = await fs.realpath(cwd).catch(() => cwd);
    const dirs = [...new Set([cwd, real])];
    const ours = pids.map(() => "process_uuid LIKE ?").join(" OR ");
    const since = Math.floor(sinceMs / 1000) - LOG_CLOCK_SLACK_S;
    // The pids first: other threads of the cwd, however many, must not hide ours.
    const logged = logs
      .prepare(`SELECT DISTINCT thread_id AS id FROM logs WHERE thread_id IS NOT NULL AND ts >= ? AND (${ours})`)
      .all(since, ...pids.map((pid) => `pid:${pid}:%`)) as Array<{ id: string }>;
    const threads = state
      .prepare(
        `SELECT id FROM threads WHERE cwd IN (${dirs.map(() => "?").join(",")}) AND id IN (SELECT value FROM json_each(?)) ORDER BY updated_at_ms DESC`,
      )
      .all(...dirs, JSON.stringify(logged.map((row) => row.id))) as Array<{ id: string }>;
    return threads.find(({ id }) => isSafeSessionId(id))?.id ?? null;
  } finally {
    for (const db of dbs) db.close();
  }
}

const grokSessionDir = (home: string, cwd: string, id: string) =>
  path.join(home, "sessions", encodeURIComponent(cwd), id);

/** The newest grok row for one of `pids` since `sinceMs` (a reused pid's dead row is older), once its folder exists:
 *  grok saves it with the first message, and `--resume` of an unsaved one would leave the pane dead. */
export async function readGrokSessionId(
  home: string,
  pids: number[],
  sinceMs = 0,
): Promise<string | null> {
  const text = await fs.readFile(path.join(home, "active_sessions.json"), "utf8").catch((err) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  const rows = text === null ? null : (JSON.parse(text) as unknown);
  if (!Array.isArray(rows)) return null;
  const openedAt = (row: { opened_at?: unknown }) => Date.parse(String(row.opened_at));
  const mine = rows
    .filter((r) => pids.includes(r?.pid) && (sinceMs === 0 || openedAt(r) >= sinceMs - LOG_CLOCK_SLACK_MS))
    .sort((a, b) => (openedAt(b) || 0) - (openedAt(a) || 0));
  const row = mine[0];
  if (typeof row?.session_id !== "string" || typeof row.cwd !== "string") return null;
  if (!isSafeSessionId(row.session_id)) return null;
  return (await pathExists(grokSessionDir(home, row.cwd, row.session_id))) ? row.session_id : null;
}

/** One key per folder however it is spelled (symlink, trailing slash, dot
 *  segments, letter case on a case-insensitive disk); a `host:dir` key is kept. */
export function canonicalDirs(dirs: string[]): Promise<string[]> {
  return Promise.all(dirs.map((dir) => (path.isAbsolute(dir) ? nativeRealpath(dir).catch(() => path.resolve(dir)) : dir)));
}

export async function sharesFolder(cwd: string, peers: string[]): Promise<boolean> {
  const [own, ...others] = await canonicalDirs([cwd, ...peers]);
  return others.includes(own);
}

/** The spawn request with one `command`: the shared-folder one when a peer pane is in this folder, so every later
 *  rewrite (the brief, the codex flags) applies to the command that runs. */
export async function withSharedDirCommand(req: SpawnRequest): Promise<SpawnRequest> {
  const { sharedDirCommand, peerCwds, ...rest } = req;
  if (!sharedDirCommand || !peerCwds || !(await sharesFolder(req.cwd, peerCwds))) return rest;
  return { ...rest, command: sharedDirCommand };
}

const LAUNCHES_AGENT =
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"(?:[^"\\]|\\.)*"|\\.|[^\s'"\\])*\s+)*(?:exec\s+)?(?:\S*\/)?(claude|grok|codex|opencode)(?:\s|$)/;

export const agentProgram = (command: string) => LAUNCHES_AGENT.exec(command)?.[1] ?? null;

/** The program, after `NAME=value` assignments and a plain `exec`, is the agent's own binary: behind a wrapper a flag
 *  lands on the wrapper and the transcripts may be out of sight, so no id or rewrite is safe. Mirrored in src/agentPreset.ts. */
export const launchesAgentDirectly = (command: string) => agentProgram(command) !== null;

const CONTINUE_FLAGS = ["-c", "--continue"];
const RESUMING_FLAGS = [...CONTINUE_FLAGS, "-r", "--resume", "--session-id", "--fork-session"];
// The pane's agent kind can disagree with the binary (an explicit preset field, CLAUDE_CONFIG_DIR inference).
const TAKES_SESSION_ID = new Set(["claude", "grok"]);

/** A fresh claude or grok launch gets a session id of its own at the end, so the pane never depends on the CLI's
 *  "latest"; a command that already resumes, names a session or chains commands is left alone. */
export function withOwnSessionId(command: string): { command: string; sessionId: string | null } {
  const trimmed = command.trim();
  const words = simpleShellWords(trimmed);
  const resuming = words?.some((w) => RESUMING_FLAGS.some((f) => w.text === f || w.text.startsWith(`${f}=`)));
  const program = agentProgram(trimmed);
  if (!words?.length || resuming || !program || !TAKES_SESSION_ID.has(program)) return { command, sessionId: null };
  const sessionId = randomUUID();
  return { command: `${trimmed} --session-id ${sessionId}`, sessionId };
}

const RESUME_INLINE = "--resume=";
// What claude and grok accept after --session-id; any other --resume value is a title.
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `--resume <uuid>` anywhere becomes `--session-id <uuid>` when `alive` says the session is gone; only unquoted
 *  words are options, and a continue flag anywhere rules the rewrite out. */
export async function restartGoneResume(command: string, alive: (id: string) => Promise<boolean>): Promise<string> {
  if (!launchesAgentDirectly(command)) return command;
  const words = simpleShellWords(command) ?? [];
  if (words.some((w) => CONTINUE_FLAGS.includes(w.text))) return command;
  const plain = (w: ShellWord | undefined) => w !== undefined && command.slice(w.start, w.end) === w.text;
  for (const [i, word] of words.entries()) {
    if (!plain(word)) continue;
    const inline = word.text.startsWith(RESUME_INLINE);
    const idWord = inline ? word : word.text === "--resume" ? words[i + 1] : undefined;
    const id = inline ? word.text.slice(RESUME_INLINE.length) : idWord?.text;
    // A bare `--resume` opens a picker; the next word is then another option.
    if (!idWord || !plain(idWord) || !id || !SESSION_UUID.test(id)) continue;
    if (await alive(id)) return command;
    return `${command.slice(0, word.start)}--session-id ${id}${command.slice(idWord.end)}`;
  }
  return command;
}

// `resume <id>`: what a restore appends for a known thread. Not anchored to the end: the aya brief's
// `-c 'developer_instructions=...'` can follow it by the time the host sees the command.
const CODEX_RESUME = /(\s+)resume\s+([A-Za-z0-9_.:/][A-Za-z0-9_.:/-]*)(?=\s|$)/;

/** A restore of a thread codex no longer has starts fresh: `codex resume <gone>` exits at once and the pane would
 *  come back dead. A store that cannot be read is not "gone". */
export async function withLiveCodexResume(
  command: string,
  home: string,
  onError: (err: Error) => void = () => {},
): Promise<string> {
  const match = CODEX_RESUME.exec(command);
  if (!match || !launchesAgentDirectly(command)) return command;
  const fresh = () => `${command.slice(0, match.index)}${command.slice(match.index + match[0].length)}`;
  const statePath = await newestDb(home, "state");
  if (!statePath) return fresh();
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const state = new DatabaseSync(statePath, { readOnly: true });
    try {
      const row = state.prepare("SELECT * FROM threads WHERE id = ?").get(match[2]) as { archived?: unknown } | undefined;
      if (row && !row.archived) return command;
    } finally {
      state.close();
    }
  } catch (err) {
    onError(asError(err));
    return command;
  }
  return fresh();
}

/** A resume of a grok session whose folder is gone starts a new one under the
 *  same id; the id under any folder counts (grok's naming is only known for the cwd). */
export async function withLiveGrokResume(command: string, home: string, cwd: string): Promise<string> {
  return restartGoneResume(command, async (id) => {
    if (await pathExists(grokSessionDir(home, cwd, id))) return true;
    const folders = await fs.readdir(path.join(home, "sessions")).catch(() => [] as string[]);
    return (await Promise.all(folders.map((name) => pathExists(path.join(home, "sessions", name, id))))).includes(true);
  });
}
