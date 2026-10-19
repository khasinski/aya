// What a fresh pane is told at launch (aya brief, role note), recorded so the
// Teams window can say when a role changed since.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  briefText,
  codexHomeFor,
  opencodeConfigJson,
  roleChannel,
  type RoleChannel,
  roleNoteStatus,
  teamNote,
  withRoleNote,
} from "./agent-brief";
import { writeFileAtomic } from "./atomic-write";
import { oneAtATime } from "./keyed-queue";
import { isShellCommand } from "./pane-command";
import { CODEX_CONFIG_FILENAME } from "./usage-codex";
import { userShell } from "./shell";
import { presetAgent } from "./team-panes";
import { paneTeamRole } from "./team-files";
import type { Preset } from "./presets";
import type { ProjectConfig, SpawnRequest, WorkingTab } from "./types";

export interface RoleRef {
  team: string;
  role: string;
}

/** What a pane's CLI was told when it started: the role it played, and whether
 *  the note reached it. */
export interface Launch {
  role: RoleRef | null;
  carried: boolean;
  /** Digest of the text the CLI was given; absent in older records. */
  told?: string;
  /** A resumed session whose first start was never recorded. */
  unknown?: true;
}

export interface LaunchRecords {
  get: (ptyId: string) => Promise<Launch | undefined>;
  set: (ptyId: string, launch: Launch) => Promise<void>;
  ids: () => Promise<string[]>;
  prune: (live: Set<string>) => Promise<void>;
}

export interface PaneBriefDeps {
  ayaHome: string;
  defaultCodexHome: string;
  expand: (p: string) => string;
  /** The user's login-shell environment, null when the shell did not answer. */
  shellEnv: () => Promise<Record<string, string> | null>;
  listPresets: () => Promise<Preset[]>;
  paneRole: (spawn: SpawnRequest) => Promise<RoleRef | null>;
  records: LaunchRecords;
  /** Whether this spawn request will start a process (not replay or attach to a live pane). */
  starts: (spawn: SpawnRequest) => Promise<boolean>;
  running: (ptyId: string) => Promise<boolean>;
}

export interface PaneBriefWiringDeps extends Omit<PaneBriefDeps, "shellEnv" | "paneRole" | "records"> {
  listProjects: () => Promise<ProjectConfig[]>;
  recordsFile: string;
}

export function createPaneBriefDeps(deps: PaneBriefWiringDeps): {
  paneBriefDeps: PaneBriefDeps;
  expectRoles: (roles: { ptyId: string; team: string; role: string }[]) => () => void;
} {
  /** Roles of panes that `team open` is about to open: they spawn before the role is saved. */
  const pendingPaneRoles = new Map<string, RoleRef>();
  const paneBriefDeps: PaneBriefDeps = {
    ayaHome: deps.ayaHome,
    defaultCodexHome: deps.defaultCodexHome,
    expand: deps.expand,
    shellEnv: loginShellEnv,
    listPresets: deps.listPresets,
    paneRole: async (spawn) => {
      const pending = pendingPaneRoles.get(spawn.ptyId);
      if (pending) return pending;
      const project = (await deps.listProjects()).find((p) => p.slug === spawn.projectSlug);
      return project ? paneTeamRole(deps.ayaHome, project, spawn.ptyId) : null;
    },
    records: fileLaunchRecords(deps.recordsFile),
    starts: deps.starts,
    running: deps.running,
  };
  return {
    paneBriefDeps,
    expectRoles: (roles) => {
      for (const { ptyId, team, role } of roles) pendingPaneRoles.set(ptyId, { team, role });
      return () => roles.forEach(({ ptyId }) => pendingPaneRoles.delete(ptyId));
    },
  };
}

// rc files run after Aya's own environment is fixed, so process.env cannot say what a pane sees.
const ENV_BEGIN = "__AYA_ENV_BEGIN__";
const ENV_END = "__AYA_ENV_END__";
/** How long a login shell may take to print its env; a pane waits that long once. */
export const LOGIN_ENV_TIMEOUT = { ms: 20_000 };

