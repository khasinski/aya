// How the tab list and the teams window show teams: roles, unread, log lines.

import type { RolePanes, TeamDefinition, TeamLiveness, TeamMessage, TeamStartResult, TeamSummary, WaitingPanes } from "./types";

// The sender electron/team-runner.ts logs Aya's own messages under.
export const AYA_SENDER = "aya";
// The sender of a task given with Start; electron/team-definition.ts TEAM_USER_SENDER.
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
export function messageDeliveryText(m: Pick<TeamMessage, "from" | "delivered" | "held" | "typedOnly" | "afterEnter" | "viaInbox">): string {
  if (m.typedOnly) return m.afterEnter && m.held ? m.held : `typed, Enter withheld: ${m.held}`;
  if (m.delivered && m.viaInbox) return "read via inbox";
  if (m.delivered) return m.held ? `written later (was held: ${m.held})` : "written";
  return m.from === AYA_SENDER ? `not typed: ${m.held ?? "held"}` : `waiting in inbox: ${m.held ?? "held"}`;
}

/** Where a Start task that did not go in is: in the composer or waiting in the inbox. */
function taskHeld(task: { to: string; held: string | null; typedOnly?: boolean; afterEnter?: boolean }): string {
  if (task.typedOnly && task.afterEnter) return `task for ${task.to} was ${task.held}`;
  return task.typedOnly ? `task for ${task.to} is typed in its composer, Enter withheld: ${task.held}` : `task for ${task.to} waits in its inbox: ${task.held}`;
}

/** The line under a team after Start; null when every role got the test. A held task is
 *  named only while `log` still has it waiting or typed: once written, the line is stale. */
export function startSummary(result: TeamStartResult, log?: TeamMessage[]): string | null {
  if (result.alreadyRunning) return "Already running, nothing was sent.";
  if (!result.started) return "Not started, nothing was sent: fix the roles marked below, then Start again.";
  const task = result.task && taskStillHeld(result.task, log) ? result.task : null;
  if (!result.held.length) return task ? (task.held ? `Started; ${taskHeld(task)}.` : `Started; task sent to ${task.to}.`) : null;
  const given = task ? (task.held ? ` The ${taskHeld(task)}.` : ` Task sent to ${task.to}.`) : "";
  return `Started; the roles marked below did not get the delivery test.${given}`;
}

function taskStillHeld(task: NonNullable<TeamStartResult["task"]>, log: TeamMessage[] | undefined): boolean {
  if (!task.held || task.messageId === undefined || !log) return true;
  const entry = log.find((m) => m.id === task.messageId);
  return entry !== undefined && (!entry.delivered || entry.typedOnly === true);
}

// The terminal host's hold for a pane with no process (electron/pane-holds.ts).
export const HOLD_NOT_RUNNING = "is not running (exited, or its tab was not opened yet)";
// electron/pane-holds.ts HOLD_USAGE_LIMIT: a blocked role whose CLI ran out says so, not "waiting for you".
export const HOLD_USAGE_LIMIT = "is out of credits or at its usage limit";
// electron/pane-holds.ts NO_PANE_HOLD: a role whose pane was closed.
export const NO_PANE_HOLD = "no pane assigned";

