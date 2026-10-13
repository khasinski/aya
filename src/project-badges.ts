import { projectBadgeLevel, type ProjectBadgeLevel } from "./attention";
import type { MonitoredSession, ProjectConfig, TerminalState } from "./types";

export function calculateProjectBadges(
  terminals: Record<string, TerminalState>,
  monitoredSessions: MonitoredSession[],
  projects: ProjectConfig[],
  findProjectSlugForSession: (
    session: MonitoredSession,
    projects: ProjectConfig[],
  ) => string | null,
): {
  projectBadges: Record<string, { count: number; level: ProjectBadgeLevel }>;
  monitoredSessionsByProject: Record<string, MonitoredSession[]>;
  attentionCount: number;
} {
  const badges: Record<string, { count: number; level: ProjectBadgeLevel }> =
    {};
  const severityRank = { active: 0, done: 1, waiting: 2, error: 3 } as const;
  const addProjectBadge = (
    projectSlug: string,
    level: ProjectBadgeLevel,
  ) => {
    const current = badges[projectSlug];
    badges[projectSlug] = {
      count: (current?.count ?? 0) + 1,
      level:
        !current || severityRank[level] > severityRank[current.level]
          ? level
          : current.level,
    };
  };
  for (const t of Object.values(terminals)) {
    const level = projectBadgeLevel(t);
    if (!level) continue;
    addProjectBadge(t.projectSlug, level);
  }
  const byProject: Record<string, MonitoredSession[]> = {};
  for (const session of monitoredSessions) {
    const projectSlug = findProjectSlugForSession(session, projects);
    if (!projectSlug) continue;
    addProjectBadge(projectSlug, session.level);
    byProject[projectSlug] = [...(byProject[projectSlug] ?? []), session];
  }
  return {
    projectBadges: badges,
    monitoredSessionsByProject: byProject,
    attentionCount: Object.values(badges).reduce(
      (sum, badge) => sum + (badge.level === "active" ? 0 : badge.count),
      0,
    ),
  };
}
