// Start team (a delivery test to every role), Aya-owned rounds on the team's
// cadence, and the team pause. Rounds live in Aya, not in one agent session.

import { outstandingWaiting, settleRestored } from "./agent-status";
import { whileTeamNotSaved } from "./team-admin";
import { whileProjectPanesFree } from "./team-panes";
import { deliverAndLog, logTyped, oneLine, PaneHeldError, roleHold, systemLine, typeFromAya, typeLogged, type TeamControlDeps } from "./team-control";
import { TEAM_MINUTE_MS } from "./paths";
import { loadTeam, projectBySlug, runnableTeamNames, teamFile } from "./team-files";
import { HOLD_BUSY, NO_PANE_HOLD } from "./pane-holds";
import { debugLog, debugOn } from "./team-debug";
import { oneAtATime } from "./keyed-queue";
import { noteRound, observe, quietTooLong, repoSince, resetProgress, roundsHeld, stalledWhenLastLooked, teamLiveness, type TeamProgress } from "./team-progress";
import { pendingWaits, stalledText, supervisionText, loadText } from "./team-supervision";
import { openTeamStore, readText, type PendingTask, type TeamStore } from "./team-store";
import { clock, ROUND_CHECK_MS, SILENCE_FIRST_MS, SILENCE_REPEAT_MS } from "./team-times";
import { TEAM_SYSTEM_SENDER, TEAM_USER_SENDER } from "./team-definition";
import type { ProjectConfig, TeamDefinition, TeamStartResult } from "./types";

/** Runs `fn` every `ms`; returns a cancel. Injected so tests need no clock. */
export type Schedule = (fn: () => Promise<void>, ms: number) => () => void;

const teamKey = (slug: string, name: string): string => `${slug}/${name}`;

// The timer never keeps a process alive by itself (a test that forgot stopAll must still end).
const everyInterval: Schedule = (fn, ms) => {
  const interval = setInterval(() => void fn(), ms).unref();
  return () => clearInterval(interval);
};

/** Who gets the Start task: `to`, else the lead, else the first role (a team saved before leads). Throws, before
 *  anything starts, on an unknown `to` or a team with a role named "user". */
export function taskRecipient(team: TeamDefinition, to?: string): string {
  // A team saved before "user" was reserved may have a role by that name: its
  // messages and a task would read alike, so such a team takes no task.
  if (team.roles.some((r) => r.id === TEAM_USER_SENDER)) {
    throw new Error(
      `team ${team.name} has a role named "${TEAM_USER_SENDER}", the sender of a Start task; start it without a task, or rename the role to give one; nothing was started`,
    );
  }
  if (to === undefined) return team.lead ?? team.roles[0].id;
  if (team.roles.some((r) => r.id === to)) return to;
  throw new Error(`team ${team.name} has no role "${to}"; its roles: ${team.roles.map((r) => r.id).join(", ")}; nothing was started`);
}

const ALREADY_RUNNING: TeamStartResult = { started: false, alreadyRunning: true, delivered: [], held: [], task: null };

/** Why the role `by` may not resume a paused team, or null: the user's pause is the user's to end, and the lead's
 *  (aya team pause) the lead's or the user's. A team never started is not resumed, so any role may start it. */
export function resumeRefusal(pausedBy: string | null, by: string): string | null {
  if (pausedBy === null || pausedBy === by) return null;
  if (pausedBy === TEAM_USER_SENDER) return "the user paused this team; only the user can resume it; nothing was sent";
  return `the lead (${pausedBy}) paused this team; only ${pausedBy} or the user can resume it; nothing was sent`;
}

export class TeamRunner {
  private cancels = new Map<string, () => void>();
  // Bumped by every cancel: a tick armed before it does nothing.
  private generations = new Map<string, number>();
  private redelivering: Promise<number> | null = null;
  // The last failure warned per team: a team that does not parse warns once per reason, not once per pass.
  private failing = new Map<string, string>();
  // One team's Starts, Resumes, restores, clock looks and Remove run one after another: two overlapping ticks would type
  // the same round number, a Start and a Resume the task twice. Pause and Save do not wait: they bump the generation instead.
  private turns = oneAtATime();

