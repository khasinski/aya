// A team, as defined in the repo at .aya/teams/<name>.md. Plain markdown
// sections instead of YAML, so people and agents can read and edit it.

export interface TeamRole {
  id: string;
  sendsTo: string[];
  mustNot: string;
  responsibilities: string;
}

export interface TeamCadence {
  role: string;
  minutes: number;
}

export interface TeamDefinition {
  name: string;
  roles: TeamRole[];
  cadence: TeamCadence | null;
  protocol: string;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_CADENCE_MINUTES = 24 * 60;

export class TeamFileError extends Error {
  constructor(name: string, problem: string) {
    super(`team "${name}": ${problem}`);
  }
}

function parseRole(team: string, id: string, body: string): TeamRole {
  if (!ID_RE.test(id)) {
    throw new TeamFileError(team, `role "${id}" must be lowercase letters, digits and dashes`);
  }
  let sendsTo: string[] = [];
  let mustNot = "";
  const rest: string[] = [];
  for (const line of body.split("\n")) {
    const field = line.match(/^(Sends to|Must not):\s*(.*)$/);
    if (!field) rest.push(line);
    else if (field[1] === "Sends to") sendsTo = field[2].split(",").map((s) => s.trim()).filter(Boolean);
    else mustNot = field[2].trim();
  }
  if (!mustNot) throw new TeamFileError(team, `role "${id}" needs a "Must not:" line`);
  return { id, sendsTo, mustNot, responsibilities: rest.join("\n").trim() };
}

function parseCadence(team: string, body: string): TeamCadence {
  const match = body.trim().match(/^([a-z0-9-]+) every (\d+) min$/);
  const minutes = match ? Number(match[2]) : 0;
  if (!match || minutes < 1 || minutes > MAX_CADENCE_MINUTES) {
    throw new TeamFileError(team, `cadence must read "<role> every <1-${MAX_CADENCE_MINUTES}> min"`);
  }
  return { role: match[1], minutes };
}

export function parseTeamFile(name: string, text: string): TeamDefinition {
  if (!ID_RE.test(name)) {
    throw new TeamFileError(name, "the file name must be lowercase letters, digits and dashes");
  }
  const roles: TeamRole[] = [];
  let cadence: TeamCadence | null = null;
  let protocol = "";
  // The first chunk is the title and anything before the first section.
  for (const section of text.replace(/\r\n/g, "\n").split(/^## /m).slice(1)) {
    const newline = section.indexOf("\n");
    const heading = (newline < 0 ? section : section.slice(0, newline)).trim();
    const body = newline < 0 ? "" : section.slice(newline + 1);
    const role = heading.match(/^Role:\s*(.+)$/);
    if (role) roles.push(parseRole(name, role[1].trim(), body));
    else if (heading === "Cadence") cadence = parseCadence(name, body);
    else if (heading === "Protocol") protocol = body.trim();
    else throw new TeamFileError(name, `unknown section "## ${heading}"`);
  }

  const ids = roles.map((r) => r.id);
  if (roles.length < 2) throw new TeamFileError(name, "a team needs at least two roles");
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate) throw new TeamFileError(name, `role "${duplicate}" is defined twice`);
  for (const role of roles) {
    for (const to of role.sendsTo) {
      if (to === role.id) throw new TeamFileError(name, `role "${role.id}" sends to itself`);
      if (!ids.includes(to)) throw new TeamFileError(name, `role "${role.id}" sends to unknown role "${to}"`);
    }
  }
  if (cadence && !ids.includes(cadence.role)) {
    throw new TeamFileError(name, `cadence names unknown role "${cadence.role}"`);
  }
  return { name, roles, cadence, protocol };
}

export function serializeTeam(team: TeamDefinition): string {
  const parts = [`# ${team.name}`];
  for (const role of team.roles) {
    const lines = [`## Role: ${role.id}`];
    if (role.sendsTo.length) lines.push(`Sends to: ${role.sendsTo.join(", ")}`);
    lines.push(`Must not: ${role.mustNot}`);
    if (role.responsibilities) lines.push(role.responsibilities);
    parts.push(lines.join("\n"));
  }
  if (team.cadence) parts.push(`## Cadence\n${team.cadence.role} every ${team.cadence.minutes} min`);
  if (team.protocol) parts.push(`## Protocol\n${team.protocol}`);
  return `${parts.join("\n\n")}\n`;
}
