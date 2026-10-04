// Leaving a CLI stops the background tasks and monitors its session ran ("1 monitor couldn't be moved and was
// stopped"): a restart Aya makes on purpose warns first, and tells a team agent resumed after it to start them again.

import { promises as fs } from "node:fs";
import { writeFileAtomic } from "./atomic-write";
import { oneAtATime } from "./keyed-queue";
import type { AgentKind } from "./presets";
import { typeFromAya, type TeamControlDeps } from "./team-control";
import { TEAM_SYSTEM_SENDER } from "./team-definition";
import { runnableTeamNames } from "./team-files";
import { openTeamStore } from "./team-store";

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
  work: string;
}

export interface RelaunchDeps {
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
  now?: () => number;
}

interface Note {
  pid: number | null;
  work: string;
  at: number;
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

/** The panes among `ids` (all when absent) whose screen shows background work now. */
export async function backgroundWorkOf(deps: RelaunchDeps, ids?: readonly string[]): Promise<PaneWork[]> {
  const out: PaneWork[] = [];
  for (const { id, name } of await deps.panes(ids)) {
    const screen = await deps.screen(id).catch(() => null);
    const work = screen === null ? null : backgroundWorkShown(screen, await deps.agentOf(id));
    if (work) out.push({ id, name, work });
  }
  return out;
}

/** The warning before a restart that stops `work`; `action` names the restart. */
export function restartWarning(action: string, work: readonly PaneWork[]): string {
  const shown = work.map((w) => `${w.name}: ${w.work}`).join("; ");
  return `${action} stops what these panes run in the background (${shown}). The agent cannot carry them into the new process; Aya tells a team agent resumed afterwards to start again the ones it still needs.`;
}

/** Remembers the panes in `work` for a note once each comes back as a new process. */
export async function noteRelaunch(deps: RelaunchDeps, work: readonly PaneWork[]): Promise<void> {
  if (!work.length) return;
  const at = (deps.now ?? Date.now)();
  const pids = await Promise.all(work.map(async (w) => (await deps.pid(w.id).catch(() => undefined)) ?? null));
  await changeNotes(deps.file, (notes) => work.forEach((w, i) => (notes[w.id] = { pid: pids[i], work: w.work, at })));
}

/** Asks before a restart of `ids` (all when absent) only when one shows background work; a yes keeps the notes. */
export async function confirmRestart(deps: RelaunchDeps, action: string, ask: (text: string) => Promise<boolean>, ids?: readonly string[]): Promise<boolean> {
  const work = await backgroundWorkOf(deps, ids);
  if (!work.length) return true;
  if (!(await ask(restartWarning(action, work)))) return false;
  await noteRelaunch(deps, work);
  return true;
}

/** As confirmRestart, but a pane whose work the user already agreed to stop for its current process (a note left by
 *  Restart to update, its pane not relaunched yet) is not asked about again. */
export async function confirmRestartOnce(deps: RelaunchDeps, action: string, ask: (text: string) => Promise<boolean>): Promise<boolean> {
  const work = await backgroundWorkOf(deps);
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
