// The user's login shell, resolved once and shared by everything that spawns
// one (pty.ts, harnesses.ts, shell-path.ts). Kept here as a single source of
// truth so the fallback order can't drift between the three call sites.

import * as os from "node:os";

/** Resolve the user's login shell. GUI-launched macOS apps often don't get
 *  SHELL in their launchd environment, so fall back to the shell from the
 *  OS user database before using /bin/bash as the last resort. */
export function userShell(): string {
  const envShell = process.env.SHELL?.trim();
  if (envShell) return envShell;
  const accountShell = os.userInfo().shell;
  return accountShell && accountShell.trim() ? accountShell : "/bin/bash";
}
