import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const GIT_STATUS_TIMEOUT_MS = 12_000;
const GH_TIMEOUT_MS = 30_000;
const GH_ENV = { ...process.env, GH_NO_UPDATE_NOTIFIER: "1", GH_PROMPT_DISABLED: "1" };
const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0" });

export interface PublishStatus {
  branch: string | null;
  detached: boolean;
  defaultBranch: boolean;
  remote: string | null;
  pushDisabledReason: string | null;
  pullRequestDisabledReason: string | null;
  remoteError?: string;
}

export type PublishResult = { ok: true } | { ok: false; error: string };
export type PullRequestResult = { ok: true; url: string } | { ok: false; error: string };

type Runner = (command: string, args: string[], cwd: string, timeout: number, env?: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<string>;
type GhRunner = (directory: string, args: string[], timeout?: number) => Promise<string>;

const run: Runner = async (command, args, cwd, timeout, env = process.env, signal) => {
  const { stdout } = await execFileAsync(command, args, {
    // execFile captures output through pipes and does not attach a TTY.
    cwd, timeout, windowsHide: true, env, signal,
  });
  return stdout;
};

export async function runGh(directory: string, args: string[], timeout = GH_TIMEOUT_MS): Promise<string> {
  return run("gh", args, directory, timeout, GH_ENV);
}

function errorText(error: unknown): string {
  const value = error as { stderr?: string; message?: string };
  return (value?.stderr || value?.message || "The command failed.").trim();
}

async function git(runCommand: Runner, directory: string, args: string[], timeout: number, signal?: AbortSignal): Promise<string> {
  return (await runCommand("git", args, directory, timeout, gitEnv(), signal)).trim();
}

export interface RepoStateOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Test seam for deterministic deadline/cancellation coverage. */
  runCommand?: Runner;
}

async function repoState(directory: string, runCommand: Runner, options: RepoStateOptions = {}): Promise<PublishStatus> {
  const timeoutMs = options.timeoutMs ?? GIT_STATUS_TIMEOUT_MS;
  const deadlineAt = performance.now() + timeoutMs;
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(() => deadlineController.abort(new Error("Git status did not finish before its deadline.")), timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadlineController.signal]) : deadlineController.signal;
  const ensureActive = () => {
    if (!signal.aborted && performance.now() >= deadlineAt) {
      deadlineController.abort(new Error("Git status did not finish before its deadline."));
    }
    if (signal.aborted) throw signal.reason ?? new Error("Git status was cancelled.");
  };
  const runStatusGit = async (args: string[]): Promise<string> => {
    ensureActive();
    const remaining = Math.ceil(deadlineAt - performance.now());
    if (remaining <= 0) {
      deadlineController.abort(new Error("Git status did not finish before its deadline."));
      throw signal.reason ?? new Error("Git status did not finish before its deadline.");
    }
    try {
      const result = await git(runCommand, directory, args, remaining, signal);
      ensureActive();
      return result;
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      throw error;
    }
  };
  const optionalStatusGit = async (args: string[]): Promise<string | null> => {
    try { return await runStatusGit(args); }
    catch (error) {
      try { ensureActive(); } catch (abort) { throw abort ?? error; }
      return null;
    }
  };
  try {
    const branch = await optionalStatusGit(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const detached = branch === null;
    const remotes = (await runStatusGit(["remote"])).split("\n").filter(Boolean);
    let configured: string | null = null;
    if (branch) {
      for (const key of [`branch.${branch}.pushRemote`, "remote.pushDefault", `branch.${branch}.remote`]) {
        const value = await optionalStatusGit(["config", "--get", key]);
        if (value && value !== ".") { configured = value; break; }
      }
    }
    const missingRemoteError = configured && !remotes.includes(configured)
      ? `The configured push remote '${configured}' does not exist.` : undefined;
    const selectedRemote = missingRemoteError ? null : configured
      ? configured
      : remotes.length === 1 ? remotes[0]
      : null;
    const remoteError = missingRemoteError ?? (selectedRemote?.startsWith("-")
      ? "A Git remote name that starts with '-' cannot be used for publishing."
      : undefined);
    const remote = remoteError ? null : selectedRemote;

    let defaultBranch: string | null = null;
    for (const candidate of [...new Set(["origin", ...remotes])].filter((name) => remotes.includes(name))) {
      const ref = await optionalStatusGit(["symbolic-ref", "--quiet", "--short", `refs/remotes/${candidate}/HEAD`]);
      if (ref !== null) {
        defaultBranch = ref.slice(candidate.length + 1);
        break;
      }
    }
    const isDefault = Boolean(branch && defaultBranch && branch === defaultBranch);
    const remoteUnavailable = remoteError || (remote ? null
      : remotes.length > 1 ? "Choose a push remote in Git before publishing."
      : "Add a Git remote before pushing or opening a pull request.");
    const unknownDefaultBranch = !defaultBranch && remote
      ? "The remote default branch is unknown. Fetch the remote's default branch before opening a pull request."
      : null;
    ensureActive();
    return {
      branch,
      detached,
      defaultBranch: isDefault,
      remote,
      pushDisabledReason: detached ? "Create a branch before pushing." : remoteUnavailable,
      pullRequestDisabledReason: detached ? "Create a branch before opening a pull request."
        : remoteUnavailable || (isDefault ? "Pull requests are for branches; switch to a feature branch first."
        : unknownDefaultBranch),
      remoteError,
    };
  } finally {
    clearTimeout(deadlineTimer);
  }
}

