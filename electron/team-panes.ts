// `aya presets`, `aya team open` and the Teams window's Apply panes: one path
// that checks every pick first, then gives each role a new session or an open pane.

import { randomUUID } from "node:crypto";
import type { TeamPanesRequest } from "./control-protocol";
import { preflightBinary } from "./command-probe";
import { HOLD_NOT_RUNNING, HOLD_STARTING } from "./pane-holds";
import { launchPending, launchStarting, launchUnsure, NO_LAUNCH_RECORD } from "./launch-mode";
import { AGENT_KINDS, type AgentKind, type Preset } from "./presets";
import { assignRole, releasePaneEverywhere, whileTeamNotSaved } from "./team-admin";
import { oneAtATime } from "./keyed-queue";
import { callerProject } from "./team-author";
import { STARTING_MESSAGE, TryAgainError, type TeamControlDeps } from "./team-control";
import { loadTeam, projectBySlug, runnableTeamNames, teamFile } from "./team-files";
import type { TeamRunner } from "./team-runner";
import { openTeamStore } from "./team-store";
import type {
  LaunchReach,
  NewPane,
  PanePick,
  PresetChoice,
  ProjectConfig,
  RolePane,
  RolePanes,
  TeamOpenPanesRequest,
  TeamStartResult,
} from "./types";

/** How long a new pane of a running team may take to start before its role
 *  introduction is given up; an agent CLI starts in seconds. */
export const PANE_START_WAIT_MS = 20_000;
const PANE_START_POLL_MS = 250;
const nextPoll = () => new Promise((resolve) => setTimeout(resolve, PANE_START_POLL_MS));
/** How many start windows a pane the host is spawning may take to be recorded. */
export const SPAWN_WAIT_WINDOWS = 3;
/** How long the window may take to open the panes and save the project. */
const PANE_OPEN_TIMEOUT_MS = 10_000;
/** The target that means the pane running the command. */
export const THIS_PANE = "this";

/** What main needs from the window and the terminal host to open panes. */
export interface PaneHost {
  listPresets: () => Promise<Preset[]>;
  presetInstalled: (preset: Preset) => Promise<boolean>;
  /** Whether a pane opened for a role from `preset` reaches Aya, and why Aya refuses to open one. */
  roleLaunch: (preset: Preset, project: ProjectConfig | null) => Promise<{ reach: LaunchReach; refused: string | null }>;
  /** Why the live pane's launch mode cannot reach Aya (electron/launch-mode.ts cantReach). */
  launchBlock: (paneId: string) => Promise<string | null>;
  /** What Aya widened to make the pane reach it (launchNoteOf), null when nothing. */
  launchNote: (paneId: string) => Promise<string | null>;
  paneAlive: (paneId: string) => Promise<boolean>;
  /** Resolves once the window has the panes as tabs of the saved project. */
  openPanes: (projectSlug: string, panes: NewPane[]) => Promise<void>;
  newPaneId: () => string;
  /** Says which role each pane about to open will play, until the returned
   *  function is called: they spawn before the role can be saved. */
  expectRoles?: (roles: { ptyId: string; team: string; role: string }[]) => () => void;
}

/** A pane is alive when it has a size, or its spawn is still starting (no PTY yet, but coming). */
export const paneAliveOf =
  (getSize: (paneId: string) => Promise<unknown>, holdReason: (paneId: string) => Promise<string | null>) =>
  async (paneId: string): Promise<boolean> =>
    (await getSize(paneId)) !== null || (await holdReason(paneId)) === HOLD_STARTING;

export interface TeamPaneDeps extends PaneHost, Pick<TeamControlDeps, "teamHome" | "listProjects" | "holdReason" | "starting"> {
  /** The Teams window's own introduction of an assigned role (TeamRunner). */
  introduce: (projectSlug: string, team: string, role: string) => Promise<string | null>;
  /** The Teams window's Start (TeamRunner); `by` is the role whose pane asked, absent for the user. */
  start: (projectSlug: string, team: string, task?: { text: string; to?: string }, by?: string) => Promise<TeamStartResult>;
  /** Test-only override of PANE_START_WAIT_MS. */
  startWaitMs?: number;
}

