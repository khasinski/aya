// Pure helpers for the per-terminal worktree binding. A terminal can run in a
// git worktree (a cwd other than the project's own directory); this file is the
// single source for turning that binding into a persisted WorkingTab and back,
// so no persist path (launch / rename / reorder / close) can silently drop it.

import type { ProjectConfig, TerminalState, WorkingTab } from "./types";

/** The project's canonical base directory — the cwd a plain (non-worktree) tab
 *  runs in. Remote projects live at their remote directory. */
export function projectBaseCwd(project: ProjectConfig): string {
  return project.remote ? project.remote.directory : project.directory;
}

/** Map a live terminal back to its persisted WorkingTab. Keeps the worktree cwd
 *  binding only when it differs from the project's own directory, so an ordinary
 *  main-dir tab stays cwd-free (and keeps following the project if its directory
 *  ever moves). The agent session id rides along so a restore can resume that
 *  exact conversation. */
export function tabFromTerminal(t: TerminalState, baseCwd: string): WorkingTab {
  return {
    id: t.id,
    presetId: t.presetId,
    name: t.name,
    ...(t.cwd && t.cwd !== baseCwd ? { cwd: t.cwd } : {}),
    ...(t.sessionId ? { sessionId: t.sessionId } : {}),
  };
}
