// What the teams window reads and writes. Save team writes the repo file and
// the snapshot Aya runs on; later repo edits show as changed until saved.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { writeFileAtomic } from "./atomic-write";
import { TeamStore, teamDir } from "./team-store";
import { parseTeamFile, serializeTeam } from "./teams";
import type { ProjectConfig, TeamDefinition, TeamSummary } from "./types";

const LOG_TAIL = 50;

function teamFile(project: ProjectConfig, name: string): string {
  return path.join(project.directory, ".aya", "teams", `${name}.md`);
}

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
  const files = (await teamNamesOf(project)).map((n) => `${n}.md`);
  if (files.length === 0) return [];
  const names = files.filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
  return Promise.all(
    names.map(async (name): Promise<TeamSummary> => {
      const store = new TeamStore(teamDir(teamHome, project.slug, name));
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
        paused: await store.paused(),
        running: await store.running(),
        assignments: await store.assignmentsSnapshot(),
        unread: Object.fromEntries(
          await Promise.all(
            (definition?.roles ?? []).map(async (r) => [r.id, (await store.unread(r.id)).length] as const),
          ),
        ),
        log: (await store.log()).slice(-LOG_TAIL),
      };
    }),
  );
}

// A line the team file reads as a field or section, where only free text belongs.
const FIELD_LINE = /^(Sends to:|Must not:|## )/m;

function refuseFieldLines(team: TeamDefinition): void {
  for (const role of team.roles) {
    const line = role.responsibilities.match(FIELD_LINE);
    if (line) {
      throw new Error(`role "${role.id}": a Responsibilities line starts with "${line[1].trim()}"; put that in its own field`);
    }
  }
  const line = team.protocol.match(FIELD_LINE);
  if (line?.[1] === "## ") throw new Error('protocol: a line starts with "##"; the team file would read it as a new section');
}

/** Validates by round-tripping through the parser, so the file on disk is
 *  always one the parser accepts. */
export async function saveTeam(teamHome: string, project: ProjectConfig, team: TeamDefinition): Promise<void> {
  refuseFieldLines(team);
  const text = serializeTeam(team);
  parseTeamFile(team.name, text);
  await writeFileAtomic(teamFile(project, team.name), text);
  const store = new TeamStore(teamDir(teamHome, project.slug, team.name));
  await store.saveDefinition(text);
  // A renamed or removed role would keep a pane no role id matches.
  const roles = new Set(team.roles.map((r) => r.id));
  for (const [role, pane] of Object.entries(await store.assignmentsSnapshot())) {
    if (!roles.has(role)) await store.releasePane(pane);
  }
}

async function teamNamesOf(project: ProjectConfig): Promise<string[]> {
  try {
    return (await fs.readdir(path.join(project.directory, ".aya", "teams")))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3));
  } catch {
    return [];
  }
}

/** A closed tab plays no role anywhere. */
export async function releasePaneEverywhere(teamHome: string, project: ProjectConfig, paneId: string): Promise<void> {
  for (const name of await teamNamesOf(project)) {
    await new TeamStore(teamDir(teamHome, project.slug, name)).releasePane(paneId);
  }
}

export async function assignRole(
  teamHome: string,
  project: ProjectConfig,
  team: string,
  role: string,
  paneId: string | null,
): Promise<void> {
  const store = new TeamStore(teamDir(teamHome, project.slug, team));
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