export function parseEnvProbe(stdout: string): Record<string, string> | null {
  const begin = stdout.indexOf(ENV_BEGIN);
  const end = stdout.indexOf(ENV_END, begin + ENV_BEGIN.length);
  const payload = begin === -1 || end === -1 ? "" : stdout.slice(begin + ENV_BEGIN.length, end);
  if (!payload) return null;
  const entries = payload.split("\0").filter((e) => e.includes("="));
  return Object.fromEntries(entries.map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]));
}

// `env` prints alike in every shell; a leading "-" in argv0 makes any one a login shell (csh takes no -l with -c).
// Our own timer: a killed shell's children (a sleeping rc) would hold the pipe open.
function probeLoginEnv(): Promise<Record<string, string> | null> {
  const shell = userShell();
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(shell, ["-i", "-c", `printf '%s' '${ENV_BEGIN}'; env -0; printf '%s' '${ENV_END}'`], {
      argv0: `-${path.basename(shell)}`,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const giveUp = setTimeout(() => (child.kill("SIGKILL"), child.stdout.destroy(), resolve(null)), LOGIN_ENV_TIMEOUT.ms);
    const done = (env: Record<string, string> | null) => (clearTimeout(giveUp), resolve(env));
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
    child.on("error", () => done(null));
    child.on("close", () => done(parseEnvProbe(out)));
  });
}

let loginEnv: Promise<Record<string, string> | null> | null = null;

/** Asked once per app session and shared by the calls made meanwhile; a failure is asked again. */
export function loginShellEnv(): Promise<Record<string, string> | null> {
  if (loginEnv) return loginEnv;
  const asked = (loginEnv = probeLoginEnv());
  void asked.then((env) => void (env === null && loginEnv === asked && (loginEnv = null)));
  return asked;
}

/** For tests: the next call asks the shell again. */
export const forgetLoginShellEnv = () => void (loginEnv = null);

/** Records in one JSON file; writes go one after another. A file that does not
 *  parse to an object is set aside on the next write, and never pruned. */
export function fileLaunchRecords(file: string): LaunchRecords {
  const inTurn = oneAtATime();
  const read = async (): Promise<Record<string, Launch> | null> => {
    try {
      const all = JSON.parse(await fs.readFile(file, "utf8").catch(() => "{}"));
      return all && typeof all === "object" && !Array.isArray(all) ? all : null;
    } catch {
      return null;
    }
  };
  const change = (fn: (all: Record<string, Launch>) => void, keepUnreadable = false): Promise<void> => {
    return inTurn(file, async () => {
      let all = await read();
      if (!all) {
        if (keepUnreadable) return;
        await fs.rename(file, `${file}.corrupt`);
        all = {};
      }
      fn(all);
      await writeFileAtomic(file, `${JSON.stringify(all, null, 2)}\n`);
    });
  };
  const settled = async () => (await inTurn(file, read)) ?? {};
  return {
    get: async (id) => (await settled())[id],
    ids: async () => Object.keys(await settled()),
    set: (id, launch) => change((all) => void (all[id] = launch)),
    prune: (live) => change((all) => void Object.keys(all).filter((id) => !live.has(id)).forEach((id) => delete all[id]), true),
  };
}

/** A pane's note and the opencode config that lists it. */
const BRIEF_EXTS = [".md", ".json"];
const briefsDir = (ayaHome: string) => path.join(ayaHome, "pane-briefs");
/** Hex chars of the hash of the whole pane id that name its files, so no two panes share one; files on disk carry it. */
const PANE_BRIEF_NAME_HEX_CHARS = 24;
const paneBriefBase = (ayaHome: string, ptyId: string) =>
  path.join(briefsDir(ayaHome), createHash("sha256").update(ptyId).digest("hex").slice(0, PANE_BRIEF_NAME_HEX_CHARS));

async function writePrivate(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFileAtomic(file, text, 0o600);
}

