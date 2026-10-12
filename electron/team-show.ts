// `aya team show [team] [--json]`: the whole team as Aya runs it (the saved copy), read-only,
// so a role never has to be pointed at a team file by its path.

import type { TeamShowRequest } from "./control-protocol";
import { callerProject } from "./team-author";
import { STARTING_MESSAGE, TryAgainError, type TeamControlDeps } from "./team-control";
import { paneTeamRole, runnableTeamNames, teamFile } from "./team-files";
import { ID_RE, parseTeamFile } from "./team-definition";
import { openTeamStore, readText, savedTeamNames } from "./team-store";
import { PROJECT_AYA_DIRNAME } from "./paths";
import type { ProjectConfig, TeamDefinition } from "./types";

/** How the repo's .aya/teams/<team>.md compares with the saved copy shown. */
export type RepoFileState = "same" | "differs" | "missing";

export interface TeamShow {
  team: string;
  project: string;
  /** The caller's role in this team, when it runs in one of its panes. */
  you: string | null;
  lead: string | null;
  cadenceMinutes: number | null;
  statusCommand: string | null;
  protocol: string;
  repoFile: RepoFileState;
  roles: { id: string; lead: boolean; sendsTo: { to: string; what: string }[]; mustNot: string; responsibilities: string }[];
}

type ShowDeps = Pick<TeamControlDeps, "teamHome" | "listProjects" | "starting">;

const repoPath = (name: string) => `${PROJECT_AYA_DIRNAME}/teams/${name}.md`;

async function whichTeam(request: TeamShowRequest, project: ProjectConfig, played: string | null, deps: ShowDeps): Promise<string> {
  if (request.team) {
    if (!ID_RE.test(request.team)) throw new Error(`"${request.team}" is not a team name`);
    return request.team;
  }
  if (played) return played;
  const saved = await savedTeamNames(deps.teamHome, project.slug);
  if (saved.length === 1) return saved[0];
  if (!saved.length) throw new Error(`project ${project.slug} has no team saved in Aya`);
  throw new Error(`name the team: aya team show <team> (project ${project.slug} has ${saved.join(", ")})`);
}

export async function teamShow(request: TeamShowRequest, callerId: string | undefined, deps: ShowDeps): Promise<TeamShow> {
  const projects = await deps.listProjects();
  const project = await callerProject(projects, callerId, request);
  if (!project) {
    if (deps.starting?.()) throw new TryAgainError(STARTING_MESSAGE);
    throw new Error("run aya team show in an Aya pane, or with AYA_PROJECT_SLUG set to a project open in Aya");
  }
  if (project.remote) throw new Error("teams work only on local projects");
  const inPane = Boolean(callerId && project.tabs.some((t) => t.id === callerId));
  const plays = inPane ? await paneTeamRole(deps.teamHome, project, callerId!) : null;
  const name = await whichTeam(request, project, plays?.team ?? null, deps);
  const saved = await openTeamStore(deps.teamHome, project.slug, name).savedDefinition();
  const repo = await readText(teamFile(project, name));
  if (saved === null) {
    if (repo !== null) throw new Error(`team ${name} is not saved in Aya yet, so it does not run; the user saves it in the Teams window`);
    const known = await runnableTeamNames(deps.teamHome, project);
    throw new Error(`no team ${name} in project ${project.slug}${known.length ? `; its teams: ${known.join(", ")}` : ""}`);
  }
  const team: TeamDefinition = parseTeamFile(name, saved);
  return {
    team: name,
    project: project.slug,
    you: plays?.team === name ? plays.role : null,
    lead: team.lead,
    cadenceMinutes: team.cadenceMinutes,
    statusCommand: team.statusCommand ?? null,
    protocol: team.protocol,
    repoFile: repo === null ? "missing" : repo === saved ? "same" : "differs",
    roles: team.roles.map((r) => ({ id: r.id, lead: r.id === team.lead, sendsTo: r.sendsTo, mustNot: r.mustNot, responsibilities: r.responsibilities })),
  };
}

const indent = (text: string) => text.split("\n").map((line) => (line ? `  ${line}` : line)).join("\n");

export function formatTeamShow(show: TeamShow): string {
  const lines = [`team      ${show.team}`, `project   ${show.project}`, `lead      ${show.lead ?? "(none)"}`];
  lines.push(show.cadenceMinutes ? `cadence   ${show.lead ?? "the lead"} every ${show.cadenceMinutes} min` : "cadence   none (no rounds on a timer)");
  if (show.statusCommand) lines.push(`status    ${show.statusCommand}  (the user's; its output goes with the lead's rounds)`);
  if (show.you) lines.push(`you       ${show.you}`);
  // The repo file is not what runs: an agent that read it would act on roles the team does not have.
  if (show.repoFile === "differs") {
    lines.push("", `the repo file ${repoPath(show.team)} differs from this saved team; the team runs this one until the user saves the repo file in the Teams window`);
  } else if (show.repoFile === "missing") {
    lines.push("", `the repo file ${repoPath(show.team)} is gone; the team runs this saved one`);
  }
  for (const role of show.roles) {
    const marks = [role.lead && "lead", role.id === show.you && "you"].filter(Boolean);
    lines.push("", `role ${role.id}${marks.length ? ` (${marks.join(", ")})` : ""}`);
    const sends = role.sendsTo.map((s) => (s.what ? `${s.to}: ${s.what}` : s.to));
    if (!sends.length) lines.push("  sends to  (nobody)");
    sends.forEach((line, i) => lines.push(`  ${i ? "         " : "sends to"}  ${line}`));
    lines.push(`  must not  ${role.mustNot}`);
    if (role.responsibilities) lines.push(indent(role.responsibilities));
  }
  if (show.protocol) lines.push("", "protocol", show.protocol);
  return `${lines.join("\n")}\n`;
}

export async function handleTeamShow(request: TeamShowRequest, callerId: string | undefined, deps: ShowDeps): Promise<{ output: string }> {
  const show = await teamShow(request, callerId, deps);
  return { output: request.json ? `${JSON.stringify(show, null, 2)}\n` : formatTeamShow(show) };
}