export function getPublishStatus(directory: string, options: RepoStateOptions = {}): Promise<PublishStatus> {
  return repoState(directory, options.runCommand ?? run, options);
}

export async function pushCurrentBranch(directory: string, runCommand: Runner = run, pushTimeout = 60_000): Promise<PublishResult> {
  try {
    const state = await repoState(directory, runCommand);
    if (state.remoteError) return { ok: false, error: state.remoteError };
    if (state.pushDisabledReason || !state.branch || !state.remote) return { ok: false, error: state.pushDisabledReason || "Choose a branch before pushing." };
    const upstream = await git(runCommand, directory, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], GIT_STATUS_TIMEOUT_MS).catch(() => "");
    if (await git(runCommand, directory, ["symbolic-ref", "--quiet", "--short", "HEAD"], GIT_STATUS_TIMEOUT_MS).catch(() => "") !== state.branch) {
      return { ok: false, error: "The current branch changed before the push. Refresh and try again." };
    }
    const args = upstream
      ? ["push", state.remote, `refs/heads/${state.branch}:refs/heads/${state.branch}`]
      : ["push", "--set-upstream", state.remote, `refs/heads/${state.branch}:refs/heads/${state.branch}`];
    await runCommand("git", args, directory, pushTimeout, gitEnv());
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

function safePullRequestUrl(candidate: string, repoUrl: string): string | null {
  try {
    const url = new URL(candidate.trim());
    const repo = new URL(repoUrl.trim());
    if (url.protocol !== "https:" || repo.protocol !== "https:" || url.origin !== repo.origin) return null;
    const repoPath = repo.pathname.replace(/\/$/, "");
    const prefix = `${repoPath}/pull/`;
    if (!url.pathname.startsWith(prefix) || !/^[1-9][0-9]*$/.test(url.pathname.slice(prefix.length))) return null;
    return url.toString();
  } catch { return null; }
}

function isConfirmedMissingPullRequest(error: unknown): boolean {
  const value = error as { code?: unknown; stderr?: unknown };
  return value?.code === 1 && /no pull requests found/i.test(String(value.stderr ?? ""));
}

function isConfirmedUnauthenticated(error: unknown): boolean {
  const value = error as { code?: unknown; stderr?: unknown };
  return value?.code === 1 && /not logged in|not authenticated|authentication token not found/i.test(String(value.stderr ?? ""));
}

function isTimedOut(error: unknown): boolean {
  const value = error as { code?: unknown; killed?: boolean; signal?: string; message?: string };
  return value?.code === "ETIMEDOUT" || value?.killed === true || value?.signal === "SIGTERM"
    || /timed out|ETIMEDOUT|killed/i.test(String(value?.message ?? ""));
}

export async function createOrFindPullRequest(directory: string, runCommand: Runner = run, ghCommand: GhRunner = runGh): Promise<PullRequestResult> {
  try {
    const state = await repoState(directory, runCommand);
    if (state.pullRequestDisabledReason) return { ok: false, error: state.pullRequestDisabledReason };
    if (!state.branch) return { ok: false, error: "Create a branch before opening a pull request." };
    await ghCommand(directory, ["--version"]);
    try {
      await ghCommand(directory, ["auth", "status"]);
    } catch (error) {
      if (isConfirmedUnauthenticated(error)) return { ok: false, error: "GitHub CLI is not signed in. Run gh auth login, then try again." };
      if (isTimedOut(error)) return { ok: false, error: "GitHub did not respond in time. Try again." };
      return { ok: false, error: "Aya could not check your GitHub sign-in. Check your connection and try again." };
    }
    const repoUrl = (await ghCommand(directory, ["repo", "view", "--json", "url", "--jq", ".url"])).trim();
    if (await git(runCommand, directory, ["symbolic-ref", "--quiet", "--short", "HEAD"], GIT_STATUS_TIMEOUT_MS).catch(() => "") !== state.branch) {
      return { ok: false, error: "The current branch changed before the pull request could be opened. Refresh and try again." };
    }
    let output: string;
    try {
      output = await ghCommand(directory, ["pr", "view", state.branch, "--json", "url", "--jq", ".url"]);
    } catch (error) {
      if (!isConfirmedMissingPullRequest(error)) throw error;
      if (await git(runCommand, directory, ["symbolic-ref", "--quiet", "--short", "HEAD"], GIT_STATUS_TIMEOUT_MS).catch(() => "") !== state.branch) {
        return { ok: false, error: "The current branch changed before the pull request could be opened. Refresh and try again." };
      }
      output = await ghCommand(directory, ["pr", "create", "--fill", "--head", state.branch]);
    }
    const url = safePullRequestUrl(output, repoUrl);
    return url ? { ok: true, url } : { ok: false, error: "GitHub did not return a pull request link for this repository." };
  } catch (error) {
    const message = errorText(error);
    const details = error as { code?: string; killed?: boolean; signal?: string };
    if (details?.code === "ETIMEDOUT" || details?.killed || details?.signal === "SIGTERM" || /timed out|ETIMEDOUT|killed/i.test(message)) return { ok: false, error: "GitHub did not respond in time. Try again." };
    if (/ENOENT|not found/i.test(message)) return { ok: false, error: "GitHub CLI is not installed. Install gh, then try again." };
    return { ok: false, error: message };
  }
}
