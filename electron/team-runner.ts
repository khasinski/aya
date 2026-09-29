// Start team (a delivery test to every role), Aya-owned rounds on the team's
// cadence, and the team pause. Rounds live in Aya, not in one agent session.

import { deliverAndLog, roleHold, typedTeamMessage, type TeamControlDeps } from "./team-control";
import { loadTeam, projectBySlug, teamNames } from "./team-files";
import { openTeamStore, type TeamStore } from "./team-store";
import { TEAM_SYSTEM_SENDER, TEAM_USER_SENDER } from "./teams";
import type { ProjectConfig, TeamDefinition, TeamStartResult } from "./types";

const MS_PER_MINUTE = 60 * 1000;

/** Runs `fn` every `ms`; returns a cancel. Injected so tests need no clock. */
export type Schedule = (fn: () => Promise<void>, ms: number) => () => void;

const everyInterval: Schedule = (fn, ms) => {
  const timer = setInterval(() => void fn(), ms);
  return () => clearInterval(timer);
};

/** Who gets the task given with Start: `to`, else the cadence role that leads the
 *  rounds, else the first role. Throws on an unknown `to`, or a team with a role
 *  named "user", before anything starts. */
export function taskRecipient(team: TeamDefinition, to?: string): string {
  // A team saved before "user" was reserved may have a role by that name: its
  // messages and a task would read alike, so such a team takes no task.
  if (team.roles.some((r) => r.id === TEAM_USER_SENDER)) {
    throw new Error(
      `team ${team.name} has a role named "${TEAM_USER_SENDER}", the sender of a Start task; start it without a task, or rename the role to give one; nothing was started`,
    );
  }
  if (to === undefined) return team.cadence?.role ?? team.roles[0].id;
  if (team.roles.some((r) => r.id === to)) return to;
  throw new Error(`team ${team.name} has no role "${to}"; its roles: ${team.roles.map((r) => r.id).join(", ")}; nothing was started`);
}

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
    return { project, store, team: await loadTeam(name, store) };
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
  /** `task` goes to its role as a message from the user, after the delivery tests. */
  async start(slug: string, name: string, task?: { text: string; to?: string }): Promise<TeamStartResult> {
    const { project, store, team } = await this.open(slug, name);
    const recipient = task ? taskRecipient(team, task.to) : null;
    const notReady: TeamStartResult["held"] = [];
    for (const role of team.roles) {
      const { hold } = await roleHold(this.deps, store, role.id);
      if (hold) notReady.push({ role: role.id, reason: hold });
    }
    if (notReady.length) return { started: false, delivered: [], held: notReady, task: null };
    await store.setPaused(false);
    const result: TeamStartResult = { started: true, delivered: [], held: [], task: null };
    for (const role of team.roles) {
      const held = await this.deliveryTest(project, store, team, role.id);
      if (held) result.held.push({ role: role.id, reason: held });
      else result.delivered.push(role.id);
    }
    if (task && recipient) {
      const { failure } = await deliverAndLog(this.deps, project, store, { team: team.name, from: TEAM_USER_SENDER, to: recipient, text: task.text });
      result.task = { to: recipient, held: failure };
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
          team = await loadTeam(name, store);
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
        try {
          typed += await this.redeliverTeam(project, name);
        } catch (err) {
          // One team that does not parse or read must not stall the others.
          console.warn(`[aya] team ${project.slug}/${name} held messages not retried:`, err);
        }
      }
    }
    return typed;
  }

  /** At most one message per pane per pass: a delivery can raise an approval
   *  prompt only after the agent has read it, so the next one waits a pass. */
  private async redeliverTeam(project: ProjectConfig, name: string): Promise<number> {
    const store = openTeamStore(this.deps.teamHome, project.slug, name);
    if ((await store.state()).paused) return 0;
    const team = await loadTeam(name, store);
    let typed = 0;
    for (const role of team.roles) {
      // Aya's own rounds and delivery tests go stale; a later one replaces them.
      const next = (await store.unread(role.id)).find((w) => w.from !== TEAM_SYSTEM_SENDER);
      const pane = next ? await store.paneOf(role.id) : null;
      if (!next || !pane || (await this.deps.holdReason(pane))) continue;
      try {
        await this.deps.deliver(pane, typedTeamMessage(team.name, next.from, next.time, next.commit, next.text));
      } catch {
        continue;
      }
      await store.markRead(role.id, next.id);
      typed++;
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
