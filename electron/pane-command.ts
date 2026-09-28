// What a pane's command is, and how to run it; pure, so the app and the pty
// host share it without the app loading the host's terminal code.

import * as path from "node:path";

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** `command` run with `dir` first on PATH. As an assignment on the command
 *  itself it applies after the shell's rc files, which may reorder PATH. */
export function withCliFirst(command: string, dir: string): string {
  return `PATH=${shellQuote(dir)}:"$PATH" ${command}`;
}

/** Append `dir` to a PATH value unless it is already there: an installed
 *  shim earlier on PATH keeps winning, the bundled CLI is the fallback. */
export function pathWithFallbackDir(value: string | undefined, dir: string): string {
  if (!value) return dir;
  return value.split(path.delimiter).includes(dir) ? value : `${value}${path.delimiter}${dir}`;
}

/** A plain interactive shell, not an agent: Enter would run typed text. */
export function isShellCommand(command: string): boolean {
  return /^(?:\$SHELL|(?:\S*\/)?(?:bash|zsh|sh|fish))(?:\s+-[a-z]+)*\s*$/.test(command.trim());
}

// Set by a running Claude Code session for its own children. Aya started from
// such a session must not hand them to its panes: Claude would then save no
// transcript (nothing for --continue) and each pane would get its token.
const SESSION_MARKERS = new Set([
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_PID",
]);

/** The environment without another session's markers; the user's own
 *  settings (CLAUDE_CONFIG_DIR, CLAUDE_CODE_USE_BEDROCK, ...) stay. */
export function withoutSessionMarkers(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !SESSION_MARKERS.has(key)));
}