export async function removePaneBrief(ayaHome: string, ptyId: string): Promise<void> {
  const base = paneBriefBase(ayaHome, ptyId);
  await Promise.all(BRIEF_EXTS.map((ext) => fs.rm(base + ext, { force: true })));
}

/** At startup: files and records of panes that no project has any more and the
 *  host does not hold (a project list can come back empty or short). */
export async function sweepPaneBriefs(deps: PaneBriefDeps, projects: ProjectConfig[]): Promise<void> {
  const live = new Set(projects.flatMap((p) => p.tabs.map((t) => t.id)));
  for (const id of await deps.records.ids()) if (!live.has(id) && (await deps.running(id))) live.add(id);
  const keep = new Set([...live].flatMap((id) => BRIEF_EXTS.map((ext) => path.basename(paneBriefBase(deps.ayaHome, id)) + ext)));
  const files = await fs.readdir(briefsDir(deps.ayaHome)).catch(() => [] as string[]);
  await Promise.all(files.filter((f) => !keep.has(f)).map((f) => fs.rm(path.join(briefsDir(deps.ayaHome), f), { force: true })));
  await deps.records.prune(live);
}

async function userEnvConfig(channel: Extract<RoleChannel, { kind: "env" }>, deps: PaneBriefDeps) {
  const env = await deps.shellEnv();
  return env ? { userConfig: env[channel.name] || undefined, userConfigContent: env[channel.inline] || undefined } : { userConfig: null };
}

async function codexConfigText(deps: PaneBriefDeps, preset: Preset, cwd?: string): Promise<string | undefined> {
  const home = codexHomeFor(preset, deps.defaultCodexHome, deps.expand, cwd);
  return home ? fs.readFile(path.join(home, CODEX_CONFIG_FILENAME), "utf8").catch(() => undefined) : undefined;
}

async function rolePlan(agent: string | undefined, command: string, text: string, noteFile: string, preset: Preset, cwd: string | undefined, deps: PaneBriefDeps) {
  const channel = roleChannel(agent);
  return withRoleNote(agent, command, text, {
    noteFile,
    ...(channel.kind === "env" ? await userEnvConfig(channel, deps) : {}),
    ...(channel.kind === "config" ? { codexConfig: await codexConfigText(deps, preset, cwd) } : {}),
  });
}

/** A team pane on the main CLIs always takes the brief, whatever its preset says (user decision 2026-10-03);
 *  the other CLIs follow the preset, so nothing changes for them. */
const TEAM_BRIEF_AGENTS: ReadonlySet<string> = new Set(["claude", "codex"]);
const briefOn = (preset: Preset, agent: string | undefined, role: RoleRef | null) =>
  !!preset.agentBrief || (!!role && TEAM_BRIEF_AGENTS.has(agent ?? ""));

function carriedText(withBrief: boolean, role: RoleRef | null): string {
  return [withBrief ? briefText(false) : null, role ? teamNote(role.team, role.role) : null].filter(Boolean).join("\n\n");
}
/** Hex chars of a `told` digest; records on disk carry it, so another length flags every pane as told an older brief. */
export const TOLD_DIGEST_HEX_CHARS = 12;
const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, TOLD_DIGEST_HEX_CHARS);

const sameRole = (a: RoleRef | null, b: RoleRef | null) => a?.team === b?.team && a?.role === b?.role;

/** Why a pane on this preset cannot be told its role, else null: the same
 *  check the spawn runs. */
async function capabilityGap(tab: WorkingTab, preset: Preset, deps: PaneBriefDeps): Promise<string | null> {
  const plan = await rolePlan(presetAgent(preset), preset.command, "-", paneBriefBase(deps.ayaHome, tab.id) + ".json", preset, tab.cwd, deps);
  return "problem" in plan ? roleNoteStatus(plan.problem) : null;
}

/** What the window says about a role's pane, and whether restarting the pane (it resumes) gives it the role. */
interface RoleNoteGap {
  text: string;
  /** False for a CLI that cannot be told the role, and for Codex, whose resumed session keeps its first note. */
  restartFixes: boolean;
}

