// Triage rules for "which terminals want the user's attention". Shared by the
// always-visible status rail and the attention-center modal so the two can
// never disagree about what counts as waiting / failed / finished — a split
// that would show a badge in one place and nothing in the other.

import { isTerminalDone } from "./pty-event-reducer";
import type { ProjectConfig, TerminalState } from "./types";

export type AttentionLevel = "error" | "waiting" | "done" | "idle";

export interface AttentionRow {
  project: ProjectConfig;
  terminal: TerminalState;
  level: AttentionLevel;
  title: string;
  detail: string;
}

/** Most-urgent-first, then stable by project name so the list doesn't reshuffle
 *  under the cursor when unrelated terminals change. */
const LEVEL_RANK: Record<AttentionLevel, number> = {
  error: 4,
  waiting: 3,
  done: 2,
  idle: 1,
};

export function attentionFor(
  project: ProjectConfig,
  terminal: TerminalState,
): AttentionRow | null {
  if (
    terminal.status === "error" ||
    terminal.externalStatus?.level === "error" ||
    terminal.spawnFailure
  ) {
    return {
      project,
      terminal,
      level: "error",
      title: `${terminal.name} needs recovery`,
      detail:
        terminal.externalStatus?.text ??
        terminal.spawnFailure?.detail ??
        (terminal.exitCode !== null
          ? `Exited with code ${terminal.exitCode}`
          : "Terminal is in an error state"),
    };
  }
  if (
    terminal.bell ||
    terminal.status === "waiting" ||
    terminal.externalStatus?.level === "waiting"
  ) {
    return {
      project,
      terminal,
      level: "waiting",
      title: `${terminal.name} is waiting`,
      detail: terminal.externalStatus?.text ?? "Approval or input needed",
    };
  }
  if (isTerminalDone(terminal)) {
    return {
      project,
      terminal,
      level: "done",
      title: `${terminal.name} finished`,
      detail: terminal.externalStatus?.text ?? "Completed successfully",
    };
  }
  if (
    terminal.status === "idle" ||
    terminal.stopped ||
    (terminal.exitCode !== null && terminal.exitCode !== 0)
  ) {
    return {
      project,
      terminal,
      level: "idle",
      title: `${terminal.name} is idle`,
      detail: terminal.stopped
        ? "Stopped - press Shift+Enter to restart"
        : terminal.exitCode !== null
          ? `Exited with code ${terminal.exitCode}`
          : "No active process",
    };
  }
  return null;
}

/** Every terminal wanting attention, across every project passed in, ranked. */
export function attentionRows(
  projects: ProjectConfig[],
  terminals: Record<string, TerminalState>,
): AttentionRow[] {
  const projectBySlug = new Map(projects.map((p) => [p.slug, p]));
  return Object.values(terminals)
    .map((terminal) => {
      const project = projectBySlug.get(terminal.projectSlug);
      return project ? attentionFor(project, terminal) : null;
    })
    .filter((row): row is AttentionRow => !!row)
    .sort(
      (a, b) =>
        LEVEL_RANK[b.level] - LEVEL_RANK[a.level] ||
        a.project.name.localeCompare(b.project.name),
    );
}

/** The subset worth interrupting someone for. "idle" and "done" are states you
 *  discover when you look; only these two mean something is actually stuck. */
export function isActionableLevel(level: AttentionLevel): boolean {
  return level === "error" || level === "waiting";
}
