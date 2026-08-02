// GitHub link resolution for the status bar. We shell out to the `gh` CLI
// because it already knows how to map a checkout to its PR / repo URL across
// SSH and HTTPS remotes. If gh isn't installed or the dir isn't a GitHub repo,
// everything resolves to null and the status bar simply shows nothing.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitHubLink } from "./types";

const execFileAsync = promisify(execFile);

// `gh pr view` hits the GitHub API, so give it more room than the local git
// commands. `gh browse` and `gh --version` are local and return instantly.
const GH_TIMEOUT_MS = 6000;

const GH_ENV = { ...process.env, GH_NO_UPDATE_NOTIFIER: "1" } as const;
const OPTS = { timeout: GH_TIMEOUT_MS, windowsHide: true, env: GH_ENV } as const;

/** Runs `gh` with the given args in `directory` and returns trimmed stdout.
 *  Rejects when gh is missing or exits non-zero (e.g. no PR for the branch). */
export type GhRunner = (args: readonly string[]) => Promise<string>;

/** Decide which GitHub URL to surface: the current branch's PR if one exists,
 *  otherwise the branch's tree page, otherwise nothing. Pure aside from the two
 *  injected effects, so the branch/PR/none branches are unit testable. */
export async function resolveGitHubLink(
  runGh: GhRunner,
  getBranch: () => Promise<string | null>,
): Promise<GitHubLink | null> {
  // PR for the current branch — gh infers the branch from the checkout.
  try {
    const url = (
      await runGh(["pr", "view", "--json", "url", "--jq", ".url"])
    ).trim();
    if (url) return { kind: "pr", url };
  } catch {
    // no PR for this branch, not a gh repo, or gh missing — try the branch link
  }

  // Fallback: the branch's page on GitHub. `gh browse` builds the URL locally
  // (no API call) so it stays fast even on large repos.
  const branch = await getBranch();
  if (!branch) return null;
  try {
    const url = (
      await runGh(["browse", "--no-browser", "--branch", branch])
    ).trim();
    if (url) return { kind: "branch", url };
  } catch {
    // gh missing or no GitHub remote configured
  }
  return null;
}

/** Whether the `gh` CLI is on PATH. Surfaced read-only in Settings so the
 *  status-bar toggle can explain itself when gh is missing. */
export async function isGitHubCliAvailable(): Promise<boolean> {
  try {
    await execFileAsync("gh", ["--version"], OPTS);
    return true;
  } catch {
    return false;
  }
}

async function currentBranch(directory: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["--no-optional-locks", "rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: directory, ...OPTS },
    );
    const branch = stdout.trim();
    return branch && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

/** Resolve a GitHub URL for the repo in `directory`: the open PR for the
 *  current branch if one exists, otherwise the branch's tree page. Returns null
 *  when gh isn't installed, the dir isn't a GitHub repo, or no remote resolves. */
export function getGitHubLink(directory: string): Promise<GitHubLink | null> {
  const runGh: GhRunner = async (args) => {
    const { stdout } = await execFileAsync("gh", [...args], {
      cwd: directory,
      ...OPTS,
    });
    return stdout;
  };
  return resolveGitHubLink(runGh, () => currentBranch(directory));
}
