// `aya team new|save`: a guide any agent CLI can follow to write a team file,
// and a save through the Teams window's own Save team.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { TeamAuthorRequest } from "./control-protocol";
import { TeamExistsError, saveTeam } from "./team-admin";
import type { TeamControlDeps } from "./team-control";
import { WHAT_WORDS } from "./team-draft";
import { runnableTeamNames, teamFile } from "./team-files";
import {
  ID_MAX_LEN,
  MAX_CADENCE_MINUTES,
  MIN_TEAM_ROLES,
  MUST_NOT_FIELD,
  SECTION_MARKER,
  SENDS_TO_FIELD,
  STATUS_COMMAND_SECTION,
  TEAM_SYSTEM_SENDER,
  TEAM_USER_SENDER,
  parseTeamFile,
  teamTitle,
} from "./team-definition";
import type { ProjectConfig, TeamDefinition } from "./types";

export const GUIDE_EXAMPLE_START = "----- example: a complete team file -----";
export const GUIDE_EXAMPLE_END = "----- end of example -----";

const EXAMPLE = `# ux-fix

## Role: reviewer
${SENDS_TO_FIELD}: fixer (findings with the screen state)
${MUST_NOT_FIELD}: edit code
Plays the running game each round and reports what a player would get wrong, with the screen state as proof.

## Role: fixer
${SENDS_TO_FIELD}: reviewer (the commit to check), tester (what changed)
${MUST_NOT_FIELD}: leave a finding unanswered
Fixes each finding, answers every report, and names the commit to check.

## Role: tester
${SENDS_TO_FIELD}: fixer (failing tests with output)
${MUST_NOT_FIELD}: change the game code to pass a test
Runs the tests after each fix and adds a test for every fixed finding.

## Lead
reviewer

## Cadence
reviewer every 30 min

## Protocol
The reviewer leads: it gets the task and checks each round that no finding or fix waits too long on someone. Findings are hypotheses with a way to check them, not facts. Number the reviewer's reports as updates (Update 1, Update 2) and mark items [reported -> fixed -> confirmed].`;

const ID_RULE = `lowercase letters a-z, digits and dashes, starting with a letter or digit, at most ${ID_MAX_LEN} characters`;

const GUIDE = `Define an Aya team for this project. A team is a few roles; each role is an agent in its own Aya pane, and the roles message each other with: aya team send <role> "text". You write the team file; Aya checks it and saves it.

Steps
1. Look at the project before choosing roles: its README, how it is built, run and tested, and the code the request is about. Choose roles from what this project needs and what the user asked for. Two or three roles are usually enough; add one only for work no other role covers. Put first the role that takes the user's request and hands out the work.
2. Write the team file in the format below. Do not write .aya/teams/<name>.md yourself: the save writes it.
3. Save it: aya team save <draft-file>
   Or give it on stdin: aya team save -  (a quoted heredoc, <<'EOF', keeps $ and backticks as written).
   If it prints a problem, nothing was saved: fix what it names and save again. If the team already exists, ask the user before saving again with --replace.
4. Tell the user the team is saved and what each role does.
5. Give each role a pane. Run: aya presets and aya pane list
   aya presets lists this Aya's presets, the agent each runs, whether its CLI is installed and whether a role's pane of it reaches Aya (the way a CLI is launched, a sandbox or a plan agent, can keep its aya calls from ever reaching Aya); aya pane list lists the panes already open. Propose to the user which pane plays which role, one role per pane. A role can take a new session of an installed preset whose "reaches aya" is not "no" (several roles may take the same preset: each gets its own pane), this pane you run in, or a pane already open; aya team open says when an open pane can't reach Aya, and why. Different agents for roles that check each other's work can help. Then wait for the user's yes, and with it run:
   aya team open <team> <role>=<target> [<role>=<target> ...]
   where <target> is a preset id, this, or a pane's name or id. If a pane is named like a preset id, it says so: write new:<preset> or pane:<name>. Never open panes without the user's yes. If it prints a problem, nothing was opened: fix what it names and run it again.
6. Ask the user whether to start the team now, and with what task. Run it only on the user's word: aya team start <team> "<task>". The task goes to the lead (--to <role> picks another), and it prints who got the task. The user can also press Start in the Teams window.

The team file
- The first line is "# <name>". The name is the team's file name: ${ID_RULE}.
- Then one section per role, at least ${MIN_TEAM_ROLES} roles:
    ${SECTION_MARKER}Role: <id>
    ${SENDS_TO_FIELD}: <role> (<what>), <role> (<what>)
    ${MUST_NOT_FIELD}: <one line>
    <responsibilities: free text, one or more lines>
- A role id follows the same rules as the name and is unique in the team. "${TEAM_SYSTEM_SENDER}" and "${TEAM_USER_SENDER}" are reserved for Aya's and the user's own messages.
- "${MUST_NOT_FIELD}:" is required, on one line.
- "${SENDS_TO_FIELD}:" is one line of roles defined in this file, never the role itself, each once, each with what it gets from this role in parentheses (no parentheses inside). Leave the line out for a role that sends nothing.
- Every other line of a role is its responsibilities; none may start with "${SENDS_TO_FIELD}:", "${MUST_NOT_FIELD}:" or "${SECTION_MARKER}".
- Required "${SECTION_MARKER}Lead": one line, the id of the role that leads the team; name it yourself. The lead gets the task, and checks that nobody waits too long on someone else and that work is going on at all: when the team has made no progress for a while, Aya asks the lead for a round that says who waits on whom. Pick the role that takes the request and hands out the work, and give the reason in one sentence in the protocol. The save refuses a team without it.
- Optional "${SECTION_MARKER}Cadence": one line "<role> every <N> min", N from 1-${MAX_CADENCE_MINUTES}, with the lead's role: the rhythm belongs to the lead. The save refuses a Cadence and a Lead that name different roles (cadence and lead name different roles; make them the same). While the team runs, Aya prompts the lead to start a new round every N minutes, typed as "Aya round <N>: ...". A team with no Cadence still has its lead; it just gets no rounds on a timer.
- Optional "${SECTION_MARKER}Protocol": rules every role follows, free text; no line may start with "${SECTION_MARKER}". "Round" is Aya's word for its own numbered prompts to the lead ("Aya round 4"): if the protocol numbers the lead's or a role's reports, call them updates ("Update 4"), never rounds, so nobody mixes the two counters.
- Leave out "${SECTION_MARKER}${STATUS_COMMAND_SECTION}": the user sets it in the Teams window, and the save refuses one from an agent.
- No other "${SECTION_MARKER}" sections. Text between the title and the first section is dropped.

Write it well
- A role's name says its work. "${MUST_NOT_FIELD}" names one mistake that role is tempted to make, never the work its name says: a tester that must not "run tests" can do nothing.
- Give every route a what, ${WHAT_WORDS}. Agents read who sends what to whom from the routes; the same flow written only as prose was misread.
- Keep responsibilities to two or three sentences on what the role does each round. Each role reads its own entry again with: aya team whoami.
- A role that gets work sends something back, so no report goes unanswered.

${GUIDE_EXAMPLE_START}
${EXAMPLE}
${GUIDE_EXAMPLE_END}
`;

