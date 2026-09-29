// opencode keys a project by the repo's root commit, so every git worktree of a
// repo is one project and `--continue` resumes the newest session of any of them
// (measured on opencode 1.18.30). A pane must resume the session of ITS directory.

import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { SESSION_ID_RE } from "./osc-extractor";
import { leadingEnvAssignments } from "./shell-words";

const execFileAsync = promisify(execFile);

const LIST_TIMEOUT_MS = 5000;
export const OPENCODE_LIST_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const OPENCODE_BINARY = /^opencode(?:\s|$)/;
const CONTINUE_FLAG = /\s--continue(?=\s|$)/;

export interface OpencodeSession {
  id: string;
  directory: string;
  updated: number;
}

function isSession(row: unknown): row is OpencodeSession {
  const { id, directory, updated } = (row ?? {}) as Record<string, unknown>;
  return (
    typeof id === "string" &&
    SESSION_ID_RE.test(id) &&
    typeof directory === "string" &&
    typeof updated === "number"
  );
}

/** `opencode session list --format json`, which prints nothing when there are
 *  no sessions. Throws on any other shape: an unknown shape is not "none". */
export function parseSessionList(stdout: string): OpencodeSession[] {
  if (!stdout.trim()) return [];
  const rows: unknown = JSON.parse(stdout);
  if (!Array.isArray(rows) || !rows.every(isSession)) {
    throw new Error("opencode session list: unrecognised output shape");
  }
  return rows.map(({ id, directory, updated }) => ({ id, directory, updated }));
}

/** Top-level sessions of the project containing `cwd`, across all its worktrees. */
export async function listOpencodeSessions(cwd: string): Promise<OpencodeSession[]> {
  const { stdout } = await execFileAsync("opencode", ["session", "list", "--format", "json"], {
    cwd,
    timeout: LIST_TIMEOUT_MS,
    maxBuffer: OPENCODE_LIST_MAX_BUFFER_BYTES,
    windowsHide: true,
  });
  return parseSessionList(stdout);
}

/** Turns `--continue` into `--session <this directory's newest>`, or drops it
 *  when the directory has none: a fresh session beats another worktree's. */
export async function ownSessionCommand(
  command: string,
  cwd: string,
  list: (cwd: string) => Promise<OpencodeSession[]> = listOpencodeSessions,
  onLookupError: (err: unknown) => void = (err) => console.warn("[aya] opencode session lookup failed:", err),
): Promise<string> {
  const trimmed = command.trim();
  const { rest } = leadingEnvAssignments(trimmed);
  const program = trimmed.slice(rest);
  if (!OPENCODE_BINARY.test(program) || !CONTINUE_FLAG.test(program)) return command;
  const directory = await realpath(cwd).catch(() => cwd);
  let sessions: OpencodeSession[];
  try {
    sessions = await list(directory);
  } catch (err) {
    onLookupError(err);
    return command;
  }
  const own = sessions
    .filter((s) => s.directory === directory)
    .sort((a, b) => b.updated - a.updated)[0];
  const resumed = program.replace(CONTINUE_FLAG, own ? ` --session ${own.id}` : "");
  return `${trimmed.slice(0, rest)}${resumed}`;
}
