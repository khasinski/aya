// Reads the config files launch-mode.ts decides from, from the repository root down to the pane's cwd.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { codexSupportsNoDaemon, noDaemonCommand } from "./codex-daemon";
import { pathExists } from "./path-exists";
import { claudeSettingsFile, codexTrusts, launchFiles, launchMode, teamLaunch, withLaunchArgs, type LaunchConfig, type LaunchMode, type PaneLaunch } from "./launch-mode";
import { cdLead, envWithAssignments } from "./shell-words";
import type { LaunchReach } from "./types";

/** `cwd` and its parents up to the repository root, root first; only `cwd` outside a repository. */
async function repoDirs(cwd: string): Promise<string[]> {
  const dirs: string[] = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    dirs.unshift(dir);
    if (await pathExists(path.join(dir, ".git"))) return dirs;
    if (path.dirname(dir) === dir) return [path.resolve(cwd)];
  }
}

/** The main repository's root when `root` is a linked git worktree (its `.git` is a file), else null. */
async function mainRepoRoot(root: string): Promise<string | null> {
  try {
    const gitdir = /^gitdir:\s*(.+)$/m.exec(await fs.readFile(path.join(root, ".git"), "utf-8"))?.[1].trim();
    if (!gitdir) return null;
    const dir = path.resolve(root, gitdir);
    const common = (await fs.readFile(path.join(dir, "commondir"), "utf-8")).trim();
    return path.dirname(path.resolve(dir, common));
  } catch {
    return null;
  }
}

async function texts(files: string[]): Promise<string[]> {
  const read = await Promise.all(files.map((file) => fs.readFile(file, "utf-8").catch(() => null)));
  return read.filter((text): text is string => text !== null);
}

/** Before the socket exists, its directory's real path. */
async function realSocket(socket: string): Promise<string> {
  const dir = await fs.realpath(path.dirname(socket)).catch(() => path.dirname(socket));
  return path.join(dir, path.basename(socket));
}

export async function readLaunchConfig(command: string, cwd: string, env: Record<string, string | undefined>, socket: string): Promise<LaunchConfig> {
  const lead = cdLead(command);
  if (lead) {
    const home = env.HOME ?? "";
    const dir = path.resolve(cwd, lead.dir === "~" ? home : lead.dir.replace(/^~\//, `${home}/`));
    return readLaunchConfig(command.slice(lead.at), dir, env, socket);
  }
  const dirs = await repoDirs(cwd);
  const files = launchFiles(command, env, dirs);
  // The last dirs.length codex files are the project's; config.toml comes first, the -p profile's file second.
  const own = files.codex.length ? files.codex.length - dirs.length : 0;
  const [codex, [codexProfile = null], codexProject, opencode, claude] = await Promise.all([
    texts(files.codex.slice(0, 1)),
    texts(files.codex.slice(1, own)),
    texts(files.codex.slice(own)),
    texts(files.opencode),
    texts(files.claude),
  ]);
  const cli = claudeSettingsFile(command, env, dirs);
  const claudeSettingsUnread = cli !== null && ("unresolved" in cli || (await texts([cli.file])).length === 0);
  const main = await mainRepoRoot(dirs[0]);
  const candidates = [dirs[0], dirs.at(-1), main].filter((dir): dir is string => dir !== undefined && dir !== null);
  const real = await Promise.all(candidates.map((dir) => fs.realpath(dir).catch(() => dir)));
  return {
    codex,
    codexProfile,
    codexProject,
    codexTrusted: codexTrusts(codex, [...candidates, ...real]),
    opencode,
    opencodeContent: env.OPENCODE_CONFIG_CONTENT ?? null,
    claude,
    claudeSettingsUnread,
    socket: await realSocket(socket),
  };
}

export async function paneLaunchMode(command: string, cwd: string, env: Record<string, string | undefined>, socket: string): Promise<LaunchMode> {
  return launchMode(command, await readLaunchConfig(command, cwd, env, socket));
}

export async function paneLaunchRecord(
  command: string,
  cwd: string,
  added: string[],
  env: Record<string, string | undefined>,
  socket: string,
): Promise<PaneLaunch> {
  return { command, cwd, added, mode: await paneLaunchMode(command, cwd, env, socket) };
}

/** A pane opened for a role from `command`, as the terminal host would launch it. */
export async function roleLaunchCheck(
  command: string,
  cwd: string,
  env: Record<string, string | undefined>,
  socket: string,
  shell: string,
): Promise<{ reach: LaunchReach; refused: string | null }> {
  const launched = await noDaemonCommand(command, (codex, assignments) =>
    codexSupportsNoDaemon(shell, cwd, envWithAssignments(env, assignments), codex),
  );
  const config = await readLaunchConfig(launched, cwd, env, socket);
  const launch = teamLaunch(launched, config);
  if ("refused" in launch) return { reach: "blocked", refused: launch.refused };
  return { reach: launchMode(withLaunchArgs(launched, launch.args), config).reach, refused: null };
}