/** The guide `aya team new` prints: the user's request first, then the teams the project has. */
export function teamGuide(description: string | undefined, existing: string[]): string {
  const asked = description?.replace(/\s+/g, " ").trim();
  const parts = asked ? [`The user asked for: ${asked}`] : [];
  if (existing.length) {
    parts.push(`Teams this project already has: ${existing.join(", ")}. Saving under one of these names needs --replace; ask the user first.`);
  }
  return [...parts, GUIDE].join("\n\n");
}

export async function real(p: string): Promise<string> {
  return fs.realpath(p).catch(() => path.resolve(p));
}

/** `here` is `dir` or below it; both already real paths. */
export function within(here: string, dir: string): boolean {
  return here === dir || here.startsWith(dir + path.sep);
}

/** The calling pane's project, else the slug's, else the one the cwd is in. */
export async function callerProject(
  projects: ProjectConfig[],
  callerId: string | undefined,
  { projectSlug, cwd }: { projectSlug?: string; cwd?: string },
): Promise<ProjectConfig | null> {
  const found =
    projects.find((p) => callerId && p.tabs.some((t) => t.id === callerId)) ?? projects.find((p) => p.slug === projectSlug);
  if (found || !cwd) return found ?? null;
  const here = await real(cwd);
  let best: { project: ProjectConfig; depth: number } | null = null;
  for (const project of projects) {
    const dir = await real(project.directory);
    if (within(here, dir) && dir.length > (best?.depth ?? -1)) best = { project, depth: dir.length };
  }
  return best?.project ?? null;
}

function savedSummary(team: TeamDefinition, file: string): string {
  const routes = team.roles.flatMap((r) =>
    r.sendsTo.length ? r.sendsTo.map((s) => `${r.id} -> ${s.to}${s.what ? ` (${s.what})` : ""}`) : [`${r.id} -> nobody`],
  );
  const ids = team.roles.map((r) => r.id).join(", ");
  return (
    `saved team ${team.name}: ${team.roles.length} roles (${ids}); ${routes.join(", ")}\n` +
    `written to ${file}; saved in Aya, so its roles can be given panes and started from the Teams window\n`
  );
}

async function saveTeamText(
  request: Extract<TeamAuthorRequest, { type: "team-save" }>,
  project: ProjectConfig | null,
  callerId: string | undefined,
  deps: Pick<TeamControlDeps, "teamHome">,
  refresh: (slug: string, name: string) => Promise<void>,
  underPane: boolean,
): Promise<string> {
  if (!project) {
    throw new Error("run aya team save in an Aya pane, or in the directory of a project open in Aya; nothing was saved");
  }
  if (project.remote) throw new Error("teams work only on local projects; nothing was saved");
  const name = teamTitle(request.text);
  if (name === null) throw new Error('the team file must start with "# <team-name>"');
  const team = parseTeamFile(name, request.text);
  try {
    // The agent that saved it proposes its panes; the window's assign prompt would compete. The process tree
    // counts too: an agent can unset AYA_TERMINAL_ID, and a save it makes must not set the status command.
    const byAgent = underPane || project.tabs.some((t) => t.id === callerId);
    await saveTeam(deps.teamHome, project, team, { create: !request.replace, byAgent });
  } catch (err) {
    if (!(err instanceof TeamExistsError)) throw err;
    throw new Error(`team "${name}" already exists in ${err.file}; nothing was saved. Run aya team save again with --replace to overwrite it`);
  }
  await refresh(project.slug, name);
  return savedSummary(team, teamFile(project, name));
}

/** `refresh` re-arms a running team's rounds, as the Teams window's Save does.
 *  `underPane`: the process tree puts the caller under an Aya pane, whatever its env says. */
export async function handleTeamAuthorRequest(
  request: TeamAuthorRequest,
  callerId: string | undefined,
  deps: Pick<TeamControlDeps, "teamHome" | "listProjects">,
  refresh: (slug: string, name: string) => Promise<void>,
  underPane = false,
): Promise<{ output: string }> {
  const project = await callerProject(await deps.listProjects(), callerId, request);
  if (request.type === "team-save") return { output: await saveTeamText(request, project, callerId, deps, refresh, underPane) };
  return { output: teamGuide(request.description, project ? await runnableTeamNames(deps.teamHome, project) : []) };
}
