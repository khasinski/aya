// Lightweight git info for the status bar. We shell out to `git` because we
// already require a working POSIX env (claude / codex need it too). If git
// isn't installed or the dir isn't a repo, return nulls.

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectGitInfo } from "./types";

const execAsync = promisify(exec);

const OPTS = { timeout: 1500, windowsHide: true } as const;

export async function getGitInfo(directory: string): Promise<ProjectGitInfo> {
  try {
    const [{ stdout: branch }, { stdout: status }] = await Promise.all([
      execAsync("git rev-parse --abbrev-ref HEAD", { cwd: directory, ...OPTS }),
      execAsync("git status --porcelain", { cwd: directory, ...OPTS }),
    ]);
    const dirty = status.split("\n").filter((l) => l.trim().length > 0).length;
    return { branch: branch.trim() || null, dirty };
  } catch {
    return { branch: null, dirty: 0 };
  }
}
