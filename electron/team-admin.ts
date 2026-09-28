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
  let files: string[] = [];
  try {
    files = await fs.readdir(path.join(project.directory, ".aya", "teams"));
  } catch {
    return [];
  }
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
        log: (await store.log()).slice(-LOG_TAIL),
      };
    }),
  );
}

/** Validates by round-tripping through the parser, so the file on disk is
 *  always one the parser accepts. */
export async function saveTeam(teamHome: string, project: ProjectConfig, team: TeamDefinition): Promise<void> {
  const text = serializeTeam(team);
  parseTeamFile(team.name, text);
  await writeFileAtomic(teamFile(project, team.name), text);
  await new TeamStore(teamDir(teamHome, project.slug, team.name)).saveDefinition(text);
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
  if (!project.tabs.some((t) => t.id === paneId)) throw new Error(`pane ${paneId} is not in this project`);
  await store.assign(role, paneId);
}
