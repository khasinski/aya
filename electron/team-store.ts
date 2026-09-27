// A team's per-machine state, kept out of the repo: pane ids exist on this
// machine only, and messages may hold secrets.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { writeFileAtomic } from "./atomic-write";
import { OWNER_ONLY_FILE_MODE } from "./paths";

export interface TeamMessage {
  id: number;
  time: string;
  from: string;
  to: string;
  commit: string | null;
  text: string;
  /** Typed into the recipient's pane; the rest wait for its inbox. */
  delivered: boolean;
}

export function teamDir(ayaHome: string, project: string, team: string): string {
  return path.join(ayaHome, "teams", project, team);
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

export class TeamStore {
  // Every write goes through this chain: one process owns a team, and ids
  // and read positions must not interleave.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly dir: string) {}

  private file(name: string): string {
    return path.join(this.dir, name);
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  private assignments(): Promise<Record<string, string>> {
    return readJson(this.file("assignments.json"), {});
  }

  /** One pane per role and one role per pane; taking one gives up the other. */
  assign(role: string, paneId: string): Promise<void> {
    return this.serial(async () => {
      const current = await this.assignments();
      const next = Object.fromEntries(
        Object.entries(current).filter(([, p]) => p !== paneId),
      );
      next[role] = paneId;
      await writeFileAtomic(this.file("assignments.json"), JSON.stringify(next, null, 2));
    });
  }

  releasePane(paneId: string): Promise<void> {
    return this.serial(async () => {
      const current = await this.assignments();
      const next = Object.fromEntries(Object.entries(current).filter(([, p]) => p !== paneId));
      await writeFileAtomic(this.file("assignments.json"), JSON.stringify(next, null, 2));
    });
  }

  async paneOf(role: string): Promise<string | null> {
    return (await this.assignments())[role] ?? null;
  }

  async roleOf(paneId: string): Promise<string | null> {
    const entry = Object.entries(await this.assignments()).find(([, p]) => p === paneId);
    return entry ? entry[0] : null;
  }

  /** A paused team takes no sends and no rounds. */
  setPaused(paused: boolean): Promise<void> {
    return this.serial(() => writeFileAtomic(this.file("state.json"), JSON.stringify({ paused })));
  }

  async paused(): Promise<boolean> {
    return (await readJson<{ paused?: boolean }>(this.file("state.json"), {})).paused === true;
  }

  /** The definition as the user last saved it; outside edits wait for Save. */
  saveDefinition(text: string): Promise<void> {
    return this.serial(() => writeFileAtomic(this.file("saved.md"), text));
  }

  async savedDefinition(): Promise<string | null> {
    try {
      return await fs.readFile(this.file("saved.md"), "utf-8");
    } catch {
      return null;
    }
  }

  private async messages(): Promise<TeamMessage[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file("log.jsonl"), "utf-8");
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
      const last = (await this.messages()).at(-1);
      const entry: TeamMessage = { id: (last?.id ?? 0) + 1, time: new Date().toISOString(), ...message };
      await fs.mkdir(this.dir, { recursive: true });
      await fs.appendFile(this.file("log.jsonl"), `${JSON.stringify(entry)}\n`, {
        mode: OWNER_ONLY_FILE_MODE,
      });
      return entry;
    });
  }

  async unread(role: string): Promise<TeamMessage[]> {
    const read = (await readJson<Record<string, number>>(this.file("read.json"), {}))[role] ?? 0;
    return (await this.messages()).filter((m) => m.to === role && !m.delivered && m.id > read);
  }

  markRead(role: string, id: number): Promise<void> {
    return this.serial(async () => {
      const read = await readJson<Record<string, number>>(this.file("read.json"), {});
      read[role] = id;
      await writeFileAtomic(this.file("read.json"), JSON.stringify(read, null, 2));
    });
  }
}
