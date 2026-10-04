// What the teams window reads and writes. Save team writes the repo file and
// the snapshot Aya runs on; later repo edits show as changed until saved.

import { promises as fs } from "node:fs";
import { writeFileAtomic } from "./atomic-write";
import { oneAtATime } from "./keyed-queue";
import { runnableTeamNames, teamFile } from "./team-files";
import { teamLiveness } from "./team-progress";
import { STALL_AFTER_MIN } from "./team-times";
import { openTeamStore, readText, type TeamStore } from "./team-store";
import {
  MUST_NOT_FIELD,
  SECTION_MARKER,
  SENDS_TO_FIELD,
  STATUS_COMMAND_SECTION,
  TeamFileError,
  leadProblemOf,
  parseTeamFile,
  reservedRoleProblem,
  savedStatusCommand,
  serializeTeam,
  statusCommandOf,
} from "./team-definition";
import type { TeamControlDeps } from "./team-control";
import type { ProjectConfig, TeamDefinition, TeamLiveness, TeamMessage, TeamSummary } from "./types";

export const LOG_TAIL = 50;

function repoParsed(name: string, repo: string | null): TeamDefinition | null {
  try {
    return repo === null ? null : parseTeamFile(name, repo);
  } catch {
    return null;
  }
}

/** `holdReason` and `launchNote`, when given, report each assigned pane's hold and its launch note. */
export async function listTeams(
  teamHome: string,
  project: ProjectConfig,
  holdReason?: (paneId: string) => Promise<string | null>,
  roleNoteReport?: TeamControlDeps["roleNoteReport"],
  launchNote?: (paneId: string) => Promise<string | null>,
): Promise<TeamSummary[]> {
  return Promise.all(
    (await runnableTeamNames(teamHome, project)).map(async (name): Promise<TeamSummary> => {
      const store = openTeamStore(teamHome, project.slug, name);
      const assignments = await store.assignments();
      const repo = await readText(teamFile(project, name));
      const saved = await store.savedDefinition();
      let definition: TeamDefinition | null = null;
      let error: string | null = null;
      try {
        definition = parseTeamFile(name, saved ?? repo ?? "");
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      const roleIds = definition && new Set(definition.roles.map((r) => r.id));
      const log = (await store.annotatedLog()).slice(-LOG_TAIL).map((m): TeamMessage => {
        // A role renamed or removed by a Save takes its inbox with it: say so instead of waiting for ever.
        const gone = !m.delivered && roleIds && !roleIds.has(m.to);
        return gone ? { ...m, held: `${m.to} is no longer a role of this team; this will not be delivered` } : m;
      });
      return {
        name,
        definition,
        error,
        repoChanged: saved !== null && repo !== null && repo !== saved,
        repoGone: saved !== null && repo === null,
        unsaved: saved === null && repo !== null,
        repoDefinition: repoParsed(name, repo),
        ...(await store.state()),
        agentAuthored: await store.agentAuthored(),
        assignments,
        paneHolds: await perLivePane(assignments, project, holdReason),
        paneNotes: await perLivePane(assignments, project, launchNote),
        ...(roleNoteReport ? await roleNoteReport(project, name, assignments) : { roleNotes: {}, staleNotes: [] }),
        unread: Object.fromEntries(await Promise.all((definition?.roles ?? []).map(async (r) => [r.id, (await store.owed(r.id)).length] as const))),
        liveness: await livenessOf(store, definition, holdReason),
        log,
      };
    }),
  );
}

/** A team whose progress cannot be read still lists; the others are not affected. */
async function livenessOf(store: TeamStore, definition: TeamDefinition | null, holdReason?: (paneId: string) => Promise<string | null>): Promise<TeamLiveness> {
  try {
    const watch = { cadence: definition?.cadenceMinutes ?? null, lead: !!definition?.lead };
    return await teamLiveness(store, (definition?.roles ?? []).map((r) => r.id), holdReason ?? (async () => null), watch);
  } catch (err) {
    console.warn("[aya] team liveness not read:", err);
    return { status: "never started", stalledSince: null, blocked: [], unreached: null, silence: { askAfterMin: null, stalledAfterMin: STALL_AFTER_MIN } };
  }
}

async function perLivePane(
  assignments: Record<string, string>,
  project: ProjectConfig,
  ask?: (paneId: string) => Promise<string | null>,
): Promise<Record<string, string | null>> {
  if (!ask) return {};
  const live = Object.entries(assignments).filter(([, pane]) => project.tabs.some((t) => t.id === pane));
  return Object.fromEntries(await Promise.all(live.map(async ([role, pane]) => [role, await ask(pane).catch(() => null)] as const)));
}

// A line the team file reads as a field or section, where only free text belongs.
const FIELD_LINE = new RegExp(`^(${SENDS_TO_FIELD}:|${MUST_NOT_FIELD}:|${SECTION_MARKER})`, "m");

/** Loading a saved team allows "user" (reserved later); saving one does not. */
function refuseReservedRoles(team: TeamDefinition): void {
  for (const role of team.roles) {
    const reserved = reservedRoleProblem(role.id);
    if (reserved) throw new TeamFileError(team.name, reserved);
  }
}

/** A new or edited team needs a lead (an old file without one still loads); leadProblemOf holds the rule. */
function withLead(given: TeamDefinition): TeamDefinition {
  const problem = leadProblemOf(given);
  if (problem) throw new TeamFileError(given.name, problem);
  const { leadConflict: _, ...team } = given;
  return team;
}

function refuseFieldLines(team: TeamDefinition): void {
  for (const role of team.roles) {
    const line = role.responsibilities.match(FIELD_LINE);
    if (line) {
      throw new Error(`role "${role.id}": a Responsibilities line starts with "${line[1].trim()}"; put that in its own field`);
    }
  }
  const line = team.protocol.match(FIELD_LINE);
  if (line?.[1] === SECTION_MARKER) throw new Error('protocol: a line starts with "##"; the team file would read it as a new section');
}

/** Throws unless the text parses and every role reads back the same, up to
 *  trimmed whitespace; a line break inside a one-line field would not. */
function refuseLossy(team: TeamDefinition, text: string): void {
  const back = parseTeamFile(team.name, text);
  const flat = (s: string) => s.trim();
  for (const [i, role] of team.roles.entries()) {
    const read = back.roles[i];
    const same =
      read?.id === role.id &&
      read.mustNot === flat(role.mustNot) &&
      read.responsibilities === flat(role.responsibilities) &&
      JSON.stringify(read.sendsTo) === JSON.stringify(role.sendsTo.map((s) => ({ to: s.to, what: flat(s.what) })));
    if (!same) throw new Error(`role "${role.id}" would not read back the same from the team file; check for line breaks or parentheses`);
  }
  if (back.statusCommand !== statusCommandOf(team.statusCommand)) throw new Error("the status command would not read back the same from the team file");
}

/** An agent's save keeps the status command the user saved: the command runs with the user's rights outside any
 *  pane's sandbox, so only the Teams window sets or changes it. */
async function withSavedStatusCommand(teamHome: string, project: ProjectConfig, team: TeamDefinition): Promise<TeamDefinition> {
  const saved = savedStatusCommand(team.name, await openTeamStore(teamHome, project.slug, team.name).savedDefinition());
  const given = statusCommandOf(team.statusCommand);
  if (given !== undefined && given !== saved) {
    throw new TeamFileError(team.name, `"${SECTION_MARKER}${STATUS_COMMAND_SECTION}" runs with the user's rights, so only the user sets it, in the Teams window; leave the section out`);
  }
  return saved === undefined ? team : { ...team, statusCommand: saved };
}

export class TeamExistsError extends Error {
  constructor(
    name: string,
    readonly file: string,
  ) {
    super(`team "${name}" already exists; edit it instead`);
  }
}

/** `create`: a new team, refused when one with its name already exists.
 *  `byAgent`: saved from a pane; the mark lands before the saved copy, so the window never lists the team without it.
 *  `fromWindow`: the Teams window's Save, the one place the status command is set. Every save over the control
 *  socket keeps the saved one: an agent can shed its pane identity (unset AYA_TERMINAL_ID, setsid), so "not under a
 *  pane" proves nothing about who typed the command. */
export async function saveTeam(
  teamHome: string,
  project: ProjectConfig,
  given: TeamDefinition,
  { create = false, byAgent = false, fromWindow = false }: { create?: boolean; byAgent?: boolean; fromWindow?: boolean } = {},
): Promise<void> {
  refuseReservedRoles(given);
  refuseFieldLines(given);
  const led = withLead(given);
  refuseLossy(led, serializeTeam(led));
  const file = teamFile(project, led.name);
  await oneSaveAtATime(file, async () => {
    // Read in the queue: a save queued ahead (the user clearing it) may change the command this one keeps.
    const team = fromWindow ? led : await withSavedStatusCommand(teamHome, project, led);
    const text = serializeTeam(team);
    if (create && (await fs.stat(file).then(() => true, () => false))) throw new TeamExistsError(team.name, file);
    await writeFileAtomic(file, text);
    const store = openTeamStore(teamHome, project.slug, team.name);
    if (byAgent) await store.markAgentAuthored();
    await store.saveDefinition(text);
    // A save in the window is the user's: it ends an earlier agent mark.
    if (!byAgent) await store.clearAgentAuthored();
    // A renamed or removed role would keep a pane no role id matches.
    const roles = new Set(team.roles.map((r) => r.id));
    for (const [role, pane] of Object.entries(await store.assignments())) {
      if (!roles.has(role)) await store.releasePane(pane);
    }
  });
}

/** Saves of one team file in turn: two creates (aya team save, the Teams window)
 *  would both pass the exists check and the later would overwrite the earlier. */
const oneSaveAtATime = oneAtATime();

export const whileTeamNotSaved = (file: string, work: () => Promise<void>): Promise<void> => oneSaveAtATime(file, work);

/** A closed tab plays no role anywhere. */
export async function releasePaneEverywhere(teamHome: string, project: ProjectConfig, paneId: string): Promise<void> {
  for (const name of await runnableTeamNames(teamHome, project)) {
    await openTeamStore(teamHome, project.slug, name).releasePane(paneId);
  }
}

export async function assignRole(
  teamHome: string,
  project: ProjectConfig,
  team: string,
  role: string,
  paneId: string | null,
): Promise<void> {
  const store = openTeamStore(teamHome, project.slug, team);
  if (paneId === null) {
    const held = await store.paneOf(role);
    if (held) await store.releasePane(held);
    return;
  }
  if (project.remote) throw new Error("teams work only on local panes");
  if (!project.tabs.some((t) => t.id === paneId)) throw new Error(`pane ${paneId} is not in this project`);
  // One role in one team per pane: whoami and the tab chip must agree.
  await releasePaneEverywhere(teamHome, project, paneId);
  await store.assign(role, paneId);
  await store.clearAgentAuthored();
}
