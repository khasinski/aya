// How the tab list and the teams window show teams: roles, unread, log lines.

import type { TeamMessage, TeamStartResult, TeamSummary } from "./types";

// The sender electron/team-runner.ts logs Aya's own messages under.
export const AYA_SENDER = "aya";
// How many of the latest logged messages a team card shows.
export const TEAM_LOG_VISIBLE = 8;

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

/** The key a dismissed "assign roles?" prompt is remembered under. */
export function teamPromptKey(slug: string, team: string): string {
  return `${slug}/${team}`;
}

/** How far a logged message got: typed into the pane, or why not yet. */
export function messageDeliveryText(m: Pick<TeamMessage, "from" | "delivered" | "held">): string {
  if (m.delivered) return m.held ? `written later (was held: ${m.held})` : "written";
  return m.from === AYA_SENDER ? `not typed: ${m.held ?? "held"}` : `waiting in inbox: ${m.held ?? "held"}`;
}

/** The line under a team after Start; null when every role got the test. */
export function startSummary(result: TeamStartResult): string | null {
  if (!result.started) return "Not started, nothing was sent: fix the roles marked below, then Start again.";
  return result.held.length ? "Started; the roles marked below did not get the delivery test." : null;
}
