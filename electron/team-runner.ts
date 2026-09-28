// Start team (a delivery test to every role), Aya-owned rounds on the team's
// cadence, and the team pause. Rounds live in Aya, not in one agent session.

import { loadTeam, oneLine, teamHeader, type TeamControlDeps } from "./team-control";
import { listTeams } from "./team-admin";
import { TeamStore, teamDir } from "./team-store";
import type { TeamDefinition } from "./teams";
import type { ProjectConfig, TeamStartResult } from "./types";

export type TeamRunnerDeps = Omit<TeamControlDeps, "headCommit"> & {
  headCommit?: TeamControlDeps["headCommit"];
};

/** Runs `fn` every `ms`; returns a cancel. Injected so tests need no clock. */
export type Schedule = (fn: () => Promise<void>, ms: number) => () => void;

const everyInterval: Schedule = (fn, ms) => {
  const timer = setInterval(() => void fn(), ms);
  return () => clearInterval(timer);
};

export class TeamRunner {
  private cancels = new Map<string, () => void>();
  private rounds = new Map<string, number>();

  constructor(
    private deps: TeamRunnerDeps,
    private schedule: Schedule = everyInterval,
  ) {}

  private async open(slug: string, name: string) {
    const project = (await this.deps.listProjects()).find((p) => p.slug === slug);
    if (!project) throw new Error(`project ${slug} is not open`);
    const store = new TeamStore(teamDir(this.deps.teamHome, slug, name));
    return { project, store, team: await loadTeam(project, name, store) };
  }

  /** Types a message from Aya unless the pane is held; logs it either way. */
  private async fromAya(
    project: ProjectConfig,
    store: TeamStore,
    team: TeamDefinition,
    role: string,
    text: string,
  ): Promise<string | null> {
    const pane = await store.paneOf(role);
    let held = pane ? await this.deps.holdReason(pane) : "has no pane";
    const time = new Date().toISOString();
    if (pane && !held) {
      try {
        await this.deps.deliver(pane, `${teamHeader(team.name, "aya", time, null)} ${oneLine(text)}`);
      } catch (err) {
        held = err instanceof Error ? err.message : String(err);
      }
    }
    const commit = (await this.deps.headCommit?.(project.directory)) ?? null;
    await store.append({ from: "aya", to: role, commit, text, delivered: !held });
    return held;
  }

  async start(slug: string, name: string): Promise<TeamStartResult> {
    const { project, store, team } = await this.open(slug, name);
    await store.setPaused(false);
    const result: TeamStartResult = { delivered: [], held: [] };
    for (const role of team.roles) {
      const peer = role.sendsTo[0]?.to;
      const reply = peer ? `, then send one word to ${peer} with: aya team send ${peer} "ok"` : "";
      const held = await this.fromAya(project, store, team, role.id, `Delivery test: run aya team whoami${reply}.`);
      if (held) result.held.push({ role: role.id, reason: held });
      else result.delivered.push(role.id);
    }
    this.arm(slug, name, team);
    return result;
  }

  async pause(slug: string, name: string): Promise<void> {
    this.cancels.get(`${slug}/${name}`)?.();
    this.cancels.delete(`${slug}/${name}`);
    await new TeamStore(teamDir(this.deps.teamHome, slug, name)).setPaused(true);
  }

  async resume(slug: string, name: string): Promise<void> {
    const { store, team } = await this.open(slug, name);
    await store.setPaused(false);
    this.arm(slug, name, team);
  }

  /** After a relaunch: rounds for every team that was running. */
  async restore(): Promise<void> {
    for (const project of await this.deps.listProjects()) {
      for (const summary of await listTeams(this.deps.teamHome, project)) {
        if (summary.running && summary.definition) this.arm(project.slug, summary.name, summary.definition);
      }
    }
  }

  /** After Save team: a running team's rounds follow the new definition. */
  async refresh(slug: string, name: string): Promise<void> {
    if (!this.cancels.has(`${slug}/${name}`)) return;
    const { team } = await this.open(slug, name);
    this.arm(slug, name, team);
  }

  stopAll(): void {
    for (const cancel of this.cancels.values()) cancel();
    this.cancels.clear();
  }

  private arm(slug: string, name: string, team: TeamDefinition): void {
    const key = `${slug}/${name}`;
    this.cancels.get(key)?.();
    this.cancels.delete(key);
    if (!team.cadence) return;
    const cadence = team.cadence;
    this.cancels.set(
      key,
      this.schedule(async () => {
        const { project, store, team: current } = await this.open(slug, name);
        if (await store.paused()) return;
        const round = (this.rounds.get(key) ?? 0) + 1;
        const text = `Round ${round}: run your round as the team protocol says.`;
        // A held pane skips the round rather than queueing it: it would be stale.
        if (!(await this.fromAya(project, store, current, cadence.role, text))) this.rounds.set(key, round);
      }, cadence.minutes * 60 * 1000),
    );
  }
}
