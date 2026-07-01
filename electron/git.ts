// Lightweight git info for the status bar. We shell out to `git` because we
// already require a working POSIX env (claude / codex need it too). If git
// isn't installed or the dir isn't a repo, return nulls.

import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { ProjectGitInfo, Worktree } from "./types";

const execAsync = promisify(exec);

// Timeout for quick git info commands (branch / status).
const GIT_COMMAND_TIMEOUT_MS = 1500;
// Timeout for the (potentially larger) git diff command.
const GIT_DIFF_TIMEOUT_MS = 3000;
// Ceiling on git diff output buffered into memory (5MB).
const GIT_DIFF_MAX_BUFFER_BYTES = 5_000_000;

// Aya only observes repository state. `git status` can otherwise refresh the
// index as an optimization, which may briefly create .git/index.lock and race
// with user-initiated git commands.
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0" } as const;
const READ_ONLY_GIT = "git --no-optional-locks";

const OPTS = {
  timeout: GIT_COMMAND_TIMEOUT_MS,
  windowsHide: true,
  env: GIT_ENV,
} as const;
const DIFF_OPTS = {
  timeout: GIT_DIFF_TIMEOUT_MS,
  maxBuffer: GIT_DIFF_MAX_BUFFER_BYTES,
  windowsHide: true,
  env: GIT_ENV,
} as const;

export async function getGitInfo(directory: string): Promise<ProjectGitInfo> {
  try {
    const [{ stdout: branch }, { stdout: status }] = await Promise.all([
      execAsync(`${READ_ONLY_GIT} rev-parse --abbrev-ref HEAD`, {
        cwd: directory,
        ...OPTS,
      }),
      execAsync(`${READ_ONLY_GIT} status --porcelain`, {
        cwd: directory,
        ...OPTS,
      }),
    ]);
    const dirty = status.split("\n").filter((l) => l.trim().length > 0).length;
    return { branch: branch.trim() || null, dirty };
  } catch {
    return { branch: null, dirty: 0 };
  }
}

/** Parse `git worktree list --porcelain`. Blocks are separated by a blank line;
 *  each starts with `worktree <path>` then optional `HEAD <sha>` /
 *  `branch refs/heads/<name>` / `detached` / `bare` / `prunable …`. The first
 *  block is the primary worktree. Exported for unit tests. */
export function parseWorktrees(porcelain: string): Worktree[] {
  const out: Worktree[] = [];
  let cur: {
    path: string;
    branch: string | null;
    detached: boolean;
    bare: boolean;
    prunable: boolean;
  } | null = null;
  const flush = () => {
    if (cur) out.push({ ...cur, isMain: out.length === 0 });
    cur = null;
  };
  for (const raw of porcelain.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.startsWith("worktree ")) {
      flush();
      cur = {
        path: line.slice("worktree ".length).trim(),
        branch: null,
        detached: false,
        bare: false,
        prunable: false,
      };
    } else if (!cur) {
      continue;
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      cur.detached = true;
    } else if (line === "bare") {
      cur.bare = true;
    } else if (line === "prunable" || line.startsWith("prunable ")) {
      cur.prunable = true;
    }
  }
  flush();
  return out;
}

/** List the git worktrees for the repo containing `directory`. Returns [] for a
 *  non-repo dir or if git is missing (read-only; safe to poll). */
export async function listWorktrees(directory: string): Promise<Worktree[]> {
  try {
    const { stdout } = await execAsync(
      `${READ_ONLY_GIT} worktree list --porcelain`,
      { cwd: directory, ...OPTS },
    );
    return parseWorktrees(stdout);
  } catch {
    return [];
  }
}

export interface GitChangedFile {
  status: string;
  path: string;
}

export function parseGitPorcelain(status: string): GitChangedFile[] {
  return status
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => ({
      status: line.slice(0, 2).trim() || "??",
      path: line.slice(3).trim(),
    }));
}

export async function getGitChangedFiles(directory: string): Promise<GitChangedFile[]> {
  try {
    const { stdout } = await execAsync(`${READ_ONLY_GIT} status --porcelain`, {
      cwd: directory,
      ...OPTS,
    });
    return parseGitPorcelain(stdout);
  } catch {
    return [];
  }
}

function quotePathForDiff(path: string): string {
  return path.replace(/\t/g, " ").replace(/\r?\n/g, " ");
}

function syntheticNewFileDiff(file: GitChangedFile, content: string): string {
  const filePath = quotePathForDiff(file.path);
  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return [
    `diff --git a/${filePath} b/${filePath}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join("\n");
}

export async function getGitDiff(directory: string): Promise<string> {
  try {
    const [{ stdout: diff }, files] = await Promise.all([
      execAsync(`${READ_ONLY_GIT} diff --no-ext-diff --no-color HEAD --`, {
        cwd: directory,
        ...DIFF_OPTS,
      }),
      getGitChangedFiles(directory),
    ]);
    const untracked = files.filter((file) => file.status === "??");
    const synthetic = await Promise.all(
      untracked.map(async (file) => {
        try {
          const content = await readFile(`${directory}/${file.path}`, "utf8");
          if (content.includes("\0")) return "";
          return syntheticNewFileDiff(file, content);
        } catch {
          return "";
        }
      }),
    );
    return [diff.trimEnd(), ...synthetic.filter(Boolean)].filter(Boolean).join("\n");
  } catch {
    return "";
  }
}
