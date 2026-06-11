// Pure merge for hot-reloading project configs edited outside the app (#4).
// Extracted from App.tsx's config-changed handler so the conflict semantics
// can be tested without React (same pattern as pty-event-reducer).
//
// The one UX rule behind every branch here (maintainer decision on #4):
// editing a file must never unexpectedly kill running terminals. Live
// TerminalStates are therefore never removed by a reload - the sidebar renders
// from the terminals map, so a tab deleted on disk keeps its live row until
// the user closes it.

import type { ProjectConfig, TerminalState } from "./types";

/** Disk wins for every project it still contains; a project missing from disk
 *  survives only while it is open (it becomes "unsaved" - the next in-app save
 *  recreates the file). Closed projects missing from disk drop off the list.
 *  Disk order is kept; open survivors append in their current order. */
export function mergeProjectsFromDisk(
  disk: ProjectConfig[],
  current: ProjectConfig[],
  openSlugs: ReadonlySet<string>,
): ProjectConfig[] {
  const diskSlugs = new Set(disk.map((p) => p.slug));
  const survivors = current.filter(
    (p) => !diskSlugs.has(p.slug) && openSlugs.has(p.slug),
  );
  return [...disk, ...survivors];
}

/** TerminalState entries for tabs that exist in an (open) project's config but
 *  not in the terminals map yet - i.e. tabs added by an external edit. They
 *  start as "idle" and WITHOUT a PTY: the process spawns only when the pane
 *  becomes visible / the user activates it (decision 2 on #4). Existing
 *  entries are never touched here - removal/cwd conflicts are resolved by
 *  keeping the live terminal as-is (decisions 1 and 3). */
export function terminalsForNewTabs(
  project: ProjectConfig,
  existing: Readonly<Record<string, TerminalState>>,
): TerminalState[] {
  return project.tabs
    .filter((tab) => !existing[tab.id])
    .map((tab) => ({
      id: tab.id,
      projectSlug: project.slug,
      presetId: tab.presetId,
      name: tab.name,
      cwd: project.directory,
      status: "idle" as const,
      bell: false,
      exitCode: null,
      spawnDeferred: true,
    }));
}

/** One-call application of an external edit to the terminals map: per-tab
 *  non-destructive updates plus entries for newly-added tabs, across all OPEN
 *  projects. Pure and reference-stable (same map back when nothing changed),
 *  so the App handler stays a single line instead of a clone-tracking loop. */
export function applyExternalProjectEdits(
  terminals: Readonly<Record<string, TerminalState>>,
  projects: ProjectConfig[],
  openSlugs: ReadonlySet<string>,
): Record<string, TerminalState> {
  let next = terminals as Record<string, TerminalState>;
  for (const project of projects) {
    if (!openSlugs.has(project.slug)) continue;
    next = withTabUpdatesFromDisk(next, project);
    const added = terminalsForNewTabs(project, next);
    if (added.length === 0) continue;
    if (next === terminals) next = { ...terminals };
    for (const t of added) next[t.id] = t;
  }
  return next;
}

/** Apply non-destructive per-tab updates from disk to live terminals: an
 *  external rename (or preset change) shows up immediately, but status,
 *  exitCode, cwd and the PTY itself stay untouched. Returns the same reference
 *  when nothing changed so React can skip the re-render. */
export function withTabUpdatesFromDisk(
  terminals: Readonly<Record<string, TerminalState>>,
  project: ProjectConfig,
): Record<string, TerminalState> {
  let next: Record<string, TerminalState> | null = null;
  for (const tab of project.tabs) {
    const t = terminals[tab.id];
    if (!t || t.projectSlug !== project.slug) continue;
    if (t.name === tab.name && t.presetId === tab.presetId) continue;
    if (!next) next = { ...terminals };
    next[tab.id] = { ...t, name: tab.name, presetId: tab.presetId };
  }
  return next ?? (terminals as Record<string, TerminalState>);
}
