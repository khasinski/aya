// Claude writes <configDir>/sessions/<pid>.json for each running CLI, with the
// conversation that process is in. Aya reads it so a restart resumes that one.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { isSafeSessionId } from "./osc-extractor";
import { expandUserPath } from "./usage";

export const CLAUDE_SESSION_POLL_MS = 5_000;

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

/** Reports the conversation a claude process is in on every poll, not only on
 *  change: an event sent while no Aya window is connected is lost. */
export function watchClaudeSession(
  configDir: string | undefined,
  pid: number,
  report: (sessionId: string) => void,
  intervalMs: number = CLAUDE_SESSION_POLL_MS,
): () => void {
  let stopped = false;
  const timer = setInterval(async () => {
    const sessionId = await readClaudeSessionId(configDir, pid);
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