export function teamPaneDeps(team: TeamControlDeps, host: PaneHost, runner: Pick<TeamRunner, "introduce" | "start">): TeamPaneDeps {
  return {
    ...host,
    teamHome: team.teamHome,
    listProjects: team.listProjects,
    holdReason: team.holdReason,
    starting: team.starting,
    introduce: (slug, name, role) => runner.introduce(slug, name, role),
    start: (slug, name, task, by) => runner.start(slug, name, task, by),
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

/** `project` is where a role's pane would run: its CLI's project config counts. */
export async function presetChoices(
  deps: Pick<PaneHost, "listPresets" | "presetInstalled" | "roleLaunch">,
  project: ProjectConfig | null,
): Promise<PresetChoice[]> {
  const presets = await deps.listPresets();
  return Promise.all(
    presets.map(async (p) => {
      const installed = await deps.presetInstalled(p);
      const launch = installed ? await deps.roleLaunch(p, project) : { reach: "unknown" as const, refused: null };
      return { id: p.id, name: p.name, agent: presetAgent(p), installed, reach: launch.reach, cantReach: launch.refused };
    }),
  );
}

const REACH_CELL: Record<LaunchReach, string> = { reaches: "yes", blocked: "no", unknown: "unknown" };

export function formatPresets(choices: PresetChoice[]): string {
  const rows = [
    ["id", "name", "agent", "installed", "reaches aya"],
    ...choices.map((c) => [c.id, c.name, c.agent, c.installed ? "yes" : "no", REACH_CELL[c.reach]]),
  ];
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const table = rows.map((r) => r.map((cell, i) => (i < r.length - 1 ? cell.padEnd(widths[i] + 2) : cell)).join("")).join("\n") + "\n";
  const why = choices.flatMap((c) => (c.cantReach ? [`${c.id} can't reach Aya: ${c.cantReach}`] : []));
  return why.length ? `${table}\n${why.join("\n")}\n` : table;
}

type Target = { kind: "new"; preset: Preset } | { kind: "pane"; paneId: string; name: string };

/** Explicit targets, for a preset id that is also a pane name. */
export const NEW_TARGET = "new:";
export const PANE_TARGET = "pane:";

/** A tab by id, else by name; null when none, a string when the name is ambiguous. */
function paneByRef(ref: string, project: ProjectConfig): Target | string | null {
  const byId = project.tabs.find((t) => t.id === ref);
  if (byId) return { kind: "pane", paneId: byId.id, name: byId.name };
  const named = project.tabs.filter((t) => t.name.trim().toLowerCase() === ref.trim().toLowerCase());
  if (named.length === 1) return { kind: "pane", paneId: named[0].id, name: named[0].name };
  if (named.length > 1) return `pane name "${ref}" is ambiguous: ${named.map((t) => `${t.name} (id ${t.id})`).join(", ")}; use an id`;
  return null;
}

/** `this`, new:<preset>, pane:<name or id>, or a bare preset id, pane id or pane
 *  name when only one of them matches; a string is the problem. */
function resolveTarget(target: string, project: ProjectConfig, callerId: string | undefined, presets: Preset[]): Target | string {
  const presetList = presets.map((p) => p.id).join(", ");
  const paneList = project.tabs.map((t) => t.name).join(", ");
  if (target === THIS_PANE) {
    const self = project.tabs.find((t) => t.id === callerId);
    return self
      ? { kind: "pane", paneId: self.id, name: self.name }
      : `"${THIS_PANE}" is the pane running the command; run it in an Aya pane of this project`;
  }
  if (target.startsWith(NEW_TARGET)) {
    const id = target.slice(NEW_TARGET.length);
    const preset = presets.find((p) => p.id === id);
    return preset ? { kind: "new", preset } : `no preset "${id}"; presets: ${presetList}`;
  }
  if (target.startsWith(PANE_TARGET)) {
    const ref = target.slice(PANE_TARGET.length);
    return paneByRef(ref, project) ?? `no pane "${ref}"; panes: ${paneList}`;
  }
  const preset = presets.find((p) => p.id === target);
  const pane = paneByRef(target, project);
  if (preset && pane) {
    return `"${target}" is both a preset and a pane name; write ${NEW_TARGET}${target} for a new session or ${PANE_TARGET}${target} for the pane`;
  }
  if (preset) return { kind: "new", preset };
  return pane ?? `no preset or pane "${target}"; presets: ${presetList}; panes: ${paneList}`;
}

/** Which role of which team of the project each pane plays. */
async function rolesByPane(teamHome: string, project: ProjectConfig): Promise<Map<string, { team: string; role: string }>> {
  const out = new Map<string, { team: string; role: string }>();
  for (const team of await runnableTeamNames(teamHome, project)) {
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
  { replace, callerId, release = [] }: OpenPanesOptions,
): Promise<Checked> {
  const refused = (problem: string): Checked => ({ problems: [problem], targets: [] });
  if (project.remote) return refused("teams work only on local projects");
  const names = await runnableTeamNames(deps.teamHome, project);
  if (!names.includes(teamName)) return refused(`no team "${teamName}" in this project; its teams: ${names.join(", ") || "none"}`);
  const team = await loadTeam(teamName, openTeamStore(deps.teamHome, project.slug, teamName)).catch((err: Error) => err);
  if (team instanceof Error) return refused(team.message);
  if (picks.length === 0 && release.length === 0) return refused("name at least one role=target");
  const presets = await deps.listPresets();
  const playing = await rolesByPane(deps.teamHome, project);
  const problems: string[] = [];
  const targets: Target[] = [];
  const seenRoles = new Set<string>();
  const givenTo = new Map<string, string>();
  const live = async (pane: string) => project.tabs.some((t) => t.id === pane) && (await deps.paneAlive(pane));
  for (const role of release) {
    if (seenRoles.has(role)) problems.push(`role "${role}" is listed twice`);
    seenRoles.add(role);
    if (!team.roles.some((r) => r.id === role)) problems.push(`team ${teamName} has no role "${role}"`);
  }
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
      const { id, name } = resolved.preset;
      if (!(await deps.presetInstalled(resolved.preset))) problems.push(`preset "${id}" (${name}) is not installed`);
      else {
        const { refused } = await deps.roleLaunch(resolved.preset, project);
        if (refused) problems.push(`role "${role}": preset "${id}" (${name}) can't reach Aya: ${refused}`);
      }
      continue;
    }
    const other = givenTo.get(resolved.paneId);
    if (other) problems.push(`pane "${resolved.name}" is given to both ${other} and ${role}`);
    givenTo.set(resolved.paneId, role);
    const plays = playing.get(resolved.paneId);
    // A dead pane's role is paneless in practice: taking it needs no --replace.
    const elsewhere = plays && !(plays.team === teamName && plays.role === role);
    if (elsewhere && !replace && (await live(resolved.paneId))) {
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
    await nextPoll();
  }
}

/** A pick with the pane it gets: a new session's main-picked id, or an open pane. */
interface Planned {
  role: string;
  target: Target;
  pane: NewPane;
}

/** What the locked part of openTeamPanes did; introductions run after the lock. */
interface Assigned {
  given: Planned[];
  missed: string[];
  failure: Error | null;
  leftWithoutPane: string[];
}

export interface OpenPanesOptions {
  replace: boolean;
  callerId?: string;
  /** Roles to leave without a pane ("No pane" in Apply panes), once every pick passed. */
  release?: string[];
}

/** Runs `work` while no other open, assign or release of the project's panes runs, across its teams: two opens
 *  would both pass the check on the same assignments, and a pane may play only one role anywhere. */
export const whileProjectPanesFree = oneAtATime();

type ProjectDeps = Pick<TeamPaneDeps, "teamHome" | "listProjects">;

/** The Teams window's assign ("No pane" when paneId is null): the locks and the
 *  gone-check of an open, so a pane never ends up with two teams. */
export function assignRoleLocked(deps: ProjectDeps, slug: string, team: string, role: string, paneId: string | null): Promise<void> {
  return whileProjectPanesFree(slug, async () => {
    const project = projectBySlug(await deps.listProjects(), slug);
    const assign = () => assignRole(deps.teamHome, project, team, role, paneId);
    if (paneId === null) return assign();
    await assignWhileDefined(deps, project, team, [role], assign);
  });
}

/** A closed tab plays no role anywhere; serialised with opens and assigns. */
export const releasePaneLocked = (deps: ProjectDeps, slug: string, paneId: string): Promise<void> =>
  whileProjectPanesFree(slug, async () => releasePaneEverywhere(deps.teamHome, projectBySlug(await deps.listProjects(), slug), paneId));

/** Refuses with every problem and changes nothing, else opens the new
 *  sessions and gives every listed role its pane; unlisted roles keep theirs. */
export async function openTeamPanes(
  deps: TeamPaneDeps,
  project: ProjectConfig,
  teamName: string,
  picks: PanePick[],
  options: OpenPanesOptions,
): Promise<RolePanes> {
  // Checked against the project as it is once the open before this one is done.
  const { given, missed, failure, leftWithoutPane } = await whileProjectPanesFree(project.slug, async () =>
    openAndAssign(deps, projectBySlug(await deps.listProjects(), project.slug), teamName, picks, options),
  );
  const panes = await introduce(deps, project.slug, teamName, given);
  if (missed.length) {
    const which = panes.map((p, j) => `${p.role} ${j ? "" : "got "}${p.preset ? `its new pane (${p.paneId})` : "its pane"}`);
    const why = failure?.message ?? "a picked pane closed before it got its role";
    throw new Error([why, which.join(", "), `${missed.join(", ")} got none`].filter(Boolean).join("; "));
  }
  return { panes, leftWithoutPane };
}

async function openAndAssign(
  deps: TeamPaneDeps,
  project: ProjectConfig,
  teamName: string,
  picks: PanePick[],
  options: OpenPanesOptions,
): Promise<Assigned> {
  const { problems, targets } = await check(deps, project, teamName, picks, options);
  if (problems.length) throw new Error(`${problems.join("; ")}; nothing was opened`);
  const before = await rolesByPane(deps.teamHome, project);
  const planned: Planned[] = picks.map(({ role }, i) => {
    const target = targets[i];
    const pane =
      target.kind === "new"
        ? { id: deps.newPaneId(), presetId: target.preset.id, name: `${target.preset.name} - ${role}`, teamLaunch: true }
        : { id: target.paneId, presetId: "", name: target.name, teamLaunch: false };
    return { role, target, pane };
  });
  const fresh = planned.filter((p) => p.target.kind === "new");
  const forget = deps.expectRoles?.(fresh.map((p) => ({ ptyId: p.pane.id, team: teamName, role: p.role })));
  let lateReplyPending = false;
  try {
    // A reply can miss its deadline around the window's save: main picked the ids,
    // so the project says which panes exist, and those get their roles.
    const failure = fresh.length
      ? await deps.openPanes(project.slug, fresh.map((p) => p.pane)).then(
          () => null,
          (err: Error) => err,
        )
      : null;
    const current = projectBySlug(await deps.listProjects(), project.slug);
    const exists = (p: Planned) => current.tabs.some((t) => t.id === p.pane.id);
    if (failure && !fresh.some(exists)) {
      if (!(failure instanceof PaneOpenTimeout)) throw failure;
      lateReplyPending = true;
      void failure.late
        .then(() => whileProjectPanesFree(project.slug, () => assignLate(deps, project.slug, teamName, fresh, before, options)))
        .then((late) => introduce(deps, project.slug, teamName, late))
        .catch((err) => console.warn("[aya] team panes not given their roles after a late reply:", err))
        .finally(() => forget?.());
      throw new Error(`${failure.message}; nothing was assigned; if it still opens them, the new panes get their roles`);
    }
    const given = planned.filter(exists);
    const release = options.release ?? [];
    await assignWhileDefined(deps, current, teamName, [...given.map((p) => p.role), ...release], async () => {
      await e2eAssignDelay();
      for (const p of given) await assignRole(deps.teamHome, current, teamName, p.role, p.pane.id);
      for (const role of release) await assignRole(deps.teamHome, current, teamName, role, null);
    });
    const after = await rolesByPane(deps.teamHome, current);
    const stillPlays = new Set([...after.values()].map((p) => `${p.team}/${p.role}`));
    const leftWithoutPane = [...before.values()]
      .filter((p) => !stillPlays.has(`${p.team}/${p.role}`) && !(p.team === teamName && release.includes(p.role)))
      .map((p) => (p.team === teamName ? p.role : `${p.role} in team ${p.team}`));
    return { given, missed: planned.filter((p) => !exists(p)).map((p) => p.role), failure, leftWithoutPane };
  } finally {
    if (!lateReplyPending) forget?.();
  }
}

/** E2E only: saves the roles late, so the panes spawn before their roles are known. */
const e2eAssignDelay = () => new Promise((done) => setTimeout(done, Number(process.env.AYA_E2E_ASSIGN_DELAY_MS) || 0));

/** After a late reply: only the new panes the window added get their roles, if the picks still pass the check and each
 *  role still has the pane it had then. Open panes picked with them are left as they are. */
async function assignLate(
  deps: TeamPaneDeps,
  slug: string,
  teamName: string,
  fresh: Planned[],
  before: Map<string, { team: string; role: string }>,
  options: OpenPanesOptions,
): Promise<Planned[]> {
  const current = projectBySlug(await deps.listProjects(), slug);
  const arrived = fresh.filter((p) => current.tabs.some((t) => t.id === p.pane.id));
  if (!arrived.length) return [];
  const recheck = arrived.map((p) => ({ role: p.role, target: `${NEW_TARGET}${p.pane.presetId}` }));
  const { problems } = await check(deps, current, teamName, recheck, { ...options, release: [] });
  if (problems.length) throw new Error(problems.join("; "));
  const now = await openTeamStore(deps.teamHome, slug, teamName).assignments();
  const had = (role: string) => [...before].find(([, p]) => p.team === teamName && p.role === role)?.[0];
  const given = arrived.filter((p) => now[p.role] === had(p.role));
  await assignWhileDefined(deps, current, teamName, given.map((p) => p.role), async () => {
    for (const p of given) await assignRole(deps.teamHome, current, teamName, p.role, p.pane.id);
  });
  return given;
}

/** A save may have removed a role since the check; it cannot run while `assign` does. */
async function assignWhileDefined(
  deps: Pick<TeamPaneDeps, "teamHome">,
  project: ProjectConfig,
  teamName: string,
  roles: string[],
  assign: () => Promise<void>,
): Promise<void> {
  await whileTeamNotSaved(teamFile(project, teamName), async () => {
    const team = await loadTeam(teamName, openTeamStore(deps.teamHome, project.slug, teamName));
    const gone = roles.filter((role) => !team.roles.some((r) => r.id === role));
    if (gone.length) throw new Error(`${gone.join(", ")} was removed from team ${teamName} while its panes opened; nothing was assigned`);
    await assign();
  });
}

/** A new pane's host records how it was launched only after its spawn preflight (shell startup files run there):
 *  wait a window for the pane to reach the host, then up to three while the host reports it starting. */
async function launchBlockOnceRecorded(deps: TeamPaneDeps, paneId: string, isNew: boolean): Promise<string | null> {
  const window = deps.startWaitMs ?? PANE_START_WAIT_MS;
  const begun = Date.now();
  let spawned = false;
  for (;;) {
    const block = await deps.launchBlock(paneId);
    if (!isNew) return block;
    if (launchStarting(block)) spawned = true;
    // Once the host had the pane, a missing record is final: the spawn ended without one.
    else if (!launchPending(block) || (spawned && block === NO_LAUNCH_RECORD)) return block;
    if (Date.now() >= begun + window * (spawned ? SPAWN_WAIT_WINDOWS : 1)) return block;
    await nextPoll();
  }
}

/** In a running team, each pane is told its role once its agent has started. */
async function introduce(deps: TeamPaneDeps, slug: string, teamName: string, given: Planned[]): Promise<RolePane[]> {
  const { running } = await openTeamStore(deps.teamHome, slug, teamName).state();
  return Promise.all(
    given.map(async ({ role, target, pane }) => {
      const isNew = target.kind === "new";
      const hold = running ? await startedHold(deps, pane.id) : null;
      const notReached = running ? (hold ?? (await deps.introduce(slug, teamName, role))) : null;
      const cantReach = await launchBlockOnceRecorded(deps, pane.id, isNew);
      const note = await deps.launchNote(pane.id);
      const unsure = launchUnsure(cantReach, note);
      return { role, paneId: pane.id, name: pane.name, preset: isNew ? target.preset.name : null, notReached, cantReach, note, unsure };
    }),
  );
}

export function formatOpened(team: string, result: RolePanes, state: { running: boolean; paused: boolean }): string {
  const fresh = result.panes.filter((p) => p.preset).length;
  const lines = result.panes.map((p) => {
    const pane = `  ${p.role} -> ${p.preset ? "new " : ""}pane "${p.name}" (id ${p.paneId})`;
    const note = p.note ? `\n    ${p.note}` : "";
    if (!state.running) return `${pane}${p.cantReach ? `; ${p.cantReach}` : ""}${note}`;
    return `${pane}; ${p.notReached ? `not told its role: ${p.notReached}` : "told its role"}${note}`;
  });
  const roles = result.panes.length === 1 ? "1 role" : `${result.panes.length} roles`;
  const left = result.leftWithoutPane.length ? [`left without a pane: ${result.leftWithoutPane.join(", ")}`] : [];
  const tail = state.running ? [] : [state.paused ? "The team is paused; resume it in the Teams window." : "Start it in the Teams window, or ask me to."];
  return [`team ${team}: gave ${roles} a pane, ${fresh} new:`, ...lines, ...left, ...tail, ""].join("\n");
}

/** `callerPanes`: the panes the command may come from (the id it carries, the pane its process runs under). */
export async function handleTeamPanesRequest(
  request: TeamPanesRequest,
  callerId: string | undefined,
  deps: TeamPaneDeps,
  callerPanes: readonly string[] = callerId ? [callerId] : [],
): Promise<{ output: string }> {
  const project = await callerProject(await deps.listProjects(), callerId, request.type === "presets" ? {} : request);
  if (request.type === "presets") {
    const choices = await presetChoices(deps, project);
    return { output: request.json ? `${JSON.stringify(choices, null, 2)}\n` : formatPresets(choices) };
  }
  if (!project && callerId && deps.starting?.()) throw new TryAgainError(STARTING_MESSAGE);
  if (request.type === "team-start") {
    const task = request.task ? { text: request.task, to: request.to } : undefined;
    return { output: await startTeam(deps, project, request.team, task, callerPanes) };
  }
  if (!project) throw new Error("run aya team open in an Aya pane, or in the directory of a project open in Aya; nothing was opened");
  const result = await openTeamPanes(deps, project, request.team, request.panes, { replace: request.replace, callerId });
  const state = await openTeamStore(deps.teamHome, project.slug, request.team).state();
  return { output: formatOpened(request.team, result, state) };
}

/** `aya team start`: the Teams window's Start, refused for a team already running. From a pane of one of the
 *  team's roles it is that role's: it gives no work to a running team and resumes only a pause of its own. */
async function startTeam(deps: TeamPaneDeps, project: ProjectConfig | null, name: string, task: { text: string; to?: string } | undefined, callerPanes: readonly string[]): Promise<string> {
  if (!project) throw new Error("run aya team start in an Aya pane, or in the directory of a project open in Aya; nothing was sent");
  const names = await runnableTeamNames(deps.teamHome, project);
  if (!names.includes(name)) throw new Error(`no team "${name}" in this project; its teams: ${names.join(", ") || "none"}; nothing was sent`);
  const assignments = await openTeamStore(deps.teamHome, project.slug, name).assignments();
  const by = Object.entries(assignments).find(([, pane]) => callerPanes.includes(pane))?.[0];
  const result = await deps.start(project.slug, name, task, by);
  if (result.alreadyRunning) throw new Error(by ? `team ${name}: the team is running; use aya team send to give a role work; nothing was sent` : `team ${name} is already running; nothing was sent`);
  if (result.refused) throw new Error(`team ${name}: ${result.refused}`);
  const held = result.held.map((h) => `${h.role}: ${h.reason}`).join("; ");
  if (!result.started) {
    const refusal = `team ${name} was not started, nothing was sent; ${held}`;
    throw deps.starting?.() ? new TryAgainError(`${STARTING_MESSAGE} (${refusal})`) : new Error(refusal);
  }
  const where = (t: NonNullable<TeamStartResult["task"]>) => (t.afterEnter ? "was" : t.typedOnly ? "is typed in its composer, Enter withheld:" : "waits in its inbox:");
  const given = result.task ? (result.task.held ? `; task for ${result.task.to} ${where(result.task)} ${result.task.held}` : `; task sent to ${result.task.to}`) : "";
  return `started team ${name}; delivery test written to ${result.delivered.join(", ") || "no role"}${held ? `; not written to ${held}` : ""}${given}\n`;
}

/** How long a window's reply is still acted on after its deadline. */
const LATE_REPLY_MS = 60_000;

/** The window missed the deadline; `late` settles with its reply, if one comes. */
export class PaneOpenTimeout extends Error {
  constructor(readonly late: Promise<void>) {
    super("the Aya window did not open the panes in time");
  }
}

/** Main's requests to a window, each settled by the window's answer or its deadline. */
export class RendererRequests {
  private pending = new Map<string, (error: string | null) => void>();

  ask(send: (requestId: string) => void, timeoutMs = PANE_OPEN_TIMEOUT_MS): Promise<void> {
    const requestId = randomUUID();
    let settleLate: (error: string | null) => void = () => {};
    const late = new Promise<void>((resolve, reject) => (settleLate = (error) => (error ? reject(new Error(error)) : resolve())));
    late.catch(() => {});
    return new Promise<void>((resolve, reject) => {
      let timedOut = false;
      const settle = (error: string | null) => {
        clearTimeout(timer);
        this.pending.delete(requestId);
        if (timedOut) settleLate(error);
        else if (error) reject(new Error(error));
        else resolve();
      };
      let timer = setTimeout(() => {
        timedOut = true;
        reject(new PaneOpenTimeout(late));
        timer = setTimeout(() => settle("the Aya window never answered"), LATE_REPLY_MS);
        timer.unref();
      }, timeoutMs);
      this.pending.set(requestId, settle);
      send(requestId);
    });
  }
  answer(requestId: string, error: unknown): void {
    this.pending.get(requestId)?.(typeof error === "string" && error ? error : null);
  }
}

/** The window side of PaneHost.openPanes; Electron's BrowserWindow in main. */
export interface PaneWindow {
  isDestroyed(): boolean;
  webContents: { isLoading(): boolean; send(channel: string, request: TeamOpenPanesRequest): void };
}

/** Asks the project's window to add the panes. A window still loading, or none with the project at boot, is refused at
 *  once as retryable, not after the deadline. */
export function askWindowToOpenPanes(win: PaneWindow | null, requests: RendererRequests, projectSlug: string, panes: NewPane[], starting = false): Promise<void> {
  if (!win || win.isDestroyed()) {
    return Promise.reject(starting ? new TryAgainError(STARTING_MESSAGE) : new Error(`project ${projectSlug} is not open in an Aya window`));
  }
  if (win.webContents.isLoading()) {
    return Promise.reject(new TryAgainError(`the Aya window of project ${projectSlug} is still loading; run it again in a moment`));
  }
  return requests.ask((requestId) => win.webContents.send("teams:open-panes", { requestId, projectSlug, panes }));
}
