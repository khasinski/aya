// Where a project's teams live (.aya/teams/<name>.md), which one a pane plays
// a role in, and which definition Aya runs.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { openTeamStore, type TeamStore } from "./team-store";
import { parseTeamFile } from "./teams";
import type { ProjectConfig, TeamDefinition } from "./types";

export function teamsDir(project: ProjectConfig): string {
  return path.join(project.directory, ".aya", "teams");
}

export function teamFile(project: ProjectConfig, name: string): string {
  return path.join(teamsDir(project), `${name}.md`);
}

/** The project's team names, sorted; none when the folder is missing. */
export async function teamNames(project: ProjectConfig): Promise<string[]> {
  try {
    const files = await fs.readdir(teamsDir(project));
    return files.filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
  } catch {
    return [];
  }
}

/** The saved definition wins: repo edits apply only after Save team. */
export async function loadTeam(project: ProjectConfig, name: string, store: TeamStore): Promise<TeamDefinition> {
  const text = (await store.savedDefinition()) ?? (await fs.readFile(teamFile(project, name), "utf-8"));
  return parseTeamFile(name, text);
}

/** The team and role a pane plays in this project, or null. */
export async function paneTeamRole(
  teamHome: string,
  project: ProjectConfig,
  paneId: string,
): Promise<{ team: string; role: string; store: TeamStore } | null> {
  for (const team of await teamNames(project)) {
    const store = openTeamStore(teamHome, project.slug, team);
    const role = await store.roleOf(paneId);
    if (role) return { team, role, store };
  }
  return null;
}

export function projectBySlug(projects: ProjectConfig[], slug: string): ProjectConfig {
  const project = projects.find((p) => p.slug === slug);
  if (!project) throw new Error(`project ${slug} is not open`);
  return project;
}
