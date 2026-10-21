// Lightweight git info for the status bar. We shell out to `git` because we
// already require a working POSIX env (claude / codex need it too). If git
// isn't installed or the dir isn't a repo, return nulls.

import { exec, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ProjectGitInfo, Worktree, WorktreeStatus } from "./types";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// Timeout for quick git info commands (branch / status).
const GIT_COMMAND_TIMEOUT_MS = 1500;
// Timeout for the (potentially larger) git diff command.
const GIT_DIFF_TIMEOUT_MS = 3000;
// Ceiling on git diff output buffered into memory (5MB).
const GIT_DIFF_MAX_BUFFER_BYTES = 5_000_000;
export const GIT_ERROR_MESSAGE_MAX_CHARS = 300;

// Aya only observes repository state. `git status` can otherwise refresh the
// index as an optimization, which may briefly create .git/index.lock and race
// with user-initiated git commands.
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0" } as const;
const NO_LOCKS = "--no-optional-locks";
const READ_ONLY_GIT = `git ${NO_LOCKS}`;

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

/** Parse `git status --porcelain --branch`: the "## <branch>" header carries
 *  the branch name, every other non-blank line is one dirty entry. Preserves
 *  the old two-command contract: unborn repos ("No commits yet") report
 *  {null, 0} and a detached HEAD reports "HEAD" (what rev-parse used to say).
 *  Exported for unit tests. */
export function parseStatusWithBranch(stdout: string): ProjectGitInfo {
  let branch: string | null = null;
  let dirty = 0;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("## ")) {
      const head = line.slice(3);
      if (head.startsWith("No commits yet")) return { branch: null, dirty: 0 };
      // "main...origin/main [ahead 1]" | "HEAD (no branch)" | "main"
      branch = head.startsWith("HEAD") ? "HEAD" : head.split("...")[0].trim();
    } else if (line.trim().length > 0) {
      dirty += 1;
    }
  }
  return { branch: branch || null, dirty };
}

