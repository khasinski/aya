import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeExecutable } from "./executable.mjs";

/** A stand-in for the user's shell that takes only Aya's `-l -i -c SCRIPT` and runs the script
 *  without /etc/profile: on macOS its path_helper moves a test's fake bin behind /opt/homebrew/bin,
 *  so an installed opencode or codex answered instead of the fake. */
export function protocolShell() {
  const shell = path.join(mkdtempSync(path.join(tmpdir(), "aya-login-sh-")), "sh");
  writeExecutable(shell, '#!/bin/sh\n[ "$#" -eq 4 ] && [ "$1" = "-l" ] && [ "$2" = "-i" ] && [ "$3" = "-c" ] || exit 2\neval "$4"\n');
  return shell;
}
