// How the tab list shows teams: each pane's role and its unread count.

import type { TeamSummary } from "./types";

export interface PaneRole {
  team: string;
  role: string;
  unread: number;
}

export function paneRoles(teams: TeamSummary[]): Record<string, PaneRole> {
  const out: Record<string, PaneRole> = {};
  for (const team of teams) {
    for (const [role, pane] of Object.entries(team.assignments)) {
      out[pane] = { team: team.name, role, unread: team.unread[role] ?? 0 };
    }
  }
  return out;
}

export function unreadTotal(teams: TeamSummary[]): number {
  return teams.reduce((sum, t) => sum + Object.values(t.unread).reduce((a, b) => a + b, 0), 0);
}

/** Teams whose roles all lack a pane: the project-open prompt offers these. */
export function unassignedTeams(teams: TeamSummary[]): TeamSummary[] {
  return teams.filter((t) => t.definition && Object.keys(t.assignments).length === 0);
}
