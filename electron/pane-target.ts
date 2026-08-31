// Resolving "which pane did the caller mean" for the pane-read / pane-send
// control requests. An agent asking to read or drive another pane knows a
// human-facing name ("reviewer"), not the internal terminal id, so this maps
// one to the other against the on-disk project configs.
//
// Pure and separated from the socket handler so the ambiguity rules — which
// are the safety-critical part, since a wrong match means typing into the
// wrong terminal — can be tested directly.

import type { ProjectConfig } from "./types";

export interface PaneQuery {
  /** Exact terminal id. Wins outright when present. */
  terminalId?: string;
  /** Human-facing terminal name, matched case-insensitively. */
  name?: string;
  /** Restricts a name lookup to one project. The `aya` CLI fills this from
   *  AYA_PROJECT_SLUG, so an agent's "reviewer" means the reviewer in ITS
   *  project, not a same-named pane in an unrelated one. */
  projectSlug?: string;
}

export interface PaneMatch {
  terminalId: string;
  projectSlug: string;
  name: string;
}

export type PaneResolution =
  | { ok: true; match: PaneMatch }
  | { ok: false; error: string };

function candidates(projects: ProjectConfig[], query: PaneQuery): PaneMatch[] {
  const out: PaneMatch[] = [];
  for (const project of projects) {
    if (query.projectSlug && project.slug !== query.projectSlug) continue;
    for (const tab of project.tabs) {
      out.push({ terminalId: tab.id, projectSlug: project.slug, name: tab.name });
    }
  }
  return out;
}

/** Resolve a pane query to exactly one terminal, or explain why it can't.
 *  An ambiguous name is an error, never a guess: silently picking one of two
 *  panes called "build" would send an agent's input somewhere the user never
 *  intended. */
export function resolvePaneTarget(
  projects: ProjectConfig[],
  query: PaneQuery,
): PaneResolution {
  const all = candidates(projects, query);

  if (query.terminalId) {
    const exact = all.find((c) => c.terminalId === query.terminalId);
    return exact
      ? { ok: true, match: exact }
      : { ok: false, error: `no pane with id ${query.terminalId}` };
  }

  const wanted = query.name?.trim().toLowerCase();
  if (!wanted) return { ok: false, error: "pane name or id is required" };

  const matches = all.filter((c) => c.name.trim().toLowerCase() === wanted);
  if (matches.length === 0) {
    return { ok: false, error: `no pane named "${query.name}"` };
  }
  if (matches.length > 1) {
    const where = matches.map((m) => `${m.projectSlug}/${m.name}`).join(", ");
    return {
      ok: false,
      error: `"${query.name}" is ambiguous (${where}); pass --project or an id`,
    };
  }
  return { ok: true, match: matches[0] };
}

export interface PaneListEntry {
  terminalId: string;
  projectSlug: string;
  projectName: string;
  name: string;
  /** The preset the pane runs (claude / codex / shell / ...) - the closest
   *  thing to "which agent" the host knows without loading the preset list. */
  presetId: string;
  /** This is the caller's OWN pane. */
  isSelf: boolean;
}

/** Every pane the caller can see, scoped to one project when a slug is given
 *  (the same scoping pane-read/send use, so "my project" means the caller's),
 *  else across all projects. `selfTerminalId` marks the caller's own pane so an
 *  agent can tell itself apart from the ones it might read or drive. */
export function listPanes(
  projects: ProjectConfig[],
  opts: { projectSlug?: string; selfTerminalId?: string } = {},
): PaneListEntry[] {
  const out: PaneListEntry[] = [];
  for (const project of projects) {
    if (opts.projectSlug && project.slug !== opts.projectSlug) continue;
    for (const tab of project.tabs) {
      out.push({
        terminalId: tab.id,
        projectSlug: project.slug,
        projectName: project.name,
        name: tab.name,
        presetId: tab.presetId,
        isSelf: !!opts.selfTerminalId && tab.id === opts.selfTerminalId,
      });
    }
  }
  return out;
}

/** Render a pane listing as an aligned table for `aya pane list`. The caller's
 *  own pane is marked with `*` and "(this pane)". A project header is shown
 *  only when the listing spans more than one project. */
export function formatPaneList(entries: PaneListEntry[]): string {
  if (entries.length === 0) return "No panes found.\n";
  const multiProject = new Set(entries.map((e) => e.projectSlug)).size > 1;
  const nameW = Math.max(4, ...entries.map((e) => e.name.length));
  const presetW = Math.max(5, ...entries.map((e) => e.presetId.length));
  const lines: string[] = [];
  let lastProject: string | null = null;
  for (const e of entries) {
    if (multiProject && e.projectSlug !== lastProject) {
      lines.push(`${e.projectName} (${e.projectSlug}):`);
      lastProject = e.projectSlug;
    }
    const mark = e.isSelf ? "*" : " ";
    const suffix = e.isSelf ? "  (this pane)" : "";
    lines.push(
      `${mark} ${e.name.padEnd(nameW)}  ${e.presetId.padEnd(presetW)}  ${e.terminalId}${suffix}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

// A read returns terminal scrollback to another process, which for an agent
// pane can be a long transcript. Cap it so one request can't dump megabytes
// through the socket; callers wanting more should read repeatedly.
export const PANE_READ_MAX_CHARS = 64_000;

/** Trim a pane buffer to the most recent slice — the tail is what a caller
 *  asking "what is this agent doing now" actually wants. */
export function tailForPaneRead(
  buffer: string,
  maxChars: number = PANE_READ_MAX_CHARS,
): string {
  return buffer.length <= maxChars ? buffer : buffer.slice(-maxChars);
}
