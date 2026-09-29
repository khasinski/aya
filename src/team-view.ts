// How the tab list and the teams window show teams: roles, unread, log lines.

import type { RolePanes, TeamMessage, TeamStartResult, TeamSummary } from "./types";

// The sender electron/team-runner.ts logs Aya's own messages under.
export const AYA_SENDER = "aya";
// The sender of a task given with Start; electron/teams.ts TEAM_USER_SENDER.
export const USER_SENDER = "user";

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
  return teams.filter((t) => t.definition && !t.agentAuthored && Object.keys(t.assignments).length === 0);
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
  const task = result.task;
  if (!result.held.length) return task ? `Started; task sent to ${task.to}.` : null;
  const given = task ? (task.held ? ` The task for ${task.to} waits in its inbox: ${task.held}.` : ` Task sent to ${task.to}.`) : "";
  return `Started; the roles marked below did not get the delivery test.${given}`;
}

// The terminal host's hold for a pane with no process (electron/pane-holds.ts).
export const HOLD_NOT_RUNNING = "is not running (exited, or its tab was not opened yet)";

/** What the role's row says about its pane. */
export function roleStatus(
  team: Pick<TeamSummary, "assignments" | "paneHolds">,
  role: string,
  tabs: { id: string }[],
): { text: string; tone: "ok" | "held" | "none" } {
  const pane = team.assignments[role];
  if (!pane || !tabs.some((t) => t.id === pane)) return { text: "no pane", tone: "none" };
  const hold = team.paneHolds[role] ?? null;
  if (hold === null) return { text: "ready", tone: "ok" };
  return { text: hold === HOLD_NOT_RUNNING ? "not running" : hold, tone: "held" };
}

/** Select values are aya team open targets: a new session of a preset, or a pane. */
export const NEW_PANE_PREFIX = "new:";
export const PANE_PREFIX = "pane:";

/** A pane in a role's select: its name, and the role it plays if not this one. */
export function paneOptionLabel(name: string, plays: PaneRole | undefined, team: string, role: string): string {
  if (!plays || (plays.team === team && plays.role === role)) return name;
  // Not "name - role": new team panes are named "<preset> - <role>" and keep that name.
  return `${name} (plays ${plays.team === team ? plays.role : `${plays.team} › ${plays.role}`})`;
}

/** What Apply will move: a pane another role plays leaves that role without one. */
export function pendingMoves(
  team: string,
  changes: Record<string, string>,
  plays: Record<string, PaneRole>,
  tabName: (paneId: string) => string,
): string[] {
  return Object.entries(changes).flatMap(([role, value]) => {
    const from = plays[value];
    if (!from || (from.team === team && (from.role === role || from.role in changes))) return [];
    const who = from.team === team ? from.role : `${from.team} › ${from.role}`;
    return [`${tabName(value)} moves from ${who} to ${role}; ${who} is left without a pane.`];
  });
}

/** After Apply: which pane each role got, and that Start is the user's. */
export function rolePanesSummary({ panes, leftWithoutPane }: RolePanes, running: boolean): string {
  const given = `${panes.map((p) => `${p.role}: ${p.preset ? `new ${p.preset} pane` : p.name}`).join(", ")}.`;
  const left = leftWithoutPane.length ? ` Left without a pane: ${leftWithoutPane.join(", ")}.` : "";
  if (!running) return `${given}${left} Start the team when you are ready.`;
  return `${given}${left}${panes.some((p) => p.notReached) ? " The roles marked below were not told their role." : ""}`;
}