/** Local HH:MM of an ISO time: every team time in the window (electron/team-times.ts clock in main). */
export function clock(iso: string): string {
  const time = new Date(iso);
  return `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
}

const messages = (n: number) => `${n} message${n === 1 ? "" : "s"}`;

/** The team's line above its roles; null while there is nothing to say. Progress is a change to the repo
 *  (a commit or an edit); messages are talk. */
export function livenessLine({ status, stalledSince, blocked, unreached, silence, repo, roundsHeld }: TeamLiveness): { text: string; tone: "ok" | "held" } | null {
  if (status === "never started" || status === "paused") return null;
  const waits = roundsHeld ? `rounds wait for ${roundsHeld.role} to answer (${roundsHeld.rounds} unanswered)` : null;
  if (status === "progressing") {
    if (!silence) return { text: waits ? `progressing - ${waits}` : "progressing", tone: "ok" };
    const asks =
      waits ??
      (silence.everyMin
        ? `the lead gets a round every ${silence.everyMin} min`
        : silence.askAfterMin === null
          ? "no lead to ask"
          : `the lead is asked for a round after ${silence.askAfterMin} min without a message or a change to the repo`);
    return { text: `progressing - ${asks}; flagged after ${silence.stalledAfterMin} min without a change to the repo`, tone: "ok" };
  }
  if (status === "talking" && repo) {
    const limit = silence ? `; flagged after ${silence.stalledAfterMin} min without one` : "";
    return { text: `talking - no change to the repo since ${clock(repo.since)} (${messages(repo.messages)})${waits ? `; ${waits}` : ""}${limit}`, tone: "ok" };
  }
  if (status === "unreachable" && unreached) {
    const why = unreached.reason === NO_PANE_HOLD ? "it has no pane" : `its pane ${unreached.reason}`;
    return { text: `no round typed to ${unreached.role} since ${clock(unreached.since)}: ${why}`, tone: "held" };
  }
  if (status === "stalled") {
    const what = repo ? ` (${messages(repo.messages)})` : "";
    return { text: `stalled: no change to the repo since ${clock(repo?.since ?? stalledSince ?? "")}${what} - rounds are paused until the repo changes`, tone: "held" };
  }
  const since = stalledSince ? `stalled since ${clock(stalledSince)}` : "";
  const who = blocked.map((b) => `${b.role} ${b.reason === HOLD_USAGE_LIMIT ? b.reason : "is waiting for you in its CLI"}`).join("; ");
  return { text: since ? `${since} - ${who}` : who, tone: "held" };
}

/** The Task field's placeholder: who Start gives the task to, as electron/team-runner.ts taskRecipient picks it. */
export function taskPlaceholder(definition: Pick<TeamDefinition, "roles" | "lead"> | null, to?: string): string {
  if (!definition || definition.roles.length === 0) return "Task (optional)";
  if (to && definition.roles.some((r) => r.id === to)) return `Task for ${to}`;
  if (definition.lead) return `Task for ${definition.lead} (the lead)`;
  return `Task for ${definition.roles[0].id} (the first role)`;
}

/** The card's warning for a saved team that names no lead, or two roles for lead and rhythm, else null. */
export function leadWarning(definition: Pick<TeamDefinition, "lead" | "leadConflict"> | null): string | null {
  if (!definition) return null;
  if (definition.leadConflict) return `cadence and lead name different roles: rounds go to ${definition.lead}; save the team again with one of them`;
  return definition.lead === null ? "no lead role: set one" : null;
}

const askedAt = (asked: WaitingPanes[string]) => clock(new Date(asked.since).toISOString());

/** The team line when the lead asks the user for something (`aya status waiting`); null otherwise. */
export function leadWaitingLine(
  team: Pick<TeamSummary, "assignments" | "running"> & { definition: Pick<TeamDefinition, "lead"> | null },
  waiting: WaitingPanes,
): { text: string; tone: "held" } | null {
  const lead = team.definition?.lead;
  const asked = lead && team.running ? waiting[team.assignments[lead]] : undefined;
  if (!asked) return null;
  if (asked.restart === "unconfirmed") return { text: `${lead} asked you before the restart (${askedAt(asked)}), not confirmed since; rounds go on: ${asked.text}`, tone: "held" };
  const before = asked.restart === "restored" ? " (asked before the restart)" : "";
  return { text: `${lead} is waiting for you since ${askedAt(asked)}${before}: ${asked.text}`, tone: "held" };
}

/** The role's pane while it is one of the project's tabs; a closed pane is none. */
export function livePane(team: Pick<TeamSummary, "assignments">, role: string, tabs: { id: string }[]): string | null {
  const pane = team.assignments[role];
  return pane && tabs.some((t) => t.id === pane) ? pane : null;
}

/** What the role's row says about its pane. */
export function roleStatus(
  team: Pick<TeamSummary, "assignments" | "paneHolds"> & Partial<Pick<TeamSummary, "liveness">>,
  role: string,
  tabs: { id: string }[],
  waiting: WaitingPanes = {},
): { text: string; tone: "ok" | "held" | "none" } {
  const pane = livePane(team, role, tabs);
  if (!pane) return { text: "no pane", tone: "none" };
  const blocked = team.liveness?.blocked.find((b) => b.role === role);
  if (blocked) return { text: `${blocked.reason === HOLD_USAGE_LIMIT ? blocked.reason : "waiting for you"} since ${clock(blocked.since)}`, tone: "held" };
  const asked = waiting[pane];
  if (asked) return { text: asked.restart === "unconfirmed" ? `asked before the restart (${askedAt(asked)}), not confirmed` : `waiting for you since ${askedAt(asked)}`, tone: "held" };
  const hold = team.paneHolds[role] ?? null;
  if (hold === null) return { text: "ready", tone: "ok" };
  return { text: hold === HOLD_NOT_RUNNING ? "not running" : hold, tone: "held" };
}

/** The "Not reached" reason Apply or Start gave a role, while it still holds: once its pane is free, or was replaced by a free one, it is stale. */
export function notReachedLine(
  team: Pick<TeamSummary, "assignments" | "paneHolds">,
  role: string,
  tabs: { id: string }[],
  stored: string | undefined,
): string | null {
  if (!stored) return null;
  if (!livePane(team, role, tabs)) return stored;
  return team.paneHolds[role] ? stored : null;
}

/** What Aya widened to make the role's pane reach it, null when nothing or the role has no pane. */
export function roleNote(
  team: Pick<TeamSummary, "assignments" | "paneNotes">,
  role: string,
  tabs: { id: string }[],
): string | null {
  return livePane(team, role, tabs) ? (team.paneNotes[role] ?? null) : null;
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
  const because = (roles: string[], lead: string) =>
    roles.length ? ` ${lead} Aya: ${roles.join(", ")}; ${roles.length === 1 ? "its status below says" : "their statuses below say"} why.` : "";
  const cantReach =
    because(panes.filter((p) => p.cantReach && !p.unsure).map((p) => p.role), "Can't reach") +
    because(panes.filter((p) => p.unsure).map((p) => p.role), "May not reach");
  if (!running) return `${given}${left}${cantReach} Start the team when you are ready.`;
  return `${given}${left}${panes.some((p) => p.notReached) ? " The roles marked below were not told their role." : ""}`;
}
