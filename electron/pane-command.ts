// What a pane's command is, and how to run it; pure, so the app and the pty
// host share it without the app loading the host's terminal code.

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** `command` run with `dir` first on PATH. As an assignment on the command
 *  itself it applies after the shell's rc files, which may reorder PATH. */
export function withCliFirst(command: string, dir: string): string {
  return `PATH=${shellQuote(dir)}:"$PATH" ${command}`;
}

/** A plain interactive shell, not an agent: Enter would run typed text. */
export function isShellCommand(command: string): boolean {
  return /^(?:\$SHELL|(?:\S*\/)?(?:bash|zsh|sh|fish))(?:\s+-[a-z]+)*\s*$/.test(command.trim());
}
