// Leaving a CLI stops the background tasks and monitors its session ran ("1 monitor couldn't be moved and was
// stopped"): a restart Aya makes on purpose warns first, and tells a team agent resumed after it to start them again.
// It also cuts off an agent's turn and a shell's running command (#217), which the warning names too.

import { promises as fs } from "node:fs";
import { writeFileAtomic } from "./atomic-write";
import { oneAtATime } from "./keyed-queue";
import type { AgentKind } from "./presets";
import { typeFromAya, type TeamControlDeps } from "./team-control";
import { TEAM_SYSTEM_SENDER } from "./team-definition";
import { runnableTeamNames } from "./team-files";
import { openTeamStore } from "./team-store";
import { printable } from "./printable";

export const RELAUNCH_NOTE = "Aya restarted this pane; background tasks and monitors you had are gone; start again the ones you still need.";
/** A pane that never comes back (closed, left stopped) drops its note after this. */
export const RELAUNCH_NOTE_TTL_MS = 24 * 60 * 60 * 1000;

// Claude Code 2.1.289 draws its running tasks as one pill in the footer under its composer (bundle function RAe):
// "1 shell", "2 shells, 1 monitor", "3 background tasks", "1 local agent". Read from the bundle, not recorded.
const CLAUDE_TASKS = /\b\d+ (?:shells?|monitors?|background tasks?|local agents?|background dynamic workflows?|MCP tasks?|Artifact comment monitors?)\b/g;
const CLAUDE_RULE = /^\s*─{8,}\s*$/;
// codex-cli 0.160.0 bottom pane (tui/src/bottom_pane): "... background terminal ... running · /ps to view · /stop to
// close". The count's exact wording is not in the binary as one string, so the /ps hint anchors it. Not recorded.
const CODEX_TERMINALS = /\/ps to view\b/;
const CODEX_COUNT = /\b(\d+) background terminals?\b/;
const TAIL_LINES = 12;

/** What the pane's screen shows running in the background that a restart stops, e.g. "1 monitor"; null for none. */
export function backgroundWorkShown(screen: string, agent: AgentKind | undefined): string | null {
  const lines = screen.split("\n");
  if (agent === "claude") {
    // Only the footer under the composer's last rule: the same words in the transcript are the agent's prose.
    let rule = lines.length - 1;
    while (rule >= 0 && !CLAUDE_RULE.test(lines[rule])) rule -= 1;
    if (rule < 0) return null;
    const found = lines.slice(rule + 1).join("\n").match(CLAUDE_TASKS);
    return found ? [...new Set(found)].join(", ") : null;
  }
  if (agent === "codex") {
    const tail = lines.filter((l) => l.trim()).slice(-TAIL_LINES).join("\n");
    if (!CODEX_TERMINALS.test(tail)) return null;
    return CODEX_COUNT.exec(tail)?.[0] ?? "background terminals";
  }
  return null;
}

// The resume each CLI is relaunched with (src/agentPreset.ts); --session-id starts a new conversation.
const RESUMED: Partial<Record<AgentKind, RegExp>> = {
  claude: /(?:^|\s)(?:-c|--continue|-r|--resume)(?:[=\s]|$)/,
  codex: /(?:^|\s)resume(?:\s|$)/,
};

export interface PaneWork {
  id: string;
  name: string;
  /** What a restart stops there, as the warning names it: "mid-turn, 1 monitor", "running npm run dev". */
  work: string;
  /** The agent is mid-turn. */
  turn?: boolean;
  /** A shell runs a command in the foreground. */
  command?: boolean;
  /** Background tasks the screen shows: a resumed team agent is told to start them again. */
  background?: boolean;
}

export interface RelaunchDeps {
  disconnected?: (id: string) => Promise<boolean>;
  /** Where the notes wait for the relaunch; it outlives Aya's own restart. */
  file: string;
  /** The panes a restart of `ids` (all when absent) stops, with their names. */
  panes: (ids?: readonly string[]) => Promise<{ id: string; name: string }[]>;
  agentOf: (id: string) => Promise<AgentKind | undefined>;
  /** The pane's rendered text, null when it is not running. */
  screen: (id: string) => Promise<string | null>;
  /** The pane's process: null when none, undefined when the host cannot say. */
  pid: (id: string) => Promise<number | null | undefined>;
  /** The command the pane runs now, null when not known. */
  command: (id: string) => Promise<string | null>;
  /** Whether the pane's agent is mid-turn; false when the host cannot say. */
  busy: (id: string) => Promise<boolean>;
  /** The command a shell pane runs in the foreground, null at its prompt or when not known. */
  foreground: (id: string) => Promise<string | null>;
  now?: () => number;
}

interface Note {
  pid: number | null;
  work: string;
  at: number;
  /** Only the user's yes to stopping a turn or a command, kept so the next restart of that process does not ask again;
   *  there is nothing to tell the agent. */
  quiet?: true;
}

