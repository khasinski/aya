// `aya presets`, `aya team open` and the Teams window's Apply: one path that
// checks every role and target first, then gives each role its pane - a new
// session of a preset, the calling pane, or an existing pane - as the Teams
// window's assignment does.

import { randomUUID } from "node:crypto";
import type { TeamPanesRequest } from "./control-protocol";
import { preflightBinary } from "./command-probe";
import { HOLD_NOT_RUNNING, HOLD_STARTING } from "./pane-holds";
import { AGENT_KINDS, type AgentKind, type Preset } from "./presets";
import { assignRole } from "./team-admin";
import { callerProject } from "./team-author";
import type { TeamControlDeps } from "./team-control";
import { loadTeam, projectBySlug, teamNames } from "./team-files";
import type { TeamRunner } from "./team-runner";
import { openTeamStore } from "./team-store";
import type { NewPane, PanePick, PresetChoice, ProjectConfig, RolePane, RolePanes } from "./types";

/** How long a new pane of a running team may take to start before its role
 *  introduction is given up; an agent CLI starts in seconds. */
export const PANE_START_WAIT_MS = 20_000;
const PANE_START_POLL_MS = 250;
/** How long the window may take to open the panes and save the project. */
export const PANE_OPEN_TIMEOUT_MS = 10_000;
/** The target that means the pane running the command. */
export const THIS_PANE = "this";

/** What main needs from the window and the terminal host to open panes. */
export interface PaneHost {
  listPresets: () => Promise<Preset[]>;
  presetInstalled: (preset: Preset) => Promise<boolean>;
  paneAlive: (paneId: string) => Promise<boolean>;
  /** Resolves once the window has the panes as tabs of the saved project. */
  openPanes: (projectSlug: string, panes: NewPane[]) => Promise<void>;
  newPaneId: () => string;
}

export interface TeamPaneDeps extends PaneHost, Pick<TeamControlDeps, "teamHome" | "listProjects" | "holdReason"> {
  /** The Teams window's own introduction of an assigned role (TeamRunner). */
  introduce: (projectSlug: string, team: string, role: string) => Promise<string | null>;
  /** Test-only override of PANE_START_WAIT_MS. */
  startWaitMs?: number;
}

export function teamPaneDeps(team: TeamControlDeps, host: PaneHost, runner: Pick<TeamRunner, "introduce">): TeamPaneDeps {
  return {
    ...host,
    teamHome: team.teamHome,
    listProjects: team.listProjects,
    holdReason: team.holdReason,
    introduce: (slug, name, role) => runner.introduce(slug, name, role),
  };
}

export const newPaneId = (): string => randomUUID();

const ACCOUNT_PREFIXES: [RegExp, AgentKind][] = [
  [/\bCLAUDE_CONFIG_DIR=/, "claude"],
  [/\bCODEX_HOME=/, "codex"],
];
const AGENT_BINARIES: Partial<Record<string, AgentKind>> = { "cursor-agent": "cursor" };

/** The preset's agent as src/agentPreset.ts inferAgent reads it. */
export function presetAgent(preset: Preset): AgentKind {
  if (preset.agent) return preset.agent;
  const prefixed = ACCOUNT_PREFIXES.find(([re]) => re.test(preset.command));
  if (prefixed) return prefixed[1];
  const binary = preflightBinary(preset.command) ?? "";
  const kind = AGENT_BINARIES[binary] ?? binary;
  return (AGENT_KINDS as readonly string[]).includes(kind) ? (kind as AgentKind) : "custom";
}

export async function presetChoices(deps: Pick<PaneHost, "listPresets" | "presetInstalled">): Promise<PresetChoice[]> {
  const presets = await deps.listPresets();
  return Promise.all(
    presets.map(async (p) => ({ id: p.id, name: p.name, agent: presetAgent(p), installed: await deps.presetInstalled(p) })),
  );
}

export function formatPresets(choices: PresetChoice[]): string {
  const rows = [["id", "name", "agent", "installed"], ...choices.map((c) => [c.id, c.name, c.agent, c.installed ? "yes" : "no"])];
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((cell, i) => (i < r.length - 1 ? cell.padEnd(widths[i] + 2) : cell)).join("")).join("\n") + "\n";
}

type Target = { kind: "new"; preset: Preset } | { kind: "pane"; paneId: string; name: string };

