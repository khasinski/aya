// opencode keys a project by the repo's root commit, so every git worktree of a
// repo is one project and `--continue` resumes the newest session of any of them
// (measured on opencode 1.18.30). A pane must resume the session of ITS directory.

import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { SESSION_ID_RE } from "./osc-extractor";
import { leadingEnvAssignments } from "./shell-words";

const execFileAsync = promisify(execFile);

// Includes the pane shell's own startup (about 3 s for an interactive zsh
// under load, measured), not just opencode's ~1 s.
const LIST_TIMEOUT_MS = 10_000;
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

/** Runs the lookup as `argv` (the pane's own shell) with `env`. Shell startup
 *  may print first, so the list is read from the last line opening with `[`. */
export async function listOpencodeSessions(
  argv: string[],
  env: NodeJS.ProcessEnv,
): Promise<OpencodeSession[]> {
  const { stdout } = await execFileAsync(argv[0], argv.slice(1), {
    env,
    timeout: LIST_TIMEOUT_MS,
    maxBuffer: OPENCODE_LIST_MAX_BUFFER_BYTES,
    windowsHide: true,
  });
  const start = [...stdout.matchAll(/^\[/gm)].at(-1)?.index ?? 0;
  return parseSessionList(stdout.slice(start));
}

/** Turns `--continue` into `--session <this directory's newest>`, or drops it
 *  when the directory has none: a fresh session beats another worktree's.
 *  `list` gets the lookup command, carrying the pane command's env assignments. */
export async function ownSessionCommand(
  command: string,
  cwd: string,
  list: (directory: string, lookup: string) => Promise<OpencodeSession[]>,
  onLookupError: (err: unknown) => void = () => {},
): Promise<string> {
  const trimmed = command.trim();
  const { rest } = leadingEnvAssignments(trimmed);
  const program = trimmed.slice(rest);
  if (!OPENCODE_BINARY.test(program) || !CONTINUE_FLAG.test(program)) return command;
  const directory = await realpath(cwd).catch(() => cwd);
  let sessions: OpencodeSession[];
  try {
    sessions = await list(directory, `${trimmed.slice(0, rest)}opencode session list --format json`);
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