  constructor(
    private deps: TeamControlDeps,
    private schedule: Schedule = everyInterval,
    private now: () => number = Date.now,
    private warn: (...args: unknown[]) => void = console.warn,
  ) {}

  private async open(slug: string, name: string) {
    const project = projectBySlug(await this.deps.listProjects(), slug);
    const store = openTeamStore(this.deps.teamHome, slug, name);
    return { project, store, team: await loadTeam(name, store) };
  }

  /** The delivery test: the role reads itself back and pings its first peer. Logged at its Enter or once held; returns
   *  why it was held or its Enter started no turn, or null. Aya's own are never owed, so they take no reservation. */
  private async deliveryTest(project: ProjectConfig, store: TeamStore, team: TeamDefinition, roleId: string, paused: () => boolean) {
    const peer = team.roles.find((r) => r.id === roleId)?.sendsTo[0]?.to;
    const reply = peer ? `, then send one word to ${peer} with: aya team send ${peer} "ok"` : "";
    const text = `Delivery test: run aya team whoami${reply}. If Aya was updated since you started, run aya capabilities for its current commands.`;
    const message = { team: team.name, from: TEAM_SYSTEM_SENDER, to: roleId, text };
    const typed = await typeFromAya(this.deps, project, store, message, undefined, paused);
    if (!typed.entry) await logTyped(store, message, typed);
    return typed.failure ?? typed.unseen;
  }

  /** Checks every pane first: one missing, not running or held sends nothing. `task` goes to its role after the
   *  delivery tests, from `by`: the user (the window, aya outside the panes), else the role whose pane asked. */
  async start(slug: string, name: string, task?: { text: string; to?: string }, by?: string): Promise<TeamStartResult> {
    const result = await this.turns(teamKey(slug, name), () => this.startOnce(slug, name, task, by));
    if (debugOn()) debugLog(openTeamStore(this.deps.teamHome, slug, name), "start", { by: by ?? null, ...result });
    return result;
  }

  private async startOnce(slug: string, name: string, task?: { text: string; to?: string }, by?: string): Promise<TeamStartResult> {
    const { project, store, team } = await this.open(slug, name);
    if ((await store.state()).running) return ALREADY_RUNNING;
    const pausedBy = await store.pausedBy();
    const refused = by === undefined ? null : resumeRefusal(pausedBy, by);
    if (refused) return { started: false, refused, delivered: [], held: [], task: null };
    const recipient = task ? taskRecipient(team, task.to) : null;
    const notReady: TeamStartResult["held"] = [];
    for (const role of team.roles) {
      const { hold } = await roleHold(this.deps, store, role.id);
      if (hold) notReady.push({ role: role.id, reason: hold });
    }
    if (notReady.length) return { started: false, delivered: [], held: notReady, task: null };
    const owed = task && recipient ? { to: recipient, text: task.text, ...(by ? { from: by } : {}), after: (await store.log()).at(-1)?.id ?? 0 } : null;
    if (owed) await store.setPendingTask(owed);
    await store.setPaused(false);
    const paused = store.pausedSince();
    if (by && pausedBy === by) await systemLine(store, by, `${by} (the lead) resumed the team it paused`);
    await this.freshProgress(project, store);
    const result: TeamStartResult = { started: true, delivered: [], held: [], task: null };
    for (const role of team.roles) {
      const held = await this.deliveryTest(project, store, team, role.id, paused);
      if (held) result.held.push({ role: role.id, reason: held });
      else result.delivered.push(role.id);
    }
    if (owed) {
      const { entry, failure, typed } = await this.typeTask(project, store, team, owed, paused);
      result.task = { to: owed.to, held: failure, messageId: entry.id, ...(typed ? { typedOnly: true } : {}), ...(entry.afterEnter ? { afterEnter: true } : {}) };
    }
    // Paused meanwhile: the rest was not typed (held, the task owed for Resume) and no clock runs.
    if (!paused()) await this.arm(slug, name, team, store, "fresh");
    return result;
  }

  private async typeTask(project: ProjectConfig, store: TeamStore, team: TeamDefinition, task: PendingTask, paused?: () => boolean) {
    const message = { team: team.name, from: task.from ?? TEAM_USER_SENDER, to: task.to, text: task.text };
    return deliverAndLog(this.deps, project, store, message, () => store.setPendingTask(null), paused);
  }