async function readNotes(file: string): Promise<Record<string, Note>> {
  try {
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, Note>;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

// Read-modify-writes of one file in turn: a restart noted while a pass types must not be lost to the pass's write.
const serial = oneAtATime();

function changeNotes(file: string, change: (notes: Record<string, Note>) => void): Promise<void> {
  return serial(file, async () => {
    const notes = await readNotes(file);
    change(notes);
    await writeFileAtomic(file, JSON.stringify(notes));
  });
}

/** What a restart of the running pane stops now: the agent's turn and its background tasks, or a shell's command. */
async function paneWork(deps: RelaunchDeps, id: string, name: string, screen: string): Promise<PaneWork | null> {
  const agent = await deps.agentOf(id);
  const background = backgroundWorkShown(screen, agent);
  // "custom" is a shell, a script or a CLI Aya has no rules for: only what it runs in the foreground can be read.
  const known = agent !== undefined && agent !== "custom";
  const turn = known && (await deps.busy(id).catch(() => false));
  const command = known ? null : await deps.foreground(id).catch(() => null);
  const work = [turn && "mid-turn", command !== null && `running ${command}`, background].filter((w): w is string => !!w);
  if (!work.length) return null;
  return { id, name, work: work.join(", "), turn, command: command !== null, background: background !== null };
}

/** The panes among `ids` (all when absent) whose restart would stop work now. */
export async function restartWorkOf(deps: RelaunchDeps, ids?: readonly string[]): Promise<PaneWork[]> {
  const out: PaneWork[] = [];
  for (const { id, name } of await deps.panes(ids)) {
    if (await deps.disconnected?.(id)) { out.push({ id, name, work: "disconnected, with a process that may still be running" }); continue; }
    const screen = await deps.screen(id).catch(() => null);
    const work = screen === null ? null : await paneWork(deps, id, name, screen);
    if (work) out.push(work);
  }
  return out;
}

/** The panes whose screen shows background work now, which an ordinary quit's update waits for; null when a pane that
 *  runs (or may run) cannot be read: its work is unknown. A turn or a command is asked about when the host restarts. */
export async function backgroundWorkKnown(deps: RelaunchDeps): Promise<PaneWork[] | null> {
  const out: PaneWork[] = [];
  for (const { id, name } of await deps.panes()) {
    const screen = await deps.screen(id).catch(() => null);
    if (screen === null) {
      if ((await deps.pid(id).catch(() => undefined)) !== null) return null;
      continue;
    }
    const work = backgroundWorkShown(screen, await deps.agentOf(id));
    if (work) out.push({ id, name, work, background: true });
  }
  return out;
}

/** The warning before a restart that stops `work`; `action` names the restart. */
export function restartWarning(action: string, work: readonly PaneWork[]): string {
  // Keep the native dialog small even with many panes or long command lines.
  const limit = 5;
  const compact = (text: string) => {
    const value = printable(text).replace(/\s+/g, " ").trim();
    return value.length > 100 ? `${value.slice(0, 99)}…` : value;
  };
  const entries = work.slice(0, limit).map((w) => compact(`${w.name}: ${w.work}`));
  if (work.length > limit) entries.push(`and ${work.length - limit} more panes`);
  const shown = entries.join("; ");
  return [
    `${action} stops what these panes are doing (${shown}).`,
    work.some((w) => w.turn) && "An agent mid-turn stops before its turn ends.",
    work.some((w) => w.command) && "A command running in a shell stops.",
    work.some((w) => w.background) &&
      "An agent cannot carry its background tasks into the new process; Aya tells a team agent resumed afterwards to start again the ones it still needs.",
  ].filter(Boolean).join(" ");
}

/** Remembers the panes in `work` for a note once each comes back as a new process. */
export async function noteRelaunch(deps: RelaunchDeps, work: readonly PaneWork[]): Promise<void> {
  if (!work.length) return;
  const at = (deps.now ?? Date.now)();
  const pids = await Promise.all(work.map(async (w) => (await deps.pid(w.id).catch(() => undefined)) ?? null));
  // A command line can carry a password or a token: the note on disk does not repeat it.
  const noted = (w: PaneWork) => (w.command ? "running a command" : w.work);
  await changeNotes(deps.file, (notes) =>
    work.forEach((w, i) => (notes[w.id] = w.background ? { pid: pids[i], work: noted(w), at } : { pid: pids[i], work: noted(w), at, quiet: true })),
  );
}

/** Asks before a restart of `ids` (all when absent) only when it would stop work in one; a yes keeps the notes. */
export async function confirmRestart(deps: RelaunchDeps, action: string, ask: (text: string) => Promise<boolean>, ids?: readonly string[]): Promise<boolean> {
  const work = await restartWorkOf(deps, ids);
  if (!work.length) return true;
  if (!(await ask(restartWarning(action, work)))) return false;
  await noteRelaunch(deps, work);
  return true;
}

/** Planned migration must also ask about an idle process that cannot move.
 * Existing detailed work text and quiet PID notes stay the #219 contract. */
export async function confirmStoppingProcesses(deps:RelaunchDeps,action:string,ask:(text:string)=>Promise<boolean>,ids?:readonly string[]):Promise<boolean> {
  const panes=await deps.panes(ids),known=await restartWorkOf(deps,ids).catch(()=>[]);
  const work:PaneWork[]=[];
  const selected=ids??panes.map(p=>p.id);
  for(const id of selected){
    if(await deps.pid(id).catch(()=>undefined)===null)continue;
    work.push(known.find(p=>p.id===id)??{id,name:panes.find(p=>p.id===id)?.name??id,work:"a running process"});
  }
  if(!work.length)return true;
  if(!await ask(restartWarning(action,work)))return false;
  await noteRelaunch(deps,work);return true;
}

/** The question before restarting one pane, `name`. When what it runs cannot be checked, the user still decides: asked
 *  plainly, with the reason, rather than restarted without a word or silently not restarted. */
export async function confirmPaneRestart(
  confirm: () => Promise<boolean>,
  ask: (text: string) => Promise<boolean>,
  name: string,
): Promise<boolean> {
  try {
    return await confirm();
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return ask(`Aya could not check what ${name} is doing (${why}). Restarting it stops anything it runs: a turn, a command or background tasks.`);
  }
}

/** Same-process consent survives Restart to update; forced legacy/native
 * migration must not ask twice when every process was already acknowledged. */
export async function currentProcessesConfirmed(deps: RelaunchDeps, count: number): Promise<boolean> {
  if (count <= 0) return false;
  const notes = await readNotes(deps.file);
  let confirmed = 0;
  for (const pane of await deps.panes()) {
    const pid = await deps.pid(pane.id);
    if (pid === null) continue;
    if (pid === undefined || notes[pane.id]?.pid !== pid) return false;
    confirmed++;
  }
  return confirmed >= count;
}

/** As confirmRestart, but a pane whose work the user already agreed to stop for its current process (a note left by
 *  Restart to update, its pane not relaunched yet) is not asked about again. */
export async function confirmRestartOnce(deps: RelaunchDeps, action: string, ask: (text: string) => Promise<boolean>): Promise<boolean> {
  const work = await restartWorkOf(deps);
  const notes = await readNotes(deps.file);
  const pids = await Promise.all(work.map(async (w) => (await deps.pid(w.id).catch(() => undefined)) ?? null));
  const unasked = work.filter((w, i) => notes[w.id]?.pid !== pids[i] || pids[i] === null);
  if (unasked.length && !(await ask(restartWarning(action, unasked)))) return false;
  await noteRelaunch(deps, unasked);
  return true;
}

async function roleOfPane(team: TeamControlDeps, paneId: string) {
  for (const project of await team.listProjects()) {
    for (const name of await runnableTeamNames(team.teamHome, project)) {
      const store = openTeamStore(team.teamHome, project.slug, name);
      const role = await store.roleOf(paneId);
      if (role) return { project, store, name, role };
    }
  }
  return null;
}

/** Types the note into each noted pane that runs a new, resumed process and plays a role, as a message from Aya;
 *  a pane still starting or held keeps its note for the next pass. Returns how many were typed. */
export async function deliverRelaunchNotes(team: TeamControlDeps, deps: RelaunchDeps): Promise<number> {
  const notes = await readNotes(deps.file);
  const now = (deps.now ?? Date.now)();
  const done: [string, number][] = [];
  let typed = 0;
  for (const [id, note] of Object.entries(notes)) {
    if (now - note.at > RELAUNCH_NOTE_TTL_MS) {
      done.push([id, note.at]);
      continue;
    }
    const pid = await deps.pid(id).catch(() => undefined);
    // Not running yet, the host cannot say, or still the process the work ran in.
    if (pid === null || pid === undefined || pid === note.pid) continue;
    if (note.quiet) {
      done.push([id, note.at]);
      continue;
    }
    const agent = await deps.agentOf(id);
    const resumed = agent && RESUMED[agent];
    const command = await deps.command(id);
    const where = resumed && command !== null && resumed.test(command) ? await roleOfPane(team, id) : null;
    // A new conversation has no tasks to miss, and a pane outside a team has no inbox to hold the note.
    if (!where) {
      done.push([id, note.at]);
      continue;
    }
    if ((await where.store.state()).paused) continue;
    const message = { team: where.name, from: TEAM_SYSTEM_SENDER, to: where.role, text: RELAUNCH_NOTE };
    const sent = await typeFromAya(team, where.project, where.store, message).catch(() => null);
    if (!sent?.entry) continue;
    typed += 1;
    done.push([id, note.at]);
  }
  // A note made again meanwhile (another restart) is a new one.
  if (done.length) await changeNotes(deps.file, (cur) => done.forEach(([id, at]) => cur[id]?.at === at && delete cur[id]));
  return typed;
}