export async function getGitInfo(directory: string): Promise<ProjectGitInfo> {
  try {
    // This runs on the status-bar poll (every 3s while visible), so keep it to
    // ONE process: --branch folds the branch header into the porcelain output,
    // and execFile skips the /bin/sh wrapper exec() would fork.
    const { stdout } = await execFileAsync(
      "git",
      [NO_LOCKS, "status", "--porcelain", "--branch"],
      { cwd: directory, ...OPTS },
    );
    return parseStatusWithBranch(stdout);
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
  return listWorktreesOrThrow(directory).catch(() => []);
}

/** `listWorktrees` for a caller that must tell "git failed" from "no worktrees". */
export async function listWorktreesOrThrow(directory: string): Promise<Worktree[]> {
  const { stdout } = await execAsync(
    `${READ_ONLY_GIT} worktree list --porcelain`,
    { cwd: directory, ...OPTS },
  );
  // Paths come as recorded, not symlink-resolved like getGitRoot (macOS /tmp -> /private/tmp), and the status bar
  // matches against that root. A prunable/removed checkout cannot be resolved; it keeps its recorded path.
  return await Promise.all(
    parseWorktrees(stdout).map(async (w) => {
      try {
        return { ...w, path: await realpath(w.path) };
      } catch {
        return w;
      }
    }),
  );
}

/** Outcome of a git command that CHANGES the repository. Unlike every read
 *  above (which degrades to an empty result), a failed mutation must reach the
 *  user: "branch already exists" or "worktree is dirty" is information they
 *  need in order to act, and a silent no-op would look like a broken button. */
export type GitMutationResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

// Creating a worktree can pull, resolve refs and write a whole checkout, so it
// gets a longer leash than the read-only status probes.
const GIT_MUTATION_TIMEOUT_MS = 30_000;
const MUTATION_OPTS = {
  timeout: GIT_MUTATION_TIMEOUT_MS,
  windowsHide: true,
  env: GIT_ENV,
} as const;

/** git's own message, trimmed to something a dialog can show.
 *
 *  git writes PROGRESS to stderr as well as errors ("Preparing worktree (new
 *  branch 'x')" precedes the failure), so the first line is usually the wrong
 *  one. Prefer an explicitly-marked error line and fall back to the last line,
 *  which is where git puts the reason when it is unmarked. */
function gitErrorMessage(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  const raw = (e?.stderr || e?.message || "git command failed").trim();
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  const marked = lines.find((line) => /^(?:fatal|error):/i.test(line));
  const chosen = marked ?? lines[lines.length - 1] ?? raw;
  return chosen.replace(/^(?:fatal|error):\s*/i, "").slice(0, GIT_ERROR_MESSAGE_MAX_CHARS);
}

/** Create a worktree at `path`. With `branch`, creates that branch (from
 *  `base`, or the current HEAD); without one, checks out an existing ref.
 *
 *  This is the first command in Aya that writes to a repository — everything
 *  else only observes — so it uses execFile (no shell) and surfaces failures
 *  rather than swallowing them. */
export async function createWorktree(
  directory: string,
  path: string,
  branch?: string,
  base?: string,
): Promise<GitMutationResult> {
  if ([path, branch, base].some((value) => value?.startsWith("-"))) {
    return { ok: false, error: "Worktree paths, branches, and starting refs cannot begin with a hyphen." };
  }
  const args = ["worktree", "add"];
  if (branch) args.push("-b", branch);
  args.push("--", path);
  if (base) args.push(base);
  try {
    await execFileAsync("git", args, { cwd: directory, ...MUTATION_OPTS });
    return { ok: true, path };
  } catch (err) {
    return { ok: false, error: gitErrorMessage(err) };
  }
}

export interface WorktreeBatchRequest {
  directory: string;
  slug: string;
  count: number;
  base: string;
}

export interface CreatedWorktree {
  path: string;
  branch: string;
}

export interface WorktreeBatchResult {
  created: CreatedWorktree[];
  errors: string[];
}

/** Create up to eight sibling worktrees from one verified commit-ish. Names
 *  are deterministic and skipped when already taken; earlier successes are
 *  retained if a later creation fails. */
export async function createWorktreeBatch(
  request: WorktreeBatchRequest,
): Promise<WorktreeBatchResult> {
  const { directory, count, base } = request;
  const slug = request.slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  if (!slug) return { created: [], errors: ["Enter a name using letters or numbers."] };
  if (!Number.isInteger(count) || count < 1 || count > 8) {
    return { created: [], errors: ["Choose between 1 and 8 worktrees."] };
  }
  if (base.startsWith("-")) return { created: [], errors: ["That starting ref was not found."] };
  const resolved = await execFileAsync("git", ["rev-parse", "--verify", "--quiet", "--end-of-options", `${base}^{commit}`], { cwd: directory, ...OPTS }).catch(() => null);
  const resolvedBase = resolved?.stdout.trim() ?? "";
  if (!/^[0-9a-f]{40,64}$/i.test(resolvedBase)) return { created: [], errors: ["That starting ref was not found."] };

  const repoName = path.basename(path.resolve(directory));
  const parent = path.dirname(path.resolve(directory));
  const worktreeRoot = path.join(parent, `${repoName}.worktrees`);
  try {
    await mkdir(worktreeRoot, { recursive: true });
  } catch (err) {
    return { created: [], errors: [gitErrorMessage(err)] };
  }
  const branchesText = await execFileAsync("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"], { cwd: directory, ...OPTS })
    .then(({ stdout }) => stdout).catch(() => "");
  const usedBranches = new Set(branchesText.split(/\r?\n/).filter(Boolean));
  const usedPaths = new Set((await listWorktrees(directory)).map((worktree) => path.resolve(worktree.path)));
  const created: CreatedWorktree[] = [];
  const errors: string[] = [];
  let candidate = 1;
  while (created.length < count) {
    const suffix = `${slug}-${candidate++}`;
    const branch = `aya/${suffix}`;
    const checkout = path.join(worktreeRoot, suffix);
    if (usedBranches.has(branch) || usedPaths.has(path.resolve(checkout))) continue;
    usedBranches.add(branch);
    usedPaths.add(path.resolve(checkout));
    const result = await createWorktree(directory, checkout, branch, resolvedBase);
    if (result.ok) created.push({ path: checkout, branch });
    else {
      errors.push(`${branch}: ${result.error}`);
      // A repeated filesystem/refusal failure is unlikely to improve by
      // skipping more names; keep successful worktrees and report the rest.
      break;
    }
  }
  return { created, errors };
}

export interface WorktreeBranchRemovalInfo {
  branch: string | null;
  canDelete: boolean;
  reason: string | null;
  unmerged: number | null;
}