/** `this`, else a pane id, else a preset id, else a pane name; a string is the problem. */
function resolveTarget(target: string, project: ProjectConfig, callerId: string | undefined, presets: Preset[]): Target | string {
  const tab = (id: string | undefined) => project.tabs.find((t) => t.id === id);
  if (target === THIS_PANE) {
    const self = tab(callerId);
    return self ? { kind: "pane", paneId: self.id, name: self.name } : `"${THIS_PANE}" is the pane running the command; run it in an Aya pane of this project`;
  }
  const byId = tab(target);
  if (byId) return { kind: "pane", paneId: byId.id, name: byId.name };
  const preset = presets.find((p) => p.id === target);
  if (preset) return { kind: "new", preset };
  const named = project.tabs.filter((t) => t.name.trim().toLowerCase() === target.trim().toLowerCase());
  if (named.length === 1) return { kind: "pane", paneId: named[0].id, name: named[0].name };
  if (named.length > 1) return `pane name "${target}" is ambiguous: ${named.map((t) => `${t.name} (id ${t.id})`).join(", ")}; use an id`;
  return `no preset or pane "${target}"; presets: ${presets.map((p) => p.id).join(", ")}; panes: ${project.tabs.map((t) => t.name).join(", ")}`;
}

/** Which role of which team of the project each pane plays. */
async function rolesByPane(teamHome: string, project: ProjectConfig): Promise<Map<string, { team: string; role: string }>> {
  const out = new Map<string, { team: string; role: string }>();
  for (const team of await teamNames(project)) {
    for (const [role, pane] of Object.entries(await openTeamStore(teamHome, project.slug, team).assignments())) out.set(pane, { team, role });
  }
  return out;
}

interface Checked {
  problems: string[];
  targets: Target[];
}

/** Every reason the picks cannot be applied, and each pick's target. */
async function check(
  deps: TeamPaneDeps,
  project: ProjectConfig,
  teamName: string,
  picks: PanePick[],
  { replace, callerId }: { replace: boolean; callerId?: string },
): Promise<Checked> {
  const refused = (problem: string): Checked => ({ problems: [problem], targets: [] });
  if (project.remote) return refused("teams work only on local projects");
  const names = await teamNames(project);
  if (!names.includes(teamName)) return refused(`no team "${teamName}" in this project; its teams: ${names.join(", ") || "none"}`);
  const team = await loadTeam(teamName, openTeamStore(deps.teamHome, project.slug, teamName)).catch((err: Error) => err);
  if (team instanceof Error) return refused(team.message);
  if (picks.length === 0) return refused("name at least one role=target");
  const presets = await deps.listPresets();
  const playing = await rolesByPane(deps.teamHome, project);
  const listed = new Set(picks.map((p) => p.role));
  const problems: string[] = [];
  const targets: Target[] = [];
  const seenRoles = new Set<string>();
  const givenTo = new Map<string, string>();
  const live = async (pane: string) => project.tabs.some((t) => t.id === pane) && (await deps.paneAlive(pane));
  for (const { role, target } of picks) {
    if (seenRoles.has(role)) problems.push(`role "${role}" is listed twice`);
    seenRoles.add(role);
    if (!team.roles.some((r) => r.id === role)) {
      problems.push(`team ${teamName} has no role "${role}"; its roles: ${team.roles.map((r) => r.id).join(", ")}`);
    }
    const resolved = resolveTarget(target, project, callerId, presets);
    if (typeof resolved === "string") {
      problems.push(resolved);
      continue;
    }
    targets.push(resolved);
    const current = [...playing].find(([, p]) => p.team === teamName && p.role === role)?.[0];
    if (!replace && current && current !== (resolved.kind === "pane" ? resolved.paneId : null) && (await live(current))) {
      problems.push(`role "${role}" already has a live pane (${current}); add --replace to give it another (the old one keeps running, without the role)`);
    }
    if (resolved.kind === "new") {
      if (!(await deps.presetInstalled(resolved.preset))) problems.push(`preset "${resolved.preset.id}" (${resolved.preset.name}) is not installed`);
      continue;
    }
    const other = givenTo.get(resolved.paneId);
    if (other) problems.push(`pane "${resolved.name}" is given to both ${other} and ${role}`);
    givenTo.set(resolved.paneId, role);
    const plays = playing.get(resolved.paneId);
    const elsewhere = plays && !(plays.team === teamName && (plays.role === role || listed.has(plays.role)));
    if (elsewhere && !replace) {
      const where = plays.team === teamName ? plays.role : `${plays.role} in team ${plays.team}`;
      problems.push(`pane "${resolved.name}" plays ${where}; add --replace to move it (${plays.role} is then left without a pane)`);
    }
  }
  return { problems, targets };
}