  /** A Start that went down before its task was logged: it is logged and typed now. One logged but not typed yet is
   *  typed now; one Aya went down while typing is not typed again (typeLogged's reservation). */
  private async typeOwedTask(project: ProjectConfig, store: TeamStore, team: TeamDefinition, paused?: () => boolean): Promise<void> {
    const task = await store.pendingTask();
    if (!task) return;
    const { after } = task;
    const text = oneLine(task.text);
    const from = task.from ?? TEAM_USER_SENDER;
    const logged = after === undefined ? undefined : (await store.log()).find((m) => m.id > after && m.from === from && m.to === task.to && m.text === text);
    if (!logged) return void (await this.typeTask(project, store, team, task, paused));
    await store.setPendingTask(null);
    if ((await store.owed(task.to)).some((m) => m.id === logged.id)) await typeLogged(this.deps, project, store, team.name, logged, { cancelled: paused });
  }

  /** Whether the silence owes the lead a round: no message or change for SILENCE_FIRST_MS, then every
   *  SILENCE_REPEAT_MS after a round that said so, and never within SILENCE_REPEAT_MS of another round. */
  private async quietDue(store: TeamStore, progress: TeamProgress, nowMs: number): Promise<boolean> {
    const since = Date.parse(progress.changedAt);
    if (!Number.isFinite(since) || nowMs - since < SILENCE_FIRST_MS) return false;
    const last = Math.max((await store.silenceRoundAt()) ?? -Infinity, (await store.roundClockAt()) ?? -Infinity);
    return nowMs - last >= SILENCE_REPEAT_MS;
  }

  /** The question the role's agent put to the user (`aya status waiting`) after `sinceMs`, still unanswered, else
   *  null: no round goes to it until something moves. A hook's idle composer is no question (agent-status.ts). */
  private async askedTheUser(store: TeamStore, role: string, sinceMs: number, project: ProjectConfig): Promise<string | null> {
    const pane = await store.paneOf(role);
    // A question from before a restart is the old agent life's once the pane runs another session.
    const before = pane ? settleRestored(pane, project.tabs.find((t) => t.id === pane)?.sessionId) : null;
    if (before !== null) await systemLine(store, role, `question from before the restart: ${oneLine(before)}`);
    const asked = pane ? outstandingWaiting()[pane] : undefined;
    // Unconfirmed: the window shows it, no round waits for it.
    return asked && asked.restart !== "unconfirmed" && asked.since > sinceMs ? asked.text : null;
  }

  /** A pane given a role in an already running team gets the delivery test now;
   *  returns why it was held or its Enter started no turn, else null. */
  async introduce(slug: string, name: string, roleId: string): Promise<string | null> {
    const { project, store, team } = await this.open(slug, name);
    const paused = store.pausedSince();
    if (!(await store.state()).running) return null;
    return this.deliveryTest(project, store, team, roleId, paused);
  }

  private async freshProgress(project: ProjectConfig, store: TeamStore): Promise<void> {
    await resetProgress(store, await this.deps.headCommit(project.directory), new Date(this.now()).toISOString());
    await store.clearSilenceRoundAt();
  }

  private cancel(key: string): void {
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    const cancel = this.cancels.get(key);
    if (typeof cancel === "function") cancel();
    this.cancels.delete(key);
  }

  /** `by`: the user (the window), or the lead's role (aya team pause); it decides who may resume. */
  async pause(slug: string, name: string, by: string = TEAM_USER_SENDER): Promise<void> {
    this.cancel(teamKey(slug, name));
    await openTeamStore(this.deps.teamHome, slug, name).setPaused(true, by);
  }

  /** Forgets a team whose repo file is gone (rounds, saved copy, state, panes). Waits for the team's turn (a Start
   *  finishing later would arm a clock nothing cancels), an open or assign of the project's panes and a save of the file. */
  async remove(slug: string, name: string): Promise<void> {
    const key = teamKey(slug, name);
    // A clock look in flight stops before its paste now, not after the wait for its turn; a refused Remove re-arms it.
    this.cancel(key);
    await this.turns(key, async () => {
      try {
        await this.removeOnce(slug, name);
      } catch (err) {
        await this.rearmIfRunning(slug, name).catch((e) => this.warn("[aya] team %s/%s clock not re-armed:", slug, name, e));
        throw err;
      }
    });
  }

