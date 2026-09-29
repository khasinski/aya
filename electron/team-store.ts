// A team's per-machine state, kept out of the repo: pane ids exist on this
// machine only, and messages may hold secrets.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { atomicTempPath, writeFileAtomic } from "./atomic-write";
import { OWNER_ONLY_FILE_MODE } from "./paths";
import { ID_RE } from "./teams";
import type { TeamMessage } from "./types";

export type { TeamMessage };

const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Names come over IPC: only a slug may become a path under ~/.aya/teams. */
export function teamDir(ayaHome: string, project: string, team: string): string {
  if (!PROJECT_RE.test(project) || project.includes("..")) throw new Error(`bad project slug "${project}"`);
  if (!ID_RE.test(team)) throw new Error(`bad team name "${team}"`);
  return path.join(ayaHome, "teams", project, team);
}

const TEAM_FILES = {
  assignments: "assignments.json",
  state: "state.json",
  saved: "saved.md",
  log: "log.jsonl",
  read: "read.json",
} as const;

// The log keeps its newest messages only; ids go on counting, so read marks and
// unread messages (always among the newest) are unaffected.
export const TEAM_LOG_MAX_ENTRIES = 2_000;
export const TEAM_LOG_KEEP_ENTRIES = 1_000;

type StateFile = { paused?: boolean; started?: boolean; lastRound?: unknown; agentAuthored?: boolean };

// One write queue per team directory, shared by every store opened on it.
const queues = new Map<string, Promise<unknown>>();

/** The file's text, or null when it cannot be read. */
export async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf-8");
  } catch {
    return null;
  }
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

export class TeamStore {
  constructor(readonly dir: string) {}

  private file(name: string): string {
    return path.join(this.dir, name);
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = (queues.get(this.dir) ?? Promise.resolve()).then(work, work);
    queues.set(this.dir, next.catch(() => {}));
    return next;
  }

  assignments(): Promise<Record<string, string>> {
    return readJson(this.file(TEAM_FILES.assignments), {});
  }

  /** One pane per role and one role per pane; taking one gives up the other. */
  assign(role: string, paneId: string): Promise<void> {
    return this.reassign(paneId, role);
  }

  releasePane(paneId: string): Promise<void> {
    return this.reassign(paneId);
  }

  private reassign(paneId: string, role?: string): Promise<void> {
    return this.serial(async () => {
      const next = Object.fromEntries(Object.entries(await this.assignments()).filter(([, p]) => p !== paneId));
      if (role) next[role] = paneId;
      await writeFileAtomic(this.file(TEAM_FILES.assignments), JSON.stringify(next, null, 2));
    });
  }

  async paneOf(role: string): Promise<string | null> {
    return (await this.assignments())[role] ?? null;
  }

  async roleOf(paneId: string): Promise<string | null> {
    const entry = Object.entries(await this.assignments()).find(([, p]) => p === paneId);
    return entry ? entry[0] : null;
  }

  private readState(): Promise<StateFile> {
    return readJson<StateFile>(this.file(TEAM_FILES.state), {});
  }

  private updateState(change: (state: StateFile) => StateFile): Promise<void> {
    return this.serial(async () => {
      await writeFileAtomic(this.file(TEAM_FILES.state), JSON.stringify(change(await this.readState())));
    });
  }

  /** A paused team takes no sends and no rounds. Unpausing marks it started. */
  setPaused(paused: boolean): Promise<void> {
    return this.updateState((state) => ({ ...state, paused, started: state.started === true || !paused }));
  }

  /** running: started with Start team and not paused since. */
  async state(): Promise<{ paused: boolean; running: boolean }> {
    const state = await this.readState();
    return { paused: state.paused === true, running: state.started === true && state.paused !== true };
  }

  /** Saved by an agent from a pane (aya team save): the agent proposes its panes. */
  markAgentAuthored(): Promise<void> {
    return this.updateState((state) => ({ ...state, agentAuthored: true }));
  }

  async agentAuthored(): Promise<boolean> {
    return (await this.readState()).agentAuthored === true;
  }

  /** The number of the last round Aya typed; 0 before the first. */
  async lastRound(): Promise<number> {
    const { lastRound } = await this.readState();
    return typeof lastRound === "number" && Number.isSafeInteger(lastRound) && lastRound > 0 ? lastRound : 0;
  }

  setLastRound(lastRound: number): Promise<void> {
    return this.updateState((state) => ({ ...state, lastRound }));
  }

  /** The definition as the user last saved it; outside edits wait for Save. */
  saveDefinition(text: string): Promise<void> {
    return this.serial(() => writeFileAtomic(this.file(TEAM_FILES.saved), text));
  }

  savedDefinition(): Promise<string | null> {
    return readText(this.file(TEAM_FILES.saved));
  }

  /** A torn or hand-edited line is skipped, not fatal to the whole team. */
  async log(): Promise<TeamMessage[]> {
    const entries: TeamMessage[] = [];
    for (const line of ((await readText(this.file(TEAM_FILES.log))) ?? "").split("\n")) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as TeamMessage;
        if (entry && Number.isSafeInteger(entry.id)) entries.push(entry);
      } catch {
        // skipped
      }
    }
    return entries;
  }

  append(message: Omit<TeamMessage, "id" | "time">): Promise<TeamMessage> {
    return this.serial(async () => {
      const log = await this.log();
      const entry: TeamMessage = { id: (log.at(-1)?.id ?? 0) + 1, time: new Date().toISOString(), ...message };
      await fs.mkdir(this.dir, { recursive: true });
      if (log.length >= TEAM_LOG_MAX_ENTRIES) {
        const kept = [...log.slice(-(TEAM_LOG_KEEP_ENTRIES - 1)), entry];
        // Owner-only from the first byte: messages may hold secrets.
        const tmp = atomicTempPath(this.file(TEAM_FILES.log));
        await fs.writeFile(tmp, kept.map((m) => `${JSON.stringify(m)}\n`).join(""), { mode: OWNER_ONLY_FILE_MODE });
        await fs.rename(tmp, this.file(TEAM_FILES.log));
      } else {
        await fs.appendFile(this.file(TEAM_FILES.log), `${JSON.stringify(entry)}\n`, {
          mode: OWNER_ONLY_FILE_MODE,
        });
      }
      return entry;
    });
  }

  /** How many messages `from` sent since `sinceMs` (epoch ms). */
  async sentSince(from: string, sinceMs: number): Promise<number> {
    return (await this.log()).filter((m) => m.from === from && Date.parse(m.time) >= sinceMs).length;
  }

  async unread(role: string): Promise<TeamMessage[]> {
    const read = (await this.readMarks())[role] ?? 0;
    return (await this.log()).filter((m) => m.to === role && !m.delivered && m.id > read);
  }

  /** Per role, the last message id it has had: read from its inbox or typed later. */
  readMarks(): Promise<Record<string, number>> {
    return readJson<Record<string, number>>(this.file(TEAM_FILES.read), {});
  }

  markRead(role: string, id: number): Promise<void> {
    return this.serial(async () => {
      const read = await this.readMarks();
      read[role] = Math.max(read[role] ?? 0, id);
      await writeFileAtomic(this.file(TEAM_FILES.read), JSON.stringify(read, null, 2));
    });
  }
}

export function openTeamStore(ayaHome: string, project: string, team: string): TeamStore {
  return new TeamStore(teamDir(ayaHome, project, team));
}
