// "Send to several agents": one worktree + branch per chosen agent, all from
// one verified base commit, and the diff of each checkout against that base
// for the Compare view. Each choice succeeds or fails on its own, so one
// refused worktree never blocks the others.

import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import type { IpcMain } from "electron";
import { createWorktree, getGitDiff, listWorktrees } from "./git";
import { requireRecord, requireString, requireStringArray } from "./validation";

const execFileAsync = promisify(execFile);
const OPTS = { timeout: 3000, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } } as const;
export const FAN_OUT_MAX_CHOICES = 6;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface FanOutWorktreeRequest { directory: string; base: string; names: string[] }
export type FanOutWorktreeResult =
  | { name: string; ok: true; path: string; branch: string }
  | { name: string; ok: false; error: string };
export interface FanOutWorktreesResult { base: string | null; results: FanOutWorktreeResult[]; error?: string }

async function resolveCommit(directory: string, ref: string): Promise<string | null> {
  if (!ref || ref.startsWith("-")) return null;
  const out = await execFileAsync("git", ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], { cwd: directory, ...OPTS }).catch(() => null);
  const sha = out?.stdout.trim() ?? "";
  return /^[0-9a-f]{40,64}$/i.test(sha) ? sha : null;
}

/** Create `aya/<name>` at `<repo>.worktrees/<name>` for every name, from the
 *  same base commit. A name already taken by a branch or a checkout gets the
 *  next free `-2`, `-3` suffix; a failure is reported for that name only. */
export async function createFanOutWorktrees(request: FanOutWorktreeRequest): Promise<FanOutWorktreesResult> {
  const { directory, names } = request;
  if (!names.length || names.length > FAN_OUT_MAX_CHOICES) return { base: null, results: [], error: `Choose between 1 and ${FAN_OUT_MAX_CHOICES} agents.` };
  const bad = names.find(name => !NAME.test(name));
  if (bad !== undefined) return { base: null, results: [], error: `"${bad}" is not a valid worktree name.` };
  const base = await resolveCommit(directory, request.base.trim());
  if (!base) return { base: null, results: [], error: "That starting ref was not found." };
  const resolved = path.resolve(directory);
  const root = path.join(path.dirname(resolved), `${path.basename(resolved)}.worktrees`);
  try { await mkdir(root, { recursive: true }); }
  catch (err) { return { base, results: [], error: err instanceof Error ? err.message : String(err) }; }
  const branches = await execFileAsync("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"], { cwd: directory, ...OPTS })
    .then(({ stdout }) => stdout).catch(() => "");
  const usedBranches = new Set(branches.split(/\r?\n/).filter(Boolean));
  const usedPaths = new Set((await listWorktrees(directory)).map(w => path.resolve(w.path)));
  const results: FanOutWorktreeResult[] = [];
  // Sequential: concurrent `git worktree add` in one repo races on its locks.
  for (const name of names) {
    let suffix = name;
    for (let n = 2; usedBranches.has(`aya/${suffix}`) || usedPaths.has(path.join(root, suffix)); n++) suffix = `${name}-${n}`;
    const branch = `aya/${suffix}`, checkout = path.join(root, suffix);
    usedBranches.add(branch); usedPaths.add(checkout);
    const created = await createWorktree(directory, checkout, branch, base);
    results.push(created.ok ? { name, ok: true, path: checkout, branch } : { name, ok: false, error: created.error });
  }
  return { base, results };
}

/** What a fan-out checkout changed since the base commit: committed and
 *  uncommitted edits plus untracked files, as one unified diff. */
export async function fanOutDiff(checkout: string, base: string): Promise<string> {
  if (!/^[0-9a-f]{40,64}$/i.test(base)) throw new Error("Compare needs the base commit.");
  return getGitDiff(checkout, base);
}

export function registerFanOutIpc(ipcMain: IpcMain): void {
  ipcMain.handle("fan-out:create-worktrees", async (_event, raw: unknown) => {
    const r = requireRecord(raw, "fan-out:create-worktrees");
    return createFanOutWorktrees({
      directory: requireString(r.directory, "fan-out:create-worktrees.directory"),
      base: requireString(r.base, "fan-out:create-worktrees.base"),
      names: requireStringArray(r.names, "fan-out:create-worktrees.names"),
    });
  });
  ipcMain.handle("fan-out:diff", async (_event, raw: unknown) => {
    const r = requireRecord(raw, "fan-out:diff");
    return fanOutDiff(requireString(r.checkout, "fan-out:diff.checkout"), requireString(r.base, "fan-out:diff.base"));
  });
}
