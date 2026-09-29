// Where a project's teams live (.aya/teams/<name>.md), which one a pane plays
// a role in, and which definition Aya runs.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { PROJECT_AYA_DIRNAME } from "./paths";
import { openTeamStore, type TeamStore } from "./team-store";
import { ID_RE, parseTeamFile } from "./teams";
import type { ProjectConfig, TeamDefinition } from "./types";

export function teamsDir(project: ProjectConfig): string {
  return path.join(project.directory, PROJECT_AYA_DIRNAME, "teams");
}

export function teamFile(project: ProjectConfig, name: string): string {
  return path.join(teamsDir(project), `${name}.md`);
}

/** Files a team can be named after; anything else there (a README.md, "My
 *  Team.md") is not a team and must not stop the teams that are. */
export async function teamNames(project: ProjectConfig): Promise<string[]> {
  try {
    const files = await fs.readdir(teamsDir(project));
    return files
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
      .filter((name) => ID_RE.test(name))
      .sort();
  } catch {
    return [];
  }
}

/** Only what the user saved in Aya runs: a team file that arrived with a pull
 *  or a clone is shown in the teams window but reaches no agent until saved. */
export async function loadTeam(name: string, store: TeamStore): Promise<TeamDefinition> {
  const text = await store.savedDefinition();
  if (text === null) throw new Error(`team ${name} is not saved in Aya yet; open Teams and press Save team`);
  return parseTeamFile(name, text);
}

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
