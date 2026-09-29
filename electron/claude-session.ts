// Claude writes <configDir>/sessions/<pid>.json for each running CLI, with the
// conversation that process is in. Aya reads it so a restart resumes that one.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { isSafeSessionId } from "./osc-extractor";
import { expandUserPath } from "./usage";

export const CLAUDE_SESSION_POLL_MS = 5_000;

/** Claude Code's project-directory name for a cwd: every non-alphanumeric
 *  character becomes "-" (e.g. /Users/x/proj → -Users-x-proj). */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function claudeConfigDir(configDir: string | undefined): string {
  return expandUserPath(configDir || process.env.CLAUDE_CONFIG_DIR || "~/.claude");
}

/** Null until Claude has registered the pid, or for an id unsafe on a command line. */
export async function readClaudeSessionId(
  configDir: string | undefined,
  pid: number,
): Promise<string | null> {
  const file = path.join(claudeConfigDir(configDir), "sessions", `${pid}.json`);
  try {
    const { sessionId } = JSON.parse(await fs.readFile(file, "utf-8")) as { sessionId?: unknown };
    return typeof sessionId === "string" && isSafeSessionId(sessionId) ? sessionId : null;
  } catch {
    return null;
  }
}

/** Whether Claude saved a transcript for `sessionId` under `cwd`. Claude writes
 *  it with the first message; until then `claude --resume <id>` exits with
 *  "No conversation found" and a restored pane would come back dead. */
export async function claudeTranscriptExists(
  configDir: string | undefined,
  cwd: string,
  sessionId: string,
): Promise<boolean> {
  // Claude names the folder after its real cwd; Aya may hold a symlinked one.
  const real = await fs.realpath(cwd).catch(() => cwd);
  for (const dir of new Set([cwd, real])) {
    const file = path.join(claudeConfigDir(configDir), "projects", claudeProjectDirName(dir), `${sessionId}.jsonl`);
    if (await fs.access(file).then(() => true, () => false)) return true;
  }
  return false;
}

/** Reports the conversation a claude process is in on every poll, not only on
 *  change: an event sent while no Aya window is connected is lost. With `cwd`,
 *  only a conversation that has a transcript to resume is reported. */
export function watchClaudeSession(
  configDir: string | undefined,
  pid: number,
  report: (sessionId: string) => void,
  intervalMs: number = CLAUDE_SESSION_POLL_MS,
  cwd?: string,
): () => void {
  let stopped = false;
  let resumable: string | null = null;
  const timer = setInterval(async () => {
    let sessionId = await readClaudeSessionId(configDir, pid);
    if (sessionId && cwd && sessionId !== resumable) {
      if (await claudeTranscriptExists(configDir, cwd, sessionId)) resumable = sessionId;
      else sessionId = null;
    }
    // A restart reuses the pty id: a read still in flight must not report
    // the old process's session over the new one's.
    if (!stopped && sessionId) report(sessionId);
  }, intervalMs);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

// A trailing `--resume <id>`: what a restore appends for a known conversation.
const TRAILING_RESUME_RE = /(\s)--resume[=\s]+([A-Za-z0-9-]+)\s*$/;

/** A restore that would resume a conversation Claude no longer has (purged
 *  after cleanupPeriodDays, or never saved) continues the latest one instead:
 *  `claude --resume <gone>` exits at once and the pane would come back dead. */
export async function withLiveClaudeResume(
  command: string,
  configDir: string | undefined,
  cwd: string,
): Promise<string> {
  const match = TRAILING_RESUME_RE.exec(command);
  if (!match || (await claudeTranscriptExists(configDir, cwd, match[2]))) return command;
  return `${command.slice(0, match.index)}${match[1]}--continue`;
}