  private async rearmIfRunning(slug: string, name: string): Promise<void> {
    const { store, team } = await this.open(slug, name);
    if ((await store.state()).running) await this.arm(slug, name, team, store, "kept");
  }

  private async removeOnce(slug: string, name: string): Promise<void> {
    await whileProjectPanesFree(slug, async () => {
      const project = projectBySlug(await this.deps.listProjects(), slug);
      const file = teamFile(project, name);
      await whileTeamNotSaved(file, async () => {
        if ((await readText(file)) !== null) {
          throw new Error(`team ${name} is still in the repo (${file}); delete that file first, then remove the team`);
        }
        this.cancel(teamKey(slug, name));
        await openTeamStore(this.deps.teamHome, slug, name).remove();
      });
    });
  }

  resume(slug: string, name: string): Promise<void> {
    return this.turns(teamKey(slug, name), async () => {
      const { project, store, team } = await this.open(slug, name);
      await store.setPaused(false);
      const paused = store.pausedSince();
      await this.freshProgress(project, store);
      await this.typeOwedTask(project, store, team, paused);
      if (!paused()) await this.arm(slug, name, team, store, "fresh");
    });
  }

  /** After a relaunch: rounds for every team that was running. */
  async restore(): Promise<void> {
    for (const project of await this.deps.listProjects()) {
      for (const name of await runnableTeamNames(this.deps.teamHome, project)) {
        await this.turns(teamKey(project.slug, name), () => this.restoreTeam(project, name));
      }
    }
  }

  private async restoreTeam(project: ProjectConfig, name: string): Promise<void> {
    const store = openTeamStore(this.deps.teamHome, project.slug, name);
    const armedBefore = this.generations.get(teamKey(project.slug, name)) ?? 0;
    if (!(await store.state()).running) return;
    let team: TeamDefinition;
    try {
      team = await loadTeam(name, store);
    } catch {
      return; // The teams window shows why it does not parse; the other teams still run.
    }
    // The stall clock starts at the launch, the silence clock too unless the lead asked the user since (the rounds stay
    // held on it); a team stalled at the last look before Aya closed stays stalled.
    const progress = await store.progress();
    const launch = new Date(this.now()).toISOString();
    if (progress?.changedAt && !stalledWhenLastLooked(progress)) {
      const quiet = !team.lead || (await this.askedTheUser(store, team.lead, Date.parse(progress.changedAt), project)) === null;
      await store.updateProgress((p) => ({ ...p, ...(quiet ? { changedAt: launch } : {}), repoChangedAt: launch, messages: 0 }));
    }
    await this.typeOwedTask(project, store, team).catch((err) => this.warn("[aya] team %s/%s task not typed:", project.slug, name, err));
    await this.arm(project.slug, name, team, store, "kept", armedBefore);
  }

