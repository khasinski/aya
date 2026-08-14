// Live working directory of a PTY's process. Aya otherwise knows only the cwd
// it SPAWNED a terminal with, which goes stale the moment you `cd` - typically
// into a git worktree an agent just created. The status bar's git surface wants
// the directory the console is actually in, so it asks for this.
//
// macOS has no /proc, so we shell out to lsof (~70ms, hence: active terminal
// only, on the existing 3s status poll). Linux reads /proc/<pid>/cwd directly.
// Windows: unsupported, callers fall back to the spawn cwd.

import { execFile } from "node:child_process";
import { readlink } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// lsof on a single pid is quick, but it can hang on an unresponsive mount;
// a cwd we failed to read is a non-event (we fall back), so cap it hard.
const LSOF_TIMEOUT_MS = 1500;

/** Pull the cwd out of `lsof -Fn` field output. Field mode prints one item per
 *  line prefixed by its field letter ("p1234", "fcwd", "n/path"); we want the
 *  `n` line that follows the `fcwd` line. Exported for unit tests. */
export function parseLsofCwd(stdout: string): string | null {
  let inCwdRecord = false;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("f")) {
      inCwdRecord = line.slice(1).trim() === "cwd";
    } else if (inCwdRecord && line.startsWith("n")) {
      const path = line.slice(1).trim();
      return path.length > 0 ? path : null;
    }
  }
  return null;
}

/** The process's current working directory, or null when it can't be read
 *  (dead process, unsupported platform, missing lsof, permission denied).
 *  Read-only and side-effect free. */
export async function getProcessCwd(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "win32") return null;
  if (process.platform === "linux") {
    try {
      return await readlink(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await execFileAsync(
      "lsof",
      ["-a", "-d", "cwd", "-p", String(pid), "-Fn"],
      {
        timeout: LSOF_TIMEOUT_MS,
        windowsHide: true,
        // Electron launched from Finder gets a minimal PATH; lsof lives in
        // /usr/sbin there, which that PATH does include - but a user shell
        // config can have narrowed it, so name the directory explicitly.
        env: { ...process.env, PATH: `${process.env.PATH ?? ""}:/usr/sbin` },
      },
    );
    return parseLsofCwd(stdout);
  } catch {
    return null;
  }
}
