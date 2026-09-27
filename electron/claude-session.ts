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