  /** After Save team: a running team's rounds follow the new definition. */
  async refresh(slug: string, name: string): Promise<void> {
    // Not "has a timer": a Save can land before the boot-time restore has armed the team.
    if (!(await openTeamStore(this.deps.teamHome, slug, name).state()).running) return;
    const { store, team } = await this.open(slug, name);
    await this.arm(slug, name, team, store, "kept");
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
      for (const name of await runnableTeamNames(this.deps.teamHome, project)) {
        const key = teamKey(project.slug, name);
        try {
          typed += await this.redeliverTeam(project, name);
          this.failing.delete(key);
        } catch (err) {
          // One team that does not parse or read must not stall the others.
          const reason = err instanceof Error ? err.message : String(err);
          if (this.failing.get(key) !== reason) this.warn(`[aya] team ${key} held messages not retried: ${reason}`);
          this.failing.set(key, reason);
        }
      }
    }
    return typed;
  }

  /** At most one message per pane per pass: a delivery can raise an approval
   *  prompt only after the agent has read it, so the next one waits a pass. */
  private async redeliverTeam(project: ProjectConfig, name: string): Promise<number> {
    const store = openTeamStore(this.deps.teamHome, project.slug, name);
    // The Pause token: a Pause from here on stops the paste even once it holds the pane's lock, as for aya team send.
    const paused = store.pausedSince();
    if ((await store.state()).paused) return 0;
    // A team file from a pull or clone runs only once saved; until then nothing is owed to a pane.
    if ((await store.savedDefinition()) === null) return 0;
    const team = await loadTeam(name, store);
    let typed = 0;
    for (const role of team.roles) {
      const [next] = await store.owed(role.id);
      if (!next) continue;
      const pane = await store.paneOf(role.id);
      const hold = pane ? await this.deps.holdReason(pane) : NO_PANE_HOLD;
      debugLog(store, "redelivery", { role: role.id, id: next.id, hold });
      if (hold) continue;
      if (!(await typeLogged(this.deps, project, store, team.name, next, { cancelled: paused, late: { now: this.now } })).entered) continue;
      typed++;
    }
    return typed;
  }

  stopAll(): void {
    for (const key of [...this.cancels.keys()]) this.cancel(key);
  }

  /** One clock per running team: every ROUND_CHECK_MS it records what moved and whether a round is due. `fresh` starts the
   *  rhythm now; `kept` goes on from where the last app life left it, so a relaunch inside the cadence does not push the next round away. */
  private async arm(slug: string, name: string, team: TeamDefinition, store: TeamStore, clock: "fresh" | "kept", unchangedSince?: number): Promise<void> {
    const key = teamKey(slug, name);
    // A Save, Pause or Remove that armed or cancelled the team while restore was reading it is newer than restore's copy.
    const superseded = () => unchangedSince !== undefined && (this.generations.get(key) ?? 0) !== unchangedSince;
    if (team.cadenceMinutes !== null && (clock === "fresh" || (await store.roundClockAt()) === null)) await store.setRoundClockAt(this.now());
    if (superseded()) return;
    // No await between cancel and set: overlapping arms would leak the earlier timer.
    this.cancel(key);
    const generation = this.generations.get(key);
    const stale = () => this.generations.get(key) !== generation;
    const tick = (): Promise<void> =>
      this.turns(key, () => this.roundTick(slug, name, stale).catch((err) => this.warn("[aya] team %s/%s round not run:", slug, name, err)));
    this.cancels.set(key, this.schedule(tick, ROUND_CHECK_MS));
  }

  /** A look of the team's clock: records the repo, talk and screens. A round due on the rhythm, the silence or a stall
   *  goes to the lead, logged at its Enter; one not typed is logged as skipped and stays due. */
  private async roundTick(slug: string, name: string, stale: () => boolean): Promise<void> {
    const { project, store, team } = await this.open(slug, name);
    if (stale() || (await store.state()).paused) return;
    const nowMs = this.now();
    const now = new Date(nowMs).toISOString();
    const head = await this.deps.headCommit(project.directory);
    const tree = (await this.deps.treeState?.(project.directory).catch(() => null)) ?? null;
    const holds = Object.fromEntries(await Promise.all(team.roles.map(async (r) => [r.id, (await roleHold(this.deps, store, r.id)).hold] as const)));
    const progress = await observe(store, head, holds, now, tree, team.lead);
    if (debugOn()) await teamLiveness(store, team.roles.map((r) => r.id), this.deps.holdReason, { cadence: team.cadenceMinutes, lead: !!team.lead }, nowMs);
    const lead = team.lead;
    if (!lead) return;
    const cadenceMs = (team.cadenceMinutes ?? 0) * TEAM_MINUTE_MS;
    const periodic = cadenceMs > 0 && nowMs - ((await store.roundClockAt()) ?? nowMs) >= cadenceMs;
    const quiet = await this.quietDue(store, progress, nowMs);
    const onRepo = quietTooLong(progress, nowMs);
    debugLog(store, "round-check", { rhythm: periodic, silence: quiet, stall: onRepo, stallTold: progress.stalledLogged });
    if (!periodic && !quiet && !(onRepo && !progress.stalledLogged)) return;
    const round = (await store.lastRound()) + 1;
    const logOnce = async (text: string): Promise<void> => {
      if ((await store.log()).some((m) => m.from === TEAM_SYSTEM_SENDER && m.to === lead && m.text === text)) return;
      await store.append({ from: TEAM_SYSTEM_SENDER, to: lead, commit: head, text, delivered: true });
    };
    // Once per round and reason: a lead busy for an hour is not a page of skips.
    const skip = (why: string) => (debugLog(store, "round", { round, skipped: why }), logOnce(`round ${round} skipped: ${why}`));
    const pausedSkip = async () => ((await store.state()).paused ? skip("the team is paused") : debugLog(store, "round", { round, skipped: "the team was saved or re-armed meanwhile" }));
    if (stale()) return pausedSkip();
    // Told once per stall: rounds nobody can act on only pile up in the agent's queue; a change to the repo resumes them.
    if (onRepo && progress.stalledLogged) return skip(`stalled: no change to the repo since ${clock(repoSince(progress))}`);
    // Rounds a lead does not answer pile up in its queue too: the next wait for its answer. The one round of a stall still goes.
    if (!onRepo && roundsHeld(progress)) {
      debugLog(store, "round", { round, held: "brake", unanswered: progress.unanswered?.rounds });
      return logOnce(`rounds held: ${lead} did not answer rounds ${round - (progress.unanswered?.rounds ?? 0)}..${round - 1}`);
    }
    const question = await this.askedTheUser(store, lead, Date.parse(progress.changedAt), project);
    if (question !== null) return skip(`${lead} asked the user${question ? `: ${oneLine(question)}` : ""}`);
    const waits = () => store.annotatedLog().then((log) => pendingWaits(log, team.roles.map((r) => r.id)));
    const text = onRepo
      ? stalledText({ round, since: repoSince(progress), messages: progress.messages ?? 0, waits: await waits(), nowMs })
      : quiet
        ? supervisionText({ round, quietSince: progress.changedAt, waits: await waits(), nowMs })
        : `Round ${round}: run your round as the team protocol says.` +
          loadText({ log: await store.annotatedLog(), roles: team.roles.map((r) => r.id), sinceMs: (await store.roundClockAt()) ?? nowMs - cadenceMs, waits: await waits(), nowMs });
    const message = { team: team.name, from: TEAM_SYSTEM_SENDER, to: lead, text };
    // A silence round was decided before the wait for the lead's pane: talk that went in meanwhile ends the silence.
    // Read once, as the lock is taken, before the paste (the second read, before the Enter, is the Pause's only).
    const talkedBefore = store.talkedSince();
    let looked = false;
    let talked = false;
    const talkedSince = () => {
      if (looked || !quiet || periodic || onRepo) return false;
      looked = true;
      return (talked = talkedBefore());
    };
    // A busy lead waits too, and a Pause or re-arm during the awaits stops the paste.
    const deps = {
      ...this.deps,
      holdReason: async (pane: string) => (await this.deps.holdReason(pane)) ?? ((await this.deps.busy?.(pane)) ? HOLD_BUSY : null),
      deliver: async (pane: string, line: string, _cancelled?: () => boolean, entered?: () => Promise<void>, pasting?: () => Promise<void>) => {
        if (stale()) throw new PaneHeldError("the team was paused or changed while the round was prepared", false);
        return this.deps.deliver(pane, line, () => stale() || talkedSince(), entered, pasting);
      },
    };
    // The number is used up at the Enter, whatever the turn shows after: a relaunch in between types the next one.
    const typed = await typeFromAya(deps, project, store, message, async () => {
      await store.recordRound(round, { ...(periodic ? { roundClockAt: nowMs } : {}), ...(quiet ? { silenceRoundAt: nowMs } : {}) });
      await store.updateProgress(({ unreached, ...p }) => ({ ...p, ...(onRepo ? { stalledLogged: true } : {}), unanswered: { role: lead, rounds: (p.unanswered?.rounds ?? 0) + 1 } }));
    });
    debugLog(store, "round", { round, reason: onRepo ? "stall" : quiet ? "silence" : "rhythm", typed: typed.entry !== null, ...(talked ? { skipped: "talk came in while it waited for the lead's pane" } : {}) });
    if (typed.entry || !typed.failure || talked) return;
    // Text left in the composer without its Enter is logged as such; the composer's draft holds the next try.
    if (typed.typed) await logTyped(store, message, typed);
    const { failure } = typed;
    if (stale()) return typed.typed ? undefined : pausedSkip();
    await noteRound(store, lead, failure === HOLD_BUSY ? null : failure, now, cadenceMs || SILENCE_REPEAT_MS);
    return typed.typed ? undefined : skip(failure);
  }
}