/** What the team knows of a pane: whether the team runs, and the role of the team the pane last read with whoami. */
export interface RoleNoteContext {
  running: boolean;
  read: string | null;
}

/** What the window says about a role's pane, as the one thing the user can do about it, else null. A pane that
 *  started with another role needs nothing once it has read this role with whoami (Aya's delivery test asks it to,
 *  at Start or when it is given the role in a running team); until then the window says so. Without a context the
 *  pane counts as having read it. */
async function roleNoteState(tab: WorkingTab, current: RoleRef, deps: PaneBriefDeps, context?: RoleNoteContext): Promise<RoleNoteGap | null> {
  const preset = (await deps.listPresets()).find((p) => p.id === tab.presetId);
  // A shell pane already shows "runs a shell" as its hold.
  if (!preset || isShellCommand(preset.command)) return null;
  const launch = await deps.records.get(tab.id);
  const codex = presetAgent(preset) === "codex";
  // The window offers Restart where a restart gives the role (the pane resumes with it). A Codex restart resumes the
  // session with what it was told first, so there only a new session starts afresh.
  const how = codex ? "pick a new session for this role in its pane list" : "click Restart";
  // A restart respawns with the preset as it is now: where that preset cannot carry the role (edited since), the window
  // says why instead of promising what a restart would not give.
  const fix = async (text: string) => {
    const gap = await capabilityGap(tab, preset, deps);
    return gap === null ? { text, restartFixes: !codex } : { text: gap, restartFixes: false };
  };
  const cannot = (text: string | null) => (text === null ? null : { text, restartFixes: false });
  const unknown = `Aya cannot tell whether this agent got its role when it started. To be sure, ${how}.`;
  if (!launch) return cannot(await capabilityGap(tab, preset, deps)) ?? ((await deps.running(tab.id)) ? fix(unknown) : null);
  if (launch.unknown) return cannot(await capabilityGap(tab, preset, deps)) ?? fix(unknown);
  if (launch.carried && sameRole(launch.role, current)) {
    const now = digest(carriedText(briefOn(preset, presetAgent(preset), current), current));
    return launch.told && launch.told !== now ? fix(`This agent started with older instructions from Aya. To give it the current ones, ${how}.`) : null;
  }
  if (launch.carried && launch.role) {
    if (!context || context.read === current.role) return null;
    // Stopped or paused: the next Start tells it. Running: a held delivery test is not typed again, so the window
    // says what to do if the pane never reads the role.
    if (!context.running) return { text: `This agent started as ${launch.role.role}. Aya tells it this role at the next Start.`, restartFixes: false };
    return fix(`This agent started as ${launch.role.role} and has not read this role yet. If that stays, ${how}.`);
  }
  return cannot(await capabilityGap(tab, preset, deps)) ?? fix(`This agent started before it had this role and can lose it in a long session. To keep it, ${how}.`);
}

/** What the window says about a role's pane, else null. */
export async function roleNoteGap(tab: WorkingTab, current: RoleRef, deps: PaneBriefDeps, context?: RoleNoteContext): Promise<string | null> {
  return (await roleNoteState(tab, current, deps, context))?.text ?? null;
}

interface RoleNoteReport {
  roleNotes: Record<string, string | null>;
  /** Roles whose note a restart of their pane gives: the Teams window offers Restart there. */
  restartable: string[];
  /** Panes that started with a role of this team that they no longer play. */
  staleNotes: string[];
}

