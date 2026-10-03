// A team, as defined in the repo at .aya/teams/<name>.md. Plain markdown
// sections instead of YAML, so people and agents can read and edit it.

import type { SendRoute, TeamDefinition, TeamRole } from "./types";

export const ID_MAX_LEN = 40;
export const ID_RE = new RegExp(`^[a-z0-9][a-z0-9-]{0,${ID_MAX_LEN - 1}}$`);
export const MIN_TEAM_ROLES = 2;
/** The sender of Aya's own messages: delivery tests and rounds. */
export const TEAM_SYSTEM_SENDER = "aya";
export const RESERVED_ROLE_PROBLEM = `"${TEAM_SYSTEM_SENDER}" is reserved for Aya's own messages; name the role something else`;
/** The sender of a task the user gives with Start; no new or saved role may take it. A team saved before it was
 *  reserved still runs, but takes no task (TeamRunner.start), so "user" there is only its role. */
export const TEAM_USER_SENDER = "user";

/** Why a role cannot be saved under this id, or null. Loading an already saved
 *  team refuses only "aya" (parseTeamFile): "user" became reserved later. */
export function reservedRoleProblem(id: string): string | null {
  if (id === TEAM_SYSTEM_SENDER) return RESERVED_ROLE_PROBLEM;
  return id === TEAM_USER_SENDER ? `"${TEAM_USER_SENDER}" is reserved for the user's own messages; name the role something else` : null;
}
export const SENDS_TO_FIELD = "Sends to";
export const MUST_NOT_FIELD = "Must not";
export const SECTION_MARKER = "## ";
const FIELD_RE = new RegExp(`^(${SENDS_TO_FIELD}|${MUST_NOT_FIELD}):\\s*(.*)$`);
const SECTION_RE = new RegExp(`^${SECTION_MARKER}`, "m");
export const MAX_CADENCE_MINUTES = 24 * 60;
export const STATUS_COMMAND_SECTION = "Status command";

export class TeamFileError extends Error {
  constructor(name: string, problem: string) {
    super(`team "${name}": ${problem}`);
  }
}

/** "implementer (findings to fix), tester": commas inside parentheses are the what's. */
function parseSends(team: string, id: string, text: string): SendRoute[] {
  const routes: SendRoute[] = [];
  const re = /\s*([^,(]+?)\s*(?:\(([^()]*)\))?\s*(?:,|$)/y;
  const list = text.trim().replace(/,\s*$/, "");
  let at = 0;
  while (at < list.length) {
    re.lastIndex = at;
    const m = re.exec(list);
    if (!m) throw new TeamFileError(team, `role "${id}": unbalanced parentheses in "Sends to:"`);
    at = re.lastIndex;
    if (routes.some((r) => r.to === m[1])) throw new TeamFileError(team, `role "${id}" lists "${m[1]}" twice in "Sends to:"`);
    routes.push({ to: m[1], what: (m[2] ?? "").trim() });
  }
  return routes;
}

function parseRole(team: string, id: string, body: string): TeamRole {
  if (!ID_RE.test(id)) {
    throw new TeamFileError(team, `role "${id}" must be lowercase letters, digits and dashes`);
  }
  if (id === TEAM_SYSTEM_SENDER) throw new TeamFileError(team, RESERVED_ROLE_PROBLEM);
  let sendsTo: SendRoute[] = [];
  let mustNot = "";
  const rest: string[] = [];
  for (const line of body.split("\n")) {
    const field = line.match(FIELD_RE);
    if (!field) rest.push(line);
    else if (field[1] === SENDS_TO_FIELD) sendsTo = parseSends(team, id, field[2]);
    else mustNot = field[2].trim();
  }
  if (!mustNot) throw new TeamFileError(team, `role "${id}" needs a "Must not:" line`);
  return { id, sendsTo, mustNot, responsibilities: rest.join("\n").trim() };
}

/** A file's "## Cadence": the role it names and the minutes. */
interface FileCadence {
  role: string;
  minutes: number;
}

function parseCadence(team: string, body: string): FileCadence {
  const match = body.trim().match(/^([a-z0-9-]+) every (\d+) min$/);
  const minutes = match ? Number(match[2]) : 0;
  if (!match || minutes < 1 || minutes > MAX_CADENCE_MINUTES) {
    throw new TeamFileError(team, `cadence must read "<role> every <1-${MAX_CADENCE_MINUTES}> min"`);
  }
  return { role: match[1], minutes };
}

/** Why a status command cannot be saved, or null. One line: it is one shell command, and its section ends at the line break. */
export function statusCommandProblem(command: string): string | null {
  const text = command.trim();
  if (!text) return `"${SECTION_MARKER}${STATUS_COMMAND_SECTION}" is empty; write one shell command or remove the section`;
  return text.includes("\n") ? "the status command must be one line; put a longer one in a script and name the script" : null;
}

function parseStatusCommand(team: string, body: string): string {
  const problem = statusCommandProblem(body);
  if (problem) throw new TeamFileError(team, problem);
  return body.trim();
}

function parseLead(team: string, body: string): string {
  const lead = body.trim();
  if (!ID_RE.test(lead)) throw new TeamFileError(team, 'lead must read "<role>", one role id');
  return lead;
}

export function parseTeamFile(name: string, text: string): TeamDefinition {
  if (!ID_RE.test(name)) {
    throw new TeamFileError(name, "the file name must be lowercase letters, digits and dashes");
  }
  const roles: TeamRole[] = [];
  let cadence: FileCadence | null = null;
  let lead: string | null = null;
  let protocol = "";
  let statusCommand: string | null = null;
  // The first chunk is the title and anything before the first section.
  for (const section of text.replace(/\r\n/g, "\n").split(SECTION_RE).slice(1)) {
    const newline = section.indexOf("\n");
    const heading = (newline < 0 ? section : section.slice(0, newline)).trim();
    const body = newline < 0 ? "" : section.slice(newline + 1);
    const role = heading.match(/^Role:\s*(.+)$/);
    if (role) roles.push(parseRole(name, role[1].trim(), body));
    else if (heading === "Lead") lead = parseLead(name, body);
    else if (heading === "Cadence") cadence = parseCadence(name, body);
    else if (heading === "Protocol") protocol = body.trim();
    else if (heading === STATUS_COMMAND_SECTION) statusCommand = parseStatusCommand(name, body);
    else throw new TeamFileError(name, `unknown section "## ${heading}"`);
  }

  const ids = roles.map((r) => r.id);
  if (roles.length < MIN_TEAM_ROLES) throw new TeamFileError(name, `a team needs at least ${MIN_TEAM_ROLES} roles`);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate) throw new TeamFileError(name, `role "${duplicate}" is defined twice`);
  for (const role of roles) {
    for (const { to } of role.sendsTo) {
      if (to === role.id) throw new TeamFileError(name, `role "${role.id}" sends to itself`);
      if (!ids.includes(to)) throw new TeamFileError(name, `role "${role.id}" sends to unknown role "${to}"`);
    }
  }
  if (cadence && !ids.includes(cadence.role)) {
    throw new TeamFileError(name, `cadence names unknown role "${cadence.role}"`);
  }
  if (lead && !ids.includes(lead)) throw new TeamFileError(name, `lead names unknown role "${lead}"`);
  return { name, roles, ...leadAndRhythm(lead, cadence), protocol, ...(statusCommand ? { statusCommand } : {}) };
}

