// Start team (a delivery test to every role), Aya-owned rounds on the team's
// cadence, and the team pause. Rounds live in Aya, not in one agent session.

import { deliverAndLog, roleHold, typedTeamMessage, type TeamControlDeps } from "./team-control";
import { loadTeam, projectBySlug, teamNames } from "./team-files";
import { openTeamStore, type TeamStore } from "./team-store";
import { TEAM_SYSTEM_SENDER } from "./teams";
import type { ProjectConfig, TeamDefinition, TeamStartResult } from "./types";

const MS_PER_MINUTE = 60 * 1000;

/** Runs `fn` every `ms`; returns a cancel. Injected so tests need no clock. */
export type Schedule = (fn: () => Promise<void>, ms: number) => () => void;

const everyInterval: Schedule = (fn, ms) => {
  const timer = setInterval(() => void fn(), ms);
  return () => clearInterval(timer);
};

export class TeamRunner {
  private cancels = new Map<string, () => void>();
  private redelivering: Promise<number> | null = null;

  constructor(
    private deps: TeamControlDeps,
    private schedule: Schedule = everyInterval,
  ) {}

  private async open(slug: string, name: string) {
    const project = projectBySlug(await this.deps.listProjects(), slug);
    const store = openTeamStore(this.deps.teamHome, slug, name);
    return { project, store, team: await loadTeam(project, name, store) };
  }

  /** A message from Aya; returns why it was not typed, or null. */
  private async fromAya(project: ProjectConfig, store: TeamStore, team: TeamDefinition, to: string, text: string) {
    return (await deliverAndLog(this.deps, project, store, { team: team.name, from: TEAM_SYSTEM_SENDER, to, text })).failure;
  }

  /** The delivery test: the role reads itself back and pings its first peer. */
  private deliveryTest(project: ProjectConfig, store: TeamStore, team: TeamDefinition, roleId: string) {
    const peer = team.roles.find((r) => r.id === roleId)?.sendsTo[0]?.to;
    const reply = peer ? `, then send one word to ${peer} with: aya team send ${peer} "ok"` : "";
    return this.fromAya(project, store, team, roleId, `Delivery test: run aya team whoami${reply}.`);
  }

  /** Checks every pane first: with one missing, not running or held, nothing
   *  is sent and no rounds run, so one broken pane cannot waste the rest. */
  async start(slug: string, name: string): Promise<TeamStartResult> {
    const { project, store, team } = await this.open(slug, name);
    const notReady: TeamStartResult["held"] = [];
    for (const role of team.roles) {
      const { hold } = await roleHold(this.deps, store, role.id);
      if (hold) notReady.push({ role: role.id, reason: hold });
    }
    if (notReady.length) return { started: false, delivered: [], held: notReady };
    await store.setPaused(false);
    const result: TeamStartResult = { started: true, delivered: [], held: [] };
    for (const role of team.roles) {
      const held = await this.deliveryTest(project, store, team, role.id);
      if (held) result.held.push({ role: role.id, reason: held });
      else result.delivered.push(role.id);
    }
    this.arm(slug, name, team);
    return result;
  }

  /** A pane given a role in an already running team gets the delivery test now;
   *  returns why it was not typed. */
  async introduce(slug: string, name: string, roleId: string): Promise<string | null> {
    const { project, store, team } = await this.open(slug, name);
    if (!(await store.state()).running) return null;
    return this.deliveryTest(project, store, team, roleId);
  }

  private cancel(key: string): void {
    this.cancels.get(key)?.();
    this.cancels.delete(key);
  }

  async pause(slug: string, name: string): Promise<void> {
    this.cancel(`${slug}/${name}`);
    await openTeamStore(this.deps.teamHome, slug, name).setPaused(true);
  }

  async resume(slug: string, name: string): Promise<void> {
    const { store, team } = await this.open(slug, name);
    await store.setPaused(false);
    this.arm(slug, name, team);
  }

  /** After a relaunch: rounds for every team that was running. */
  async restore(): Promise<void> {
    for (const project of await this.deps.listProjects()) {
      for (const name of await teamNames(project)) {
        const store = openTeamStore(this.deps.teamHome, project.slug, name);
        if (!(await store.state()).running) continue;
        let team: TeamDefinition;
        try {
          team = await loadTeam(project, name, store);
        } catch {
          continue; // The teams window shows why it does not parse; the other teams still run.
        }
        this.arm(project.slug, name, team);
      }
    }
  }

  /** After Save team: a running team's rounds follow the new definition. */
  async refresh(slug: string, name: string): Promise<void> {
    if (!this.cancels.has(`${slug}/${name}`)) return;
    const { team } = await this.open(slug, name);
    this.arm(slug, name, team);
  }

  /** Types waiting inbox messages into panes that are free now; returns how many.
   *  A paused team is skipped, as aya team send refuses it. */
  redeliverWaiting(): Promise<number> {
    // A call during a pass shares it: two passes would both read and type one message.
    this.redelivering ??= this.redeliverPass().finally(() => (this.redelivering = null));
    return this.redelivering;
  }

  private async redeliverPass(): Promise<number> {
    let typed = 0;
    for (const project of await this.deps.listProjects()) {
      for (const name of await teamNames(project)) {
        const store = openTeamStore(this.deps.teamHome, project.slug, name);
        if ((await store.state()).paused) continue;
        const team = await loadTeam(project, name, store);
        for (const role of team.roles) {
          const waiting = await store.unread(role.id);
          const pane = waiting.length ? await store.paneOf(role.id) : null;
          if (!pane) continue;
          // Aya's own rounds and delivery tests go stale; a later one replaces them.
          for (const m of waiting.filter((w) => w.from !== TEAM_SYSTEM_SENDER)) {
            // Each delivery can raise an approval prompt the next would type into.
            if (await this.deps.holdReason(pane)) break;
            try {
              await this.deps.deliver(pane, typedTeamMessage(team.name, m.from, m.time, m.commit, m.text));
            } catch {
              break;
            }
            await store.markRead(role.id, m.id);
            typed++;
          }
        }
      }
    }
    return typed;
  }

  stopAll(): void {
    for (const cancel of this.cancels.values()) cancel();
    this.cancels.clear();
  }

  private arm(slug: string, name: string, team: TeamDefinition): void {
    const key = `${slug}/${name}`;
    this.cancel(key);
    if (!team.cadence) return;
    const cadence = team.cadence;
    this.cancels.set(
      key,
      this.schedule(async () => {
        try {
          const { project, store, team: current } = await this.open(slug, name);
          if ((await store.state()).paused) return;
          const round = (await store.lastRound()) + 1;
          const text = `Round ${round}: run your round as the team protocol says.`;
          // A held pane skips the round rather than queueing it: it would be stale.
          if (!(await this.fromAya(project, store, current, cadence.role, text))) await store.setLastRound(round);
        } catch (err) {
          // A timer has no caller to report to: skip this round, try the next.
          console.warn(`[aya] team ${slug}/${name} round skipped:`, err);
        }
      }, cadence.minutes * MS_PER_MINUTE),
    );
  }
}