export async function roleNoteReport(
  project: ProjectConfig,
  team: string,
  assignments: Record<string, string>,
  deps: PaneBriefDeps,
  teamState?: { running: boolean; read: Record<string, string> },
): Promise<RoleNoteReport> {
  const assigned = new Set(Object.values(assignments));
  const roleNotes: Record<string, string | null> = {};
  const restartable: string[] = [];
  for (const [role, pane] of Object.entries(assignments)) {
    const tab = project.tabs.find((t) => t.id === pane);
    if (!tab) continue;
    const gap = await roleNoteState(tab, { team, role }, deps, teamState && { running: teamState.running, read: teamState.read[pane] ?? null });
    roleNotes[role] = gap?.text ?? null;
    if (gap?.restartFixes) restartable.push(role);
  }
  const staleNotes: string[] = [];
  const presets = await deps.listPresets();
  for (const tab of project.tabs) {
    const launch = assigned.has(tab.id) ? undefined : await deps.records.get(tab.id);
    if (launch?.carried && launch.role?.team === team) {
      const preset = presets.find((p) => p.id === tab.presetId);
      const how = preset && presetAgent(preset) === "codex" ? "close it and open a new session" : "right-click it and choose Restart";
      staleNotes.push(`${tab.name} still works as ${launch.role.role} from when it started. To clear that, ${how}.`);
    }
  }
  return { roleNotes, restartable, staleNotes };
}

/** The brief (preset opted in, or a claude/codex team pane) and a team pane's role note, for a fresh pane.
 *  Shared harness files take the brief only, never a per-pane note. */
export async function withAgentBrief(spawn: SpawnRequest, deps: PaneBriefDeps): Promise<SpawnRequest> {
  if (!spawn.presetId || !(await deps.starts(spawn))) return spawn;
  const preset = (await deps.listPresets()).find((p) => p.id === spawn.presetId);
  if (!preset) return spawn;
  const role = await deps.paneRole(spawn);
  const agent = spawn.agent ?? preset.agent;
  const { spawn: out, carried } = await brief(spawn, preset, agent, role, deps);
  const told = carried ? digest(carriedText(briefOn(preset, agent, role), role)) : undefined;
  await recordLaunch(spawn, agent, { role, carried, ...(told && { told }) }, deps).catch((err) =>
    console.warn("[aya] could not record what the pane was told:", err),
  );
  return out;
}

/** A bare `resume` word; the program may be a wrapper, so only quoted text is set aside. */
const codexResumes = (command: string) => /(^|\s)resume(\s|$)/.test(command.replace(/"[^"]*"|'[^']*'/g, " "));

/** A resumed codex session keeps the note of its first start, so the record
 *  stays; with no record, what it was told is unknown. */
async function recordLaunch(spawn: SpawnRequest, agent: string | undefined, launch: Launch, deps: PaneBriefDeps) {
  const resumed = agent === "codex" && codexResumes(spawn.command);
  if (!resumed) return deps.records.set(spawn.ptyId, launch);
  if (!(await deps.records.get(spawn.ptyId))) await deps.records.set(spawn.ptyId, { role: null, carried: false, unknown: true });
}

async function brief(
  spawn: SpawnRequest,
  preset: Preset,
  agent: string | undefined,
  role: RoleRef | null,
  deps: PaneBriefDeps,
): Promise<{ spawn: SpawnRequest; carried: boolean }> {
  const plain = { spawn, carried: false };
  const channel = roleChannel(agent);
  const withBrief = briefOn(preset, agent, role);
  if ((!withBrief && !role) || channel.kind === "none") return plain;
  const skipped = (why: string) => (console.warn(`[aya] aya brief skipped for preset ${preset.id}: ${why}`), plain);
  const text = carriedText(withBrief, role);
  const base = role ? paneBriefBase(deps.ayaHome, spawn.ptyId) : path.join(deps.ayaHome, "agent-brief");
  const plan = await rolePlan(agent, spawn.command, text, `${base}.json`, preset, spawn.cwd, deps);
  if ("problem" in plan) return skipped(plan.problem);
  if (channel.kind === "env") {
    try {
      await writePrivate(`${base}.md`, `${text}\n`);
      await writePrivate(`${base}.json`, opencodeConfigJson(`${base}.md`));
    } catch (err) {
      console.warn(`[aya] could not write ${base}.md:`, err);
      return plain;
    }
  }
  return { spawn: { ...spawn, command: plan.command }, carried: true };
}
