// What the teams window reads and writes. Save team writes the repo file and
// the snapshot Aya runs on; later repo edits show as changed until saved.

import { promises as fs } from "node:fs";
import { writeFileAtomic } from "./atomic-write";
import { teamFile, teamNames } from "./team-files";
import { openTeamStore } from "./team-store";
import { MUST_NOT_FIELD, SECTION_MARKER, SENDS_TO_FIELD, TEAM_SYSTEM_SENDER, parseTeamFile, serializeTeam } from "./teams";
import type { ProjectConfig, TeamDefinition, TeamSummary } from "./types";

const LOG_TAIL = 50;

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf-8");
  } catch {
    return null;
  }
}

function repoParsed(name: string, repo: string | null): TeamDefinition | null {
  try {
    return repo === null ? null : parseTeamFile(name, repo);
  } catch {
    return null;
  }
}

export async function listTeams(teamHome: string, project: ProjectConfig): Promise<TeamSummary[]> {
  return Promise.all(
    (await teamNames(project)).map(async (name): Promise<TeamSummary> => {
      const store = openTeamStore(teamHome, project.slug, name);
      const repo = await readText(teamFile(project, name));
      const saved = await store.savedDefinition();
      let definition: TeamDefinition | null = null;
      let error: string | null = null;
      try {
        definition = parseTeamFile(name, saved ?? repo ?? "");
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      return {
        name,
        definition,
        error,
        repoChanged: saved !== null && repo !== saved,
        repoDefinition: repoParsed(name, repo),
        ...(await store.state()),
        assignments: await store.assignments(),
        unread: Object.fromEntries(
          await Promise.all(
            (definition?.roles ?? []).map(async (r) => [r.id, (await store.unread(r.id)).length] as const),
          ),
        ),
        // A held message the receiver has since had (inbox or typed later) reached it.
        log: await (async () => {
          const read = await store.readMarks();
          return (await store.log()).slice(-LOG_TAIL).map((m) => ({ ...m, delivered: m.delivered || (m.from !== TEAM_SYSTEM_SENDER && m.id <= (read[m.to] ?? 0)) }));
        })(),
      };
    }),
  );
}

// A line the team file reads as a field or section, where only free text belongs.
const FIELD_LINE = new RegExp(`^(${SENDS_TO_FIELD}:|${MUST_NOT_FIELD}:|${SECTION_MARKER})`, "m");

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

/** Validates by round-tripping through the parser, so the file on disk is
 *  always one the parser accepts. */
/** Throws unless the roles parse back the same, up to whitespace the format
 *  trims; a line break inside a one-line field would not. */
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

/** `create`: a new team, refused when one with its name already exists. */
export async function saveTeam(
  teamHome: string,
  project: ProjectConfig,
  team: TeamDefinition,
  { create = false }: { create?: boolean } = {},
): Promise<void> {
  refuseFieldLines(team);
  const text = serializeTeam(team);
  refuseLossy(team, text);
  const file = teamFile(project, team.name);
  if (create && (await fs.stat(file).then(() => true, () => false))) {
    throw new Error(`team "${team.name}" already exists; edit it instead`);
  }
  await writeFileAtomic(file, text);
  const store = openTeamStore(teamHome, project.slug, team.name);
  await store.saveDefinition(text);
  // A renamed or removed role would keep a pane no role id matches.
  const roles = new Set(team.roles.map((r) => r.id));
  for (const [role, pane] of Object.entries(await store.assignments())) {
    if (!roles.has(role)) await store.releasePane(pane);
  }
}

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
