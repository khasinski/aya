// Claude writes <configDir>/sessions/<pid>.json for each running CLI, with the
// conversation that process is in. Aya reads it so a restart resumes that one.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { AGENT_SESSION_POLL_MS, asError, LOG_CLOCK_SLACK_MS, pollSession, restartGoneResume } from "./agent-session";
import { isSafeSessionId } from "./osc-extractor";
import { pathExists } from "./path-exists";
import { expandUserPath } from "./usage";

/** Claude Code's project-directory name for a cwd: every non-alphanumeric
 *  character becomes "-" (e.g. /Users/x/proj → -Users-x-proj). */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

const execFileAsync = promisify(execFile);

export function claudeConfigDir(configDir: string | undefined): string {
  return expandUserPath(configDir || process.env.CLAUDE_CONFIG_DIR || "~/.claude");
}

/** Null until Claude has registered the pid (it writes the file late), for an id unsafe on a command line, and with
 *  `sinceMs` for a process started before then: a dead claude's file outlives it, and its pid is reused. */
export async function readClaudeSessionId(configDir: string | undefined, pid: number, sinceMs?: number): Promise<string | null> {
  const file = path.join(claudeConfigDir(configDir), "sessions", `${pid}.json`);
  try {
    const { sessionId, startedAt } = JSON.parse(await fs.readFile(file, "utf-8")) as { sessionId?: unknown; startedAt?: unknown };
    if (sinceMs !== undefined && typeof startedAt === "number" && startedAt < sinceMs - LOG_CLOCK_SLACK_MS) return null;
    return typeof sessionId === "string" && isSafeSessionId(sessionId) ? sessionId : null;
  } catch {
    return null;
  }
}

/** Whether Claude saved a transcript for `sessionId`: it writes one with the
 *  first message, and `--resume` of an unsaved id exits at once. */
export async function claudeTranscriptExists(
  configDir: string | undefined,
  cwd: string,
  sessionId: string,
): Promise<boolean> {
  const projects = path.join(claudeConfigDir(configDir), "projects");
  if (await pathExists(path.join(projects, claudeProjectDirName(cwd), `${sessionId}.jsonl`))) return true;
  // A folder Aya cannot name (symlinked cwd; a long one is cut at 200 characters
  // plus a hash) must not read as "gone": --session-id of an existing id is fatal.
  const others = await fs.readdir(projects).catch(() => [] as string[]);
  const found = await Promise.all(others.map((name) => pathExists(path.join(projects, name, `${sessionId}.jsonl`))));
  return found.includes(true);
}

/** Reports a claude process's conversation on every poll (an event sent while no window is connected is lost); with
 *  `cwd` only one with a transcript to resume, with `sinceMs` only a process started since. */
export function watchClaudeSession(
  configDir: string | undefined,
  pid: number,
  report: (sessionId: string) => void,
  intervalMs: number = AGENT_SESSION_POLL_MS,
  cwd?: string,
  sinceMs?: number,
): () => void {
  let resumable: string | null = null;
  return pollSession(
    async () => {
      const sessionId = await readClaudeSessionId(configDir, pid, sinceMs);
      if (!sessionId || !cwd || sessionId === resumable) return sessionId;
      if (!(await claudeTranscriptExists(configDir, cwd, sessionId))) return null;
      resumable = sessionId;
      return sessionId;
    },
    report,
    intervalMs,
  );
}

const CONFIG_DIR_MARK = "aya-claude-config-dir:";
const CONFIG_DIR_TIMEOUT_MS = 10_000;

/** CLAUDE_CONFIG_DIR as the pane's own login shell exports it, "" when unset;
 *  throws when the shell does not answer. Rc files run after Aya's env is built. */
export async function shellClaudeConfigDir(
  shell: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = CONFIG_DIR_TIMEOUT_MS,
): Promise<string> {
  const script = `printf '\\n${CONFIG_DIR_MARK}%s\\n' "$CLAUDE_CONFIG_DIR"`;
  const { stdout } = await execFileAsync(shell, ["-l", "-i", "-c", script], {
    cwd,
    env,
    timeout: timeoutMs,
    windowsHide: true,
  });
  const line = stdout.split("\n").reverse().find((l) => l.startsWith(CONFIG_DIR_MARK));
  if (line === undefined) throw new Error("the shell did not report CLAUDE_CONFIG_DIR");
  return line.slice(CONFIG_DIR_MARK.length);
}

/** `--resume <id>` of a conversation Claude no longer has becomes `--session-id <id>`. `configDir` set by
 *  the command is the only dir; else the env's or the pane shell's. A shell that cannot answer keeps the resume. */
export function withLiveClaudeResume(
  command: string,
  configDir: string | undefined,
  cwd: string,
  paneConfigDir: () => Promise<string> = async () => "",
  onProbeError: (err: Error) => void = () => {},
): Promise<string> {
  return restartGoneResume(command, async (id) => {
    if (configDir !== undefined) return claudeTranscriptExists(configDir, cwd, id);
    if (await claudeTranscriptExists(undefined, cwd, id)) return true;
    try {
      return await claudeTranscriptExists(await paneConfigDir() || undefined, cwd, id);
    } catch (err) {
      onProbeError(asError(err));
      return true;
    }
  });
}
