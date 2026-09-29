// opencode keys a project by the repo's root commit, so every git worktree of a
// repo is one project and `--continue` resumes the newest session of any of them
// (measured on opencode 1.18.30). A pane must resume the session of ITS directory.

import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import type { SpawnRequest } from "./types";

const execFileAsync = promisify(execFile);

const LIST_TIMEOUT_MS = 5000;
const OPENCODE_BINARY = /^opencode(?:\s|$)/;
const CONTINUE_FLAG = /\s--continue(?=\s|$)/;
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,200}$/;

export interface OpencodeSession {
  id: string;
  directory: string;
  updated: number;
}

/** `opencode session list --format json`; it prints nothing when there are no sessions. */
export function parseSessionList(stdout: string): OpencodeSession[] {
  if (!stdout.trim()) return [];
  const rows: unknown = JSON.parse(stdout);
  if (!Array.isArray(rows)) throw new Error("opencode session list: expected a JSON array");
  return rows.flatMap((row) => {
    const { id, directory, updated } = row ?? {};
    return typeof id === "string" &&
      SAFE_SESSION_ID.test(id) &&
      typeof directory === "string" &&
      typeof updated === "number"
      ? [{ id, directory, updated }]
      : [];
  });
}

/** Top-level sessions of the project containing `cwd`, across all its worktrees. */
export async function listOpencodeSessions(cwd: string): Promise<OpencodeSession[]> {
  const { stdout } = await execFileAsync("opencode", ["session", "list", "--format", "json"], {
    cwd,
    timeout: LIST_TIMEOUT_MS,
    windowsHide: true,
  });
  return parseSessionList(stdout);
}

/** Turns `--continue` into `--session <this directory's newest>`, or drops it
 *  when the directory has none: a fresh session beats another worktree's. */
export async function withOwnOpencodeSession(
  spawn: SpawnRequest,
  list: (cwd: string) => Promise<OpencodeSession[]> = listOpencodeSessions,
): Promise<SpawnRequest> {
  const command = spawn.command.trim();
  if (spawn.attachOnly || !OPENCODE_BINARY.test(command) || !CONTINUE_FLAG.test(command)) {
    return spawn;
  }
  const directory = await realpath(spawn.cwd).catch(() => spawn.cwd);
  let sessions: OpencodeSession[];
  try {
    sessions = await list(directory);
  } catch (err) {
    console.warn(`[aya] could not list opencode sessions in ${directory}; keeping --continue:`, err);
    return spawn;
  }
  const own = sessions
    .filter((s) => s.directory === directory)
    .sort((a, b) => b.updated - a.updated)[0];
  return {
    ...spawn,
    command: command.replace(CONTINUE_FLAG, own ? ` --session ${own.id}` : ""),
  };
}