/** Waits while the pane is still starting, then returns its hold, or null. */
async function startedHold(deps: TeamPaneDeps, paneId: string): Promise<string | null> {
  const deadline = Date.now() + (deps.startWaitMs ?? PANE_START_WAIT_MS);
  for (;;) {
    const hold = await deps.holdReason(paneId);
    if ((hold !== HOLD_STARTING && hold !== HOLD_NOT_RUNNING) || Date.now() >= deadline) return hold;
    await new Promise((resolve) => setTimeout(resolve, PANE_START_POLL_MS));
  }
}

/** Refuses with every problem and changes nothing, else opens the new
 *  sessions and gives every listed role its pane; unlisted roles keep theirs. */
export async function openTeamPanes(
  deps: TeamPaneDeps,
  project: ProjectConfig,
  teamName: string,
  picks: PanePick[],
  options: { replace: boolean; callerId?: string },
): Promise<RolePanes> {
  const { problems, targets } = await check(deps, project, teamName, picks, options);
  if (problems.length) throw new Error(`${problems.join("; ")}; nothing was opened`);
  const store = openTeamStore(deps.teamHome, project.slug, teamName);
  const before = await store.assignments();
  const panes = targets.map((t, i) =>
    t.kind === "new"
      ? { id: deps.newPaneId(), presetId: t.preset.id, name: `${t.preset.name} - ${picks[i].role}` }
      : { id: t.paneId, presetId: "", name: t.name },
  );
  const fresh = panes.filter((_, i) => targets[i].kind === "new");
  if (fresh.length) await deps.openPanes(project.slug, fresh);
  const current = projectBySlug(await deps.listProjects(), project.slug);
  for (const [i, pick] of picks.entries()) await assignRole(deps.teamHome, current, teamName, pick.role, panes[i].id);
  const after = await store.assignments();
  const { running } = await store.state();
  const given = await Promise.all(
    picks.map(async (pick, i): Promise<RolePane> => {
      const target = targets[i];
      const hold = running ? await startedHold(deps, panes[i].id) : null;
      const notReached = running ? (hold ?? (await deps.introduce(project.slug, teamName, pick.role))) : null;
      return { role: pick.role, paneId: panes[i].id, name: panes[i].name, preset: target.kind === "new" ? target.preset.name : null, notReached };
    }),
  );
  return { panes: given, leftWithoutPane: Object.keys(before).filter((role) => !after[role]) };
}

export function formatOpened(team: string, result: RolePanes, state: { running: boolean; paused: boolean }): string {
  const fresh = result.panes.filter((p) => p.preset).length;
  const lines = result.panes.map((p) => {
    const pane = `  ${p.role} -> ${p.preset ? "new " : ""}pane "${p.name}" (id ${p.paneId})`;
    if (!state.running) return pane;
    return `${pane}; ${p.notReached ? `not told its role: ${p.notReached}` : "told its role"}`;
  });
  const roles = result.panes.length === 1 ? "1 role" : `${result.panes.length} roles`;
  const left = result.leftWithoutPane.length ? [`left without a pane: ${result.leftWithoutPane.join(", ")}`] : [];
  const tail = state.running ? [] : [state.paused ? "The team is paused; resume it in the Teams window." : "Start it in the Teams window, or ask me to."];
  return [`team ${team}: gave ${roles} a pane, ${fresh} new:`, ...lines, ...left, ...tail, ""].join("\n");
}

export async function handleTeamPanesRequest(
  request: TeamPanesRequest,
  callerId: string | undefined,
  deps: TeamPaneDeps,
): Promise<{ output: string }> {
  if (request.type === "presets") {
    const choices = await presetChoices(deps);
    return { output: request.json ? `${JSON.stringify(choices, null, 2)}\n` : formatPresets(choices) };
  }
  const project = await callerProject(await deps.listProjects(), callerId, request);
  if (!project) throw new Error("run aya team open in an Aya pane, or in the directory of a project open in Aya; nothing was opened");
  const result = await openTeamPanes(deps, project, request.team, request.panes, { replace: request.replace, callerId });
  const state = await openTeamStore(deps.teamHome, project.slug, request.team).state();
  return { output: formatOpened(request.team, result, state) };
}

/** Main's requests to a window, each settled by the window's answer or its deadline. */
export class RendererRequests {
  private pending = new Map<string, (error: string | null) => void>();

  ask(send: (requestId: string) => void, timeoutMs = PANE_OPEN_TIMEOUT_MS): Promise<void> {
    const requestId = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => settle("the Aya window did not open the panes in time"), timeoutMs);
      const settle = (error: string | null) => {
        clearTimeout(timer);
        this.pending.delete(requestId);
        if (error) reject(new Error(error));
        else resolve();
      };
      this.pending.set(requestId, settle);
      send(requestId);
    });
  }

  answer(requestId: string, error: unknown): void {
    this.pending.get(requestId)?.(typeof error === "string" && error ? error : null);
  }
}
