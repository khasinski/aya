import { resumeSpawn } from "./agentPreset";
import type { ProjectBadgeLevel } from "./attention";
import { PRESET_ID_SHELL } from "./preset-ids";
import { sameArrayItems, sameRecordValues } from "./stable-identity";
import {
  presetSlug,
  slugifyName,
  type MonitoredSession,
  type Preset,
  type ProjectConfig,
  type ProjectGitInfo,
  type SpawnCommand,
  type TerminalState,
} from "./types";

// Content comparators for useStable: badge/session records are rebuilt with
// fresh value objects on every terminals-map change, so identity alone can't
// tell "same badges" from "changed badges".
export function sameProjectBadges(
  a: Record<string, { count: number; level: ProjectBadgeLevel }>,
  b: Record<string, { count: number; level: ProjectBadgeLevel }>,
): boolean {
  return sameRecordValues(
    a,
    b,
    (x, y) => x.count === y.count && x.level === y.level,
  );
}

export function sameSessionRecords(
  a: Record<string, MonitoredSession[]>,
  b: Record<string, MonitoredSession[]>,
): boolean {
  return sameRecordValues(a, b, sameArrayItems);
}

export function dedupeSlugs(slugs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const slug of slugs) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

/** Drop null/undefined values so the persisted selection map only has live ids. */
export function compactRecord(
  record: Record<string, string | null>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value) out[key] = value;
  }
  return out;
}

export interface GitInfo {
  branch: string | null;
  dirty: number;
}

export interface NewProjectModalState {
  defaults?: { directory?: string };
  lockDirectory?: boolean;
  title?: string;
  hint?: string;
  pathHint?: string;
}

export interface MissingDirEntry {
  slug: string;
  name: string;
  directory: string;
}

export interface PendingRepoImport {
  project: ProjectConfig;
  presets: Preset[];
}

export function findProject(
  projects: ProjectConfig[],
  slug: string,
): ProjectConfig | null {
  return projects.find((p) => p.slug === slug) ?? null;
}

export function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || "project";
}

/** Keep the previous poll-state reference when the fresh result is
 *  value-identical. The polls (git 3s, sessions 5s, usage 30s) hand back fresh
 *  objects every tick; without this every tick re-renders App AND breaks
 *  React.memo on the chrome components by changing prop identities. Poll
 *  payloads are small, so a JSON compare is cheap. */
export function samePollPayload<T>(prev: T, next: T): boolean {
  return JSON.stringify(prev) === JSON.stringify(next);
}

/** setGit updater that no-ops (same reference back) when that directory's git
 *  info is unchanged — the common case for the 3s status-bar poll. Keyed by
 *  directory, not project slug: a worktree tab reads its OWN checkout, so one
 *  project can hold several entries and switching tabs must not show the
 *  previous checkout's branch until the next poll lands. */
export function mergeGitInfo(
  g: Record<string, ProjectGitInfo>,
  directory: string,
  info: ProjectGitInfo,
): Record<string, ProjectGitInfo> {
  const cur = g[directory];
  return cur && cur.branch === info.branch && cur.dirty === info.dirty
    ? g
    : { ...g, [directory]: info };
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function remoteTerminalCommand(project: ProjectConfig, preset: Preset): string {
  if (!project.remote) return preset.command;
  const remoteShell = '"${SHELL:-/bin/sh}"';
  const remoteCommand =
    preset.id === PRESET_ID_SHELL || preset.command.trim() === "$SHELL"
      ? `cd ${shellQuote(project.remote.directory)} && exec ${remoteShell} -l`
      : `cd ${shellQuote(project.remote.directory)} && exec ${remoteShell} -l -i -c ${shellQuote(`exec ${preset.command}`)}`;
  return `ssh -tt ${shellQuote(project.remote.sshTarget)} ${shellQuote(remoteCommand)}`;
}

/** Where a terminal's agent keeps its sessions: its cwd, or the remote directory. */
export function sessionDir(project: ProjectConfig | null, terminal: TerminalState): string {
  return project?.remote
    ? `${project.remote.sshTarget}:${project.remote.directory}`
    : terminal.cwd;
}

export function terminalSpawn(
  project: ProjectConfig | null,
  preset: Preset,
  terminal: TerminalState,
  panes: Array<{ id: string; preset: Preset; cwd: string }>,
  homeDir: string,
): SpawnCommand {
  // A tab opened on a machine runs ssh here, never wrapped for a remote project and never resumed.
  if (terminal.sshTarget) return { command: `ssh -- ${shellQuote(terminal.sshTarget)}` };
  const key = sessionDir(project, terminal);
  const spawn = resumeSpawn(
    preset,
    { id: terminal.id, cwd: key, restored: terminal.restored, sessionId: terminal.sessionId, sharedDir: terminal.sharedDir },
    panes,
  );
  const wrap = (command: string) => (project ? remoteTerminalCommand(project, { ...preset, command }) : command);
  // A remote pane runs in the home dir here; its peers share the folder when their key is the same.
  const peerCwds = project?.remote
    ? spawn.peerCwds?.includes(key) ? [homeDir] : undefined
    : spawn.peerCwds;
  return {
    command: wrap(spawn.command),
    ...(spawn.sharedDirCommand && peerCwds
      ? { sharedDirCommand: wrap(spawn.sharedDirCommand), peerCwds }
      : {}),
  };
}

export function uniqueProjectName(projects: ProjectConfig[], directory: string): string {
  const base = basename(directory);
  const used = new Set(projects.map((p) => p.slug));
  const root = base || "project";
  let name = root;
  let idx = 2;
  // Main's "project" fallback, so this predicts the slug createProject assigns.
  while (used.has(slugifyName(name, "project"))) {
    name = `${root} ${idx}`;
    idx += 1;
  }
  return name;
}

export function uniquePresetId(existing: Preset[], project: ProjectConfig, preset: Preset): string {
  const used = new Set(existing.map((p) => p.id));
  const root = presetSlug(`${project.slug}-${preset.id || preset.name}`);
  let candidate = root;
  let idx = 2;
  while (used.has(candidate)) {
    candidate = `${root}-${idx}`;
    idx += 1;
  }
  return candidate;
}

/** Default display name for a freshly-created tab. Uses the preset's name
 *  so renaming a preset in Settings shows up on the next launch. */
export function defaultTabName(preset: Preset): string {
  return preset.name.trim() || preset.id || "terminal";
}

export function normalizeLocalPath(value: string): string {
  if (value.length > 1) return value.replace(/\/+$/, "");
  return value;
}

export function pathContainsProject(pathname: string, projectDirectory: string): boolean {
  const cwd = normalizeLocalPath(pathname);
  const directory = normalizeLocalPath(projectDirectory);
  return cwd === directory || cwd.startsWith(directory + "/");
}

export function findProjectSlugForSession(
  session: MonitoredSession,
  projects: ProjectConfig[],
): string | null {
  let best: ProjectConfig | null = null;
  for (const project of projects) {
    if (project.remote) continue;
    if (!pathContainsProject(session.cwd, project.directory)) continue;
    if (!best || project.directory.length > best.directory.length) {
      best = project;
    }
  }
  return best?.slug ?? null;
}