/** The one rule for the lead and the rhythm: the role "## Cadence" names is the lead. A "## Lead" naming another goes to
 *  `leadConflict`, so an old file still loads (the card warns) and a save refuses it. */
function leadAndRhythm(lead: string | null, cadence: FileCadence | null): Pick<TeamDefinition, "lead" | "cadenceMinutes" | "leadConflict"> {
  const conflict = lead !== null && cadence !== null && lead !== cadence.role;
  return { lead: cadence?.role ?? lead, cadenceMinutes: cadence?.minutes ?? null, ...(conflict ? { leadConflict: lead } : {}) };
}

/** Why a team cannot be saved for its lead, or null. That the lead is one of its roles and the minutes are in
 *  range is the parser's to say, when the saved text is read back. */
export function leadProblemOf(team: Pick<TeamDefinition, "lead" | "leadConflict">): string | null {
  if (team.leadConflict) return "cadence and lead name different roles; make them the same";
  return team.lead ? null : 'no role leads it; add "## Lead" with the role that starts the work and checks nobody waits too long';
}

/** The name in the "# <name>" title above the first section, or null. */
export function teamTitle(text: string): string | null {
  const head = text.replace(/\r\n/g, "\n").split(SECTION_RE)[0];
  return head.match(/^#[ \t]+(.+?)[ \t]*$/m)?.[1] ?? null;
}

export function serializeTeam(team: TeamDefinition): string {
  const parts = [`# ${team.name}`];
  for (const role of team.roles) {
    const lines = [`## Role: ${role.id}`];
    if (role.sendsTo.length) {
      lines.push(`Sends to: ${role.sendsTo.map((r) => (r.what ? `${r.to} (${r.what})` : r.to)).join(", ")}`);
    }
    lines.push(`Must not: ${role.mustNot}`);
    if (role.responsibilities) lines.push(role.responsibilities);
    parts.push(lines.join("\n"));
  }
  if (team.lead) parts.push(`## Lead\n${team.lead}`);
  if (team.lead && team.cadenceMinutes !== null) parts.push(`## Cadence\n${team.lead} every ${team.cadenceMinutes} min`);
  if (team.statusCommand?.trim()) parts.push(`${SECTION_MARKER}${STATUS_COMMAND_SECTION}\n${team.statusCommand.trim()}`);
  if (team.protocol) parts.push(`## Protocol\n${team.protocol}`);
  return `${parts.join("\n\n")}\n`;
}
