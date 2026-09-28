// A team's per-machine state, kept out of the repo: pane ids exist on this
// machine only, and messages may hold secrets.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { writeFileAtomic } from "./atomic-write";
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

// A team directory's files, one name per purpose.
const TEAM_FILES = {
  assignments: "assignments.json",
  state: "state.json",
  saved: "saved.md",
  log: "log.jsonl",
  read: "read.json",
} as const;

// One write queue per team directory, shared by every store opened on it.
const queues = new Map<string, Promise<unknown>>();

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

  /** A paused team takes no sends and no rounds. Unpausing marks it started. */
  setPaused(paused: boolean): Promise<void> {
    return this.serial(async () => {
      const state = await readJson<{ started?: boolean }>(this.file(TEAM_FILES.state), {});
      const started = state.started === true || !paused;
      await writeFileAtomic(this.file(TEAM_FILES.state), JSON.stringify({ paused, started }));
    });
  }

  /** running: started with Start team and not paused since. */
  async state(): Promise<{ paused: boolean; running: boolean }> {
    const state = await readJson<{ paused?: boolean; started?: boolean }>(this.file(TEAM_FILES.state), {});
    return { paused: state.paused === true, running: state.started === true && state.paused !== true };
  }

  /** The definition as the user last saved it; outside edits wait for Save. */
  saveDefinition(text: string): Promise<void> {
    return this.serial(() => writeFileAtomic(this.file(TEAM_FILES.saved), text));
  }

  async savedDefinition(): Promise<string | null> {
    try {
      return await fs.readFile(this.file(TEAM_FILES.saved), "utf-8");
    } catch {
      return null;
    }
  }

  async log(): Promise<TeamMessage[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file(TEAM_FILES.log), "utf-8");
    } catch {
      return [];
    }
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TeamMessage);
  }

  append(message: Omit<TeamMessage, "id" | "time">): Promise<TeamMessage> {
    return this.serial(async () => {
      const last = (await this.log()).at(-1);
      const entry: TeamMessage = { id: (last?.id ?? 0) + 1, time: new Date().toISOString(), ...message };
      await fs.mkdir(this.dir, { recursive: true });
      await fs.appendFile(this.file(TEAM_FILES.log), `${JSON.stringify(entry)}\n`, {
        mode: OWNER_ONLY_FILE_MODE,
      });
      return entry;
    });
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

/** The store of one team of a project, under ~/.aya/teams. */
export function openTeamStore(ayaHome: string, project: string, team: string): TeamStore {
  return new TeamStore(teamDir(ayaHome, project, team));
}
