import type { ProjectConfig, TerminalState } from "./types";

export function hydrateProjectTerminalStates(
  prev: Record<string, TerminalState>,
  project: ProjectConfig,
  effectiveCwd: string,
): Record<string, TerminalState> {
  const next = { ...prev };
  for (const tab of project.tabs) {
    next[tab.id] = {
      id: tab.id,
      projectSlug: project.slug,
      presetId: tab.presetId,
      name: tab.name,
      // Restore the tab's worktree cwd if it had one, else the project dir.
      cwd: tab.cwd ?? effectiveCwd,
      status: "running",
      bell: false,
      exitCode: null,
      restored: true,
      ...(tab.sessionId ? { sessionId: tab.sessionId } : {}),
      ...(tab.sharedDir ? { sharedDir: true as const } : {}),
      ...(tab.teamLaunch ? { teamLaunch: true } : {}),
      ...(tab.sshTarget ? { sshTarget: tab.sshTarget } : {}),
    };
  }
  return next;
}

export function hydrateProjectActiveTabs(
  prev: Record<string, string | null>,
  project: ProjectConfig,
): Record<string, string | null> {
  const existing = prev[project.slug];
  const stillValid =
    !!existing && project.tabs.some((t) => t.id === existing);
  return {
    ...prev,
    [project.slug]: stillValid ? existing : (project.tabs[0]?.id ?? null),
  };
}