async function branchUnmergedCount(directory: string, branch: string, base: string): Promise<number | null> {
  const resolvedBase = await execFileAsync("git", ["rev-parse", "--verify", "--quiet", "--end-of-options", `${base}^{commit}`], { cwd: directory, ...OPTS })
    .then(({ stdout }) => stdout.trim()).catch(() => "");
  if (!/^[0-9a-f]{40,64}$/i.test(resolvedBase)) return null;
  const safeRef = await execFileAsync("git", ["check-ref-format", `refs/heads/${branch}`], { cwd: directory, ...OPTS }).then(() => true).catch(() => false);
  if (!safeRef) return null;
  const upstream = await execFileAsync("git", ["for-each-ref", "--format=%(upstream:short)", `refs/heads/${branch}`], { cwd: directory, ...OPTS })
    .then(({ stdout }) => stdout.trim()).catch(() => "");
  const upstreamCommit = upstream
    ? await execFileAsync("git", ["rev-parse", "--verify", "--quiet", "--end-of-options", `${upstream}^{commit}`], { cwd: directory, ...OPTS }).then(({ stdout }) => stdout.trim()).catch(() => "")
    : "";
  if (upstream && !/^[0-9a-f]{40,64}$/i.test(upstreamCommit)) return null;
  const exclusions = [resolvedBase, ...(upstreamCommit ? [upstreamCommit] : [])];
  const raw = await execFileAsync("git", ["rev-list", "--count", `refs/heads/${branch}`, "--not", ...exclusions], { cwd: directory, ...OPTS })
    .then(({ stdout }) => stdout.trim()).catch(() => "");
  const count = Number.parseInt(raw, 10);
  return Number.isFinite(count) ? count : null;
}

/** A branch is removable only when every commit is reachable from the chosen
 *  base or its configured upstream. This is advisory UI data; deletion
 *  repeats the check immediately before `git branch -d`. */
export async function worktreeBranchRemovalInfo(
  directory: string,
  worktreePath: string,
  base: string,
): Promise<WorktreeBranchRemovalInfo> {
  const requestedPath = await realpath(worktreePath).catch(() => path.resolve(worktreePath));
  const entries = await listWorktrees(directory);
  let matched: Worktree | undefined;
  for (const item of entries) {
    const listedPath = await realpath(item.path).catch(() => path.resolve(item.path));
    if (listedPath === requestedPath) { matched = item; break; }
  }
  const branch = matched?.branch ?? null;
  if (!branch || matched?.isMain) return { branch, canDelete: false, reason: "This checkout has no branch Aya can remove.", unmerged: null };
  const count = await branchUnmergedCount(directory, branch, base);
  if (count === null) return { branch, canDelete: false, reason: "Aya could not check whether the branch has unshared commits.", unmerged: null };
  return {
    branch,
    canDelete: count === 0,
    reason: count === 0 ? null : `It has ${count} commit${count === 1 ? "" : "s"} that ${count === 1 ? "is" : "are"} not pushed or merged into ${base}.`,
    unmerged: count,
  };
}

export async function removeWorktreeAndBranch(
  directory: string,
  worktreePath: string,
  base: string,
  deleteBranch: boolean,
  expectedBranch: string | null,
): Promise<{ ok: true; path: string; branchDeleted: boolean } | { ok: false; error: string }> {
  const info = await worktreeBranchRemovalInfo(directory, worktreePath, base);
  const listed = await listWorktrees(directory);
  const requestedPath = await realpath(worktreePath).catch(() => path.resolve(worktreePath));
  let target: Worktree | undefined;
  for (const item of listed) {
    const listedPath = await realpath(item.path).catch(() => path.resolve(item.path));
    if (listedPath === requestedPath) { target = item; break; }
  }
  if (!target || target.isMain) return { ok: false, error: "Choose a linked worktree to remove." };
  if (target.branch !== expectedBranch) return { ok: false, error: "This worktree's branch changed while the dialog was open. Close it and review the current branch before removing it." };
  const validatedPath = target.path;
  const removed = await removeWorktree(directory, validatedPath);
  if (!removed.ok) return removed;
  if (!deleteBranch || !info.branch || info.branch !== expectedBranch) return { ok: true, path: worktreePath, branchDeleted: false };
  // Recheck after removing the checkout, immediately before branch deletion.
  const branch = info.branch;
  if (!branch) return { ok: true, path: worktreePath, branchDeleted: false };
  const currentCount = await branchUnmergedCount(directory, branch, base);
  if (currentCount !== 0) return { ok: true, path: worktreePath, branchDeleted: false };
  try {
    await execFileAsync("git", ["branch", "-d", "--", branch], { cwd: directory, ...MUTATION_OPTS });
    return { ok: true, path: worktreePath, branchDeleted: true };
  } catch {
    return { ok: true, path: worktreePath, branchDeleted: false };
  }
}

