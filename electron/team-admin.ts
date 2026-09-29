// What the teams window reads and writes. Save team writes the repo file and
// the snapshot Aya runs on; later repo edits show as changed until saved.

import { promises as fs } from "node:fs";
import { writeFileAtomic } from "./atomic-write";
import { teamFile, teamNames } from "./team-files";
import { openTeamStore, readText } from "./team-store";
import {
  MUST_NOT_FIELD,
  SECTION_MARKER,
  SENDS_TO_FIELD,
  TEAM_SYSTEM_SENDER,
  TeamFileError,
  parseTeamFile,
  reservedRoleProblem,
  serializeTeam,
} from "./teams";
import type { ProjectConfig, TeamDefinition, TeamSummary } from "./types";

export const LOG_TAIL = 50;

function repoParsed(name: string, repo: string | null): TeamDefinition | null {
  try {
    return repo === null ? null : parseTeamFile(name, repo);
  } catch {
    return null;
  }
}

/** `holdReason`, when given, reports each assigned pane's hold for the role's status. */
export async function listTeams(
  teamHome: string,
  project: ProjectConfig,
  holdReason?: (paneId: string) => Promise<string | null>,
): Promise<TeamSummary[]> {
  return Promise.all(
    (await teamNames(project)).map(async (name): Promise<TeamSummary> => {
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
      // A held message the receiver has since had (inbox or typed later) reached it.
      const read = await store.readMarks();
      const log = (await store.log()).slice(-LOG_TAIL).map((m) => ({ ...m, delivered: m.delivered || (m.from !== TEAM_SYSTEM_SENDER && m.id <= (read[m.to] ?? 0)) }));
      return {
        name,
        definition,
        error,
        repoChanged: saved !== null && repo !== saved,
        unsaved: saved === null && repo !== null,
        repoDefinition: repoParsed(name, repo),
        ...(await store.state()),
        agentAuthored: await store.agentAuthored(),
        assignments,
        paneHolds: await paneHolds(assignments, project, holdReason),
        unread: Object.fromEntries(
          await Promise.all(
            (definition?.roles ?? []).map(async (r) => [r.id, (await store.unread(r.id)).length] as const),
          ),
        ),
        log,
      };
    }),
  );
}

async function paneHolds(
  assignments: Record<string, string>,
  project: ProjectConfig,
  holdReason?: (paneId: string) => Promise<string | null>,
): Promise<Record<string, string | null>> {
  if (!holdReason) return {};
  const live = Object.entries(assignments).filter(([, pane]) => project.tabs.some((t) => t.id === pane));
  return Object.fromEntries(await Promise.all(live.map(async ([role, pane]) => [role, await holdReason(pane)] as const)));
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
}

export class TeamExistsError extends Error {
  constructor(
    name: string,
    readonly file: string,
  ) {
    super(`team "${name}" already exists; edit it instead`);
  }
}

/** `create`: a new team, refused when one with its name already exists. */
export async function saveTeam(
  teamHome: string,
  project: ProjectConfig,
  team: TeamDefinition,
  { create = false }: { create?: boolean } = {},
): Promise<void> {
  refuseReservedRoles(team);
  refuseFieldLines(team);
  const text = serializeTeam(team);
  refuseLossy(team, text);
  const file = teamFile(project, team.name);
  await oneSaveAtATime(file, async () => {
    if (create && (await fs.stat(file).then(() => true, () => false))) throw new TeamExistsError(team.name, file);
    await writeFileAtomic(file, text);
    const store = openTeamStore(teamHome, project.slug, team.name);
    await store.saveDefinition(text);
    // A renamed or removed role would keep a pane no role id matches.
    const roles = new Set(team.roles.map((r) => r.id));
    for (const [role, pane] of Object.entries(await store.assignments())) {
      if (!roles.has(role)) await store.releasePane(pane);
    }
  });
}

/** Runs each call once every earlier call with its key has settled. */
export function oneAtATime(): <T>(key: string, work: () => Promise<T>) => Promise<T> {
  const running = new Map<string, Promise<unknown>>();
  return async (key, work) => {
    const mine = (running.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
    running.set(key, mine);
    try {
      return await mine;
    } finally {
      if (running.get(key) === mine) running.delete(key);
    }
  };
}

/** Saves of one team file in turn: two creates (aya team save, the Teams window)
 *  would both pass the exists check and the later would overwrite the earlier. */
const oneSaveAtATime = oneAtATime();

/** A closed tab plays no role anywhere. */
export async function releasePaneEverywhere(teamHome: string, project: ProjectConfig, paneId: string): Promise<void> {
  for (const name of await teamNames(project)) {
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
}