/** Remove a worktree. Git refuses when the checkout has uncommitted changes;
 *  `force` overrides that, so the caller must ask for it deliberately. */
export async function removeWorktree(
  directory: string,
  path: string,
  force = false,
): Promise<GitMutationResult> {
  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push(path);
  try {
    await execFileAsync("git", args, { cwd: directory, ...MUTATION_OPTS });
    return { ok: true, path };
  } catch (err) {
    return { ok: false, error: gitErrorMessage(err) };
  }
}

/** Every worktree of the repo, each with its live branch and dirty count, for
 *  the status bar's checkout picker. The per-worktree `git status` calls only
 *  run when there is more than one worktree — with a single checkout there is
 *  nothing to pick between, and the status bar already polls that one. */
export async function listWorktreeStatus(
  directory: string,
): Promise<WorktreeStatus[]> {
  const worktrees = await listWorktrees(directory);
  if (worktrees.length < 2) {
    return worktrees.map((w) => ({ ...w, dirty: 0 }));
  }
  return Promise.all(
    worktrees.map(async (w) => {
      // A prunable worktree's checkout is gone; running git there just fails.
      if (w.prunable || w.bare) return { ...w, dirty: 0 };
      // Take only the dirty count from `git status`: the branch already comes
      // from `git worktree list` (live, and null for a detached HEAD). Folding
      // in getGitInfo's branch would overwrite that null with its "HEAD"
      // sentinel, so the picker would show "HEAD" where it means "detached".
      const info = await getGitInfo(w.path);
      return { ...w, dirty: info.dirty };
    }),
  );
}

/** The root of the checkout containing `directory` (its own root for a git
 *  worktree, not the main one), or null outside a repo. A live terminal cwd can
 *  sit deep inside a worktree, and the rest of this file's callers assume a
 *  checkout root: `git status --porcelain` reports paths from the root, so the
 *  untracked-file diff synthesis would read them against the wrong base. */
export async function getGitRoot(directory: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      [NO_LOCKS, "rev-parse", "--show-toplevel"],
      { cwd: directory, ...OPTS },
    );
    const root = stdout.trim();
    return root.length > 0 ? root : null;
  } catch {
    return null;
  }
}

/** Short hash of HEAD; null outside a repo or before the first commit. */
export async function headCommit(directory: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      [NO_LOCKS, "rev-parse", "--short", "HEAD"],
      { cwd: directory, ...OPTS },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// Untracked files whose size and mtime join the fingerprint; a repo with more has its first ones counted.
const UNTRACKED_FINGERPRINT_LIMIT = 5000;

/** A fingerprint of the working tree: `git status --porcelain` (untracked files too), the size and mtime of each
 *  untracked file (an edit inside one changes neither list nor diff), and the diff of tracked files against HEAD,
 *  hashed as it streams. null when any cannot be read (outside a repo, no commit yet). */
export async function workingTreeState(directory: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", [NO_LOCKS, "status", "--porcelain=v1", "-z"], { cwd: directory, ...DIFF_OPTS });
    const hash = createHash("sha1").update(stdout).update("\0");
    const { stdout: untracked } = await execFileAsync("git", [NO_LOCKS, "ls-files", "--others", "--exclude-standard", "-z"], { cwd: directory, ...DIFF_OPTS });
    for (const file of untracked.split("\0").filter(Boolean).slice(0, UNTRACKED_FINGERPRINT_LIMIT)) {
      const info = await stat(path.join(directory, file)).catch(() => null);
      hash.update(`${file}\0${info ? `${info.size}:${info.mtimeMs}` : "-"}\0`);
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn("git", [NO_LOCKS, "diff", "HEAD", "--no-ext-diff", "--no-color", "--binary"], { cwd: directory, env: GIT_ENV, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      const timer = setTimeout(() => child.kill(), GIT_DIFF_TIMEOUT_MS);
      child.stdout.on("data", (chunk: Buffer) => hash.update(chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`git diff exited ${code}`));
      });
    });
    return hash.digest("hex");
  } catch {
    return null;
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
