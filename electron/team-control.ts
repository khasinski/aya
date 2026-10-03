// `aya team whoami|send|inbox|pause`: the caller is known by its pane id, its role
// by the local assignments, and the team by the definition the user saved.

import type { TeamRequest } from "./control-protocol";
import { HOLD_DRAFT, HOLD_NOT_RUNNING, HOLD_STARTING, NO_PANE_HOLD } from "./pane-holds";
import { loadTeam, paneTeamRole } from "./team-files";
import { debugLog } from "./team-debug";
import { noteTyped } from "./team-progress";
import { goesStale, type TeamStore, type TeamMessage } from "./team-store";
import { TEAM_SYSTEM_SENDER } from "./team-definition";
import type { ProjectConfig, TeamDefinition, TeamRole } from "./types";
import { clock, WALL_MINUTE_MS } from "./team-times";

export interface TeamControlDeps {
  teamHome: string;
  listProjects: () => Promise<ProjectConfig[]>;
  /** Pastes text into a pane and presses Enter (PaneHeldError when held by then); resolves to why the Enter started no
   *  turn, if so. `pasting` runs once the pane lock is held, `entered` once the Enter is written, before that look. */
  deliver: (terminalId: string, text: string, cancelled?: () => boolean, entered?: () => Promise<void>, pasting?: () => Promise<void>) => Promise<string | null | void>;
  headCommit: (directory: string) => Promise<string | null>;
  /** A fingerprint of the working tree (git.ts workingTreeState), read at a round's tick only: it costs a diff. */
  treeState?: (directory: string) => Promise<string | null>;
  /** Set when Enter would do something else there; the message then waits. */
  holdReason: (terminalId: string) => Promise<string | null>;
  /** True until the boot window has loaded its projects: a pane may be missing only for now. */
  starting?: () => boolean;
  /** The pane's agent is mid-turn; only Aya's rounds wait for it. */
  busy?: (terminalId: string) => Promise<boolean>;
  /** What each role's pane was told at launch, and which panes carry a note they no longer earn. */
  roleNoteReport?: (project: ProjectConfig, team: string, assignments: Record<string, string>) => Promise<{ roleNotes: Record<string, string | null>; staleNotes: string[] }>;
  /** What Aya widened for the pane and what else its launch means (launchNoteOf), null when nothing. */
  launchNote?: (terminalId: string) => Promise<string | null>;
}

type TypingDeps = Pick<TeamControlDeps, "deliver" | "holdReason" | "headCommit">;

export const STARTING_MESSAGE = "Aya is still starting; run it again in a moment";
/** The answer to a team request while this Aya has no teams wired; the CLI prints it after "aya: ". */
export const TEAMS_UNAVAILABLE = "teams are not available";

/** Refused before anything happened, so asking again is safe; the CLI of a pane does. */
export class TryAgainError extends Error {
  readonly retryable = true;
}

interface Membership {
  project: ProjectConfig;
  team: TeamDefinition;
  role: TeamRole;
  store: TeamStore;
}

async function membership(callerId: string | undefined, deps: TeamControlDeps): Promise<Membership> {
  if (!callerId) throw new Error("run aya team inside an Aya pane");
  const project = (await deps.listProjects()).find((p) => p.tabs.some((t) => t.id === callerId));
  if (!project) throw deps.starting?.() ? new TryAgainError(STARTING_MESSAGE) : new Error("this pane belongs to no open project");
  const noRole = "this pane has no team role; assign one from the tab menu";
  const plays = await paneTeamRole(deps.teamHome, project, callerId);
  if (!plays) throw new Error(noRole);
  const team = await loadTeam(plays.team, plays.store);
  const role = team.roles.find((r) => r.id === plays.role);
  if (!role) throw new Error(noRole);
  return { project, team, role, store: plays.store };
}

function whoami({ team, role }: Membership): string {
  const sends = role.sendsTo.map((r) => (r.what ? `${r.to}: ${r.what}` : r.to));
  const lines = [
    `team      ${team.name}`,
    `you       ${role.id}`,
    ...(sends.length ? sends.map((line, i) => `${i ? "         " : "sends to"}  ${line}`) : ["sends to  (nobody)"]),
    `must not  ${role.mustNot}`,
  ];
  if (team.lead === role.id) lines.push("", 'you lead this team: when the work is done or cannot go on, end it with: aya team pause "why"');
  lines.push("", 'give a role work with: aya team send <role> "text" (not aya team start: starting and resuming the team is the user\'s)');
  if (role.responsibilities) lines.push("", role.responsibilities);
  if (team.protocol) lines.push("", "protocol", team.protocol);
  return `${lines.join("\n")}\n`;
}

/** A team's hold for a pane: the terminal host's, else why its launch mode cannot reach Aya. */
export function withLaunchHolds(
  holdReason: (paneId: string) => Promise<string | null>,
  launchBlock: (paneId: string) => Promise<string | null>,
): (paneId: string) => Promise<string | null> {
  return async (paneId) => (await holdReason(paneId)) ?? (await launchBlock(paneId));
}

/** A pane the host has never heard of but main is spawning (brief, lookups, host connect) is starting, not gone. */
export function withSpawnHolds(
  holdReason: (paneId: string) => Promise<string | null>,
  spawning: (paneId: string) => boolean,
): (paneId: string) => Promise<string | null> {
  return async (paneId) => {
    const hold = await holdReason(paneId);
    return hold === HOLD_NOT_RUNNING && spawning(paneId) ? HOLD_STARTING : hold;
  };
}

/** `deliver` found the pane held once it had the pane to itself. */
export class PaneHeldError extends Error {
  /** `typed`: the text is already in the composer; only the Enter was withheld. */
  constructor(readonly reason: string, readonly typed = false) {
    super(reason);
  }
}

export const ENTER_FAILED = "typed, but Enter did not go through (the pane may have exited); the text may still sit in its composer";

/** The text went in, but Enter did not: it may sit in the composer as a draft, so it must not be typed again. */
export class TextPastedError extends Error {}

/** The role's pane and why a message must not be typed into it now, or null. */
export async function roleHold(
  deps: Pick<TeamControlDeps, "holdReason">,
  store: TeamStore,
  role: string,
): Promise<{ pane: string | null; hold: string | null }> {
  const pane = await store.paneOf(role);
  return { pane, hold: pane ? await deps.holdReason(pane) : NO_PANE_HOLD };
}

// Every Zs but U+0020: a different space is a different token, so 16 of them would carry ~4 bits per gap.
const BLANK_OR_LINE = /[\p{Cc}\p{Zl}\p{Zp}\u2800\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+/gu;
const HIDDEN = /[\p{Cf}\p{Default_Ignorable_Code_Point}\p{Co}\p{Cn}\p{Cs}]/gu;

/** A peer's text as one plain line: controls (Enter, ESC[201~ ending a paste early) become a space; format, ignorable,
 *  private-use and unassigned characters (bidi overrides, zero-width joiners, tags) hide or reorder text and go. */
export function oneLine(text: string): string {
  return text.replace(BLANK_OR_LINE, " ").replace(HIDDEN, "").trim();
}

/** The header marks a message as a peer's dated report, not the user's instruction. */
export function typedTeamMessage(team: string, from: string, time: string, commit: string | null, text: string): string {
  return oneLine(`[team ${team} | from ${from} | ${clock(time)}${commit ? ` | ${commit}` : ""}] ${text}`);
}

const notRecorded = (to: string, err: unknown) => new Error(`${to}: typed into its pane, but not recorded (${err instanceof Error ? err.message : err})`);

/** A draft in the pane may be a team message whose Enter was withheld: say so. */
async function withDraftOwner(store: TeamStore, role: string, hold: string): Promise<string> {
  const last = (await store.annotatedLog()).filter((m) => m.to === role && m.delivered).at(-1);
  // The composer is not readable here: the user may have submitted that message and typed a new draft.
  if (!last?.typedOnly) return hold;
  const how = last.afterEnter && last.held ? last.held.replace(/^typed/, "typed there") : "typed there with its Enter withheld";
  return `${hold}; it may be message #${last.id} from ${last.from}, ${how}: submit or clear it`;
}

/** Types a message into the receiver's pane unless it is held; `failure` says why it was not typed,
 *  `typed` that its text sits in the composer without its Enter, `unseen` why its Enter started no turn. Logs nothing. */
export async function typeMessage(
  deps: TypingDeps,
  project: ProjectConfig,
  store: TeamStore,
  message: { team: string; from: string; to: string; text: string; id?: number; time?: string; commit?: string | null },
  reserve?: () => Promise<boolean>,
  cancelled?: () => boolean,
): Promise<Typed & { commit: string | null; reached: boolean; reserved: boolean }> {
  const commit = message.commit !== undefined ? message.commit : await deps.headCommit(project.directory);
  const { pane, hold } = await roleHold(deps, store, message.to);
  let failure = hold === HOLD_DRAFT ? await withDraftOwner(store, message.to, hold) : hold;
  // A newer message does not overtake one still waiting in the inbox; Aya's own rounds and tests do not queue behind reports.
  if (!failure && !goesStale(message)) {
    const [earlier] = await store.owed(message.to);
    if (earlier && earlier.id < (message.id ?? Infinity)) failure = `earlier message #${earlier.id} for it is still waiting; this one follows it`;
  }
  if (failure) debugLog(store, "hold", { to: message.to, from: message.from, id: message.id ?? null, reason: failure, typed: false });
  const untyped = { commit, failure, typed: false, afterEnter: false, reached: false, unseen: null, reserved: false };
  if (!pane || failure) return untyped;
  // Fail before typing: a removed team's message must not reach the pane and then report "nothing sent".
  await store.assertLive();
  // Read from the inbox or taken by another pass since: that reader has it.
  if (reserve && !(await reserve())) return untyped;
  const time = message.time ?? new Date().toISOString();
  let typed = false;
  let afterEnter = false;
  let unseen: string | null = null;
  try {
    const began = reserve && message.id !== undefined ? () => store.typingBegan(message.to, message.id!) : undefined;
    unseen = (await deps.deliver(pane, typedTeamMessage(message.team, message.from, time, commit, message.text), cancelled, undefined, began)) || null;
  } catch (err) {
    if (err instanceof PaneHeldError) {
      failure = err.reason;
      typed = err.typed;
    } else if (err instanceof TextPastedError) {
      typed = true;
      afterEnter = true;
      failure = ENTER_FAILED;
    } else {
      // The write error is written for the CLI; the team log and window get the gist.
      console.warn("[aya] team message to %s not typed:", message.to, err);
      failure = "did not take the text (it may have exited)";
    }
  }
  debugLog(store, failure ? "hold" : "turn", { to: message.to, from: message.from, id: message.id ?? null, ...(failure ? { reason: failure, typed } : { seen: unseen === null, why: unseen }) });
  return { commit, failure, typed, afterEnter: afterEnter || unseen !== null, reached: !failure || typed, unseen, reserved: Boolean(reserve) };
}

/** How a paste went: `typed` its text sits in the composer without a turn, `afterEnter` the reason says what came of
 *  the Enter Aya sent (else why the Enter was withheld), `unseen` why that Enter started no turn. */
interface Typed {
  failure: string | null;
  typed: boolean;
  afterEnter: boolean;
  unseen: string | null;
}

/** A message's log fields after its paste: it stays owed only when its text did not go in. */
function shownDelivery({ failure, typed, afterEnter, unseen }: Typed): Pick<TeamMessage, "delivered" | "held" | "typedOnly" | "afterEnter"> {
  const held = failure ?? unseen;
  return { delivered: !failure || typed, ...(held ? { held } : {}), ...(typed || unseen ? { typedOnly: true } : {}), ...(afterEnter ? { afterEnter } : {}) };
}

/** Types a logged message under its role's reservation (typing.json), the one path for every message but Aya's
 *  own (typeFromAya), and records how it went; a crash mid-paste leaves the reservation, which counts it as typed. */
export async function typeLogged(
  deps: TypingDeps,
  project: ProjectConfig,
  store: TeamStore,
  team: string,
  entry: TeamMessage,
  { cancelled, late }: { cancelled?: () => boolean; late?: { now: () => number } } = {},
): Promise<Typed & { entered: boolean }> {
  const result = await typeMessage(deps, project, store, { team, ...entry }, () => store.beginTyping(entry.to, entry.id), cancelled);
  const { failure, typed, afterEnter, unseen, reserved } = result;
  if (failure && !typed) await store.noteDelivery(entry.to, entry.id, { kind: "held", reason: failure });
  if (!reserved) return { ...result, entered: false };
  // Its text went in without a turn: the delivery note says why.
  const withheld = typed ? failure : unseen;
  try {
    if (!failure || typed) await store.markRead(entry.to, entry.id);
    if (withheld) await store.noteDelivery(entry.to, entry.id, { kind: "withheld", reason: withheld, ...(afterEnter ? { afterEnter } : {}) });
    await store.endTyping(entry.to);
  } catch (err) {
    if (failure && !typed) throw err;
    throw notRecorded(entry.to, err);
  }
  // Typed later: talk now, as it would have been had it gone in at once (the clock saw it held).
  if (late && !failure && !unseen) await noteTyped(store, entry, new Date(late.now()).toISOString());
  return { ...result, entered: !failure };
}

/** Logs a message as owed (`logged` runs then), and types it with typeLogged; an Enter that started no turn is a
 *  failure here, its text typed. */
export async function deliverAndLog(
  deps: TypingDeps,
  project: ProjectConfig,
  store: TeamStore,
  message: { team: string; from: string; to: string; text: string },
  logged?: () => Promise<void>,
  cancelled?: () => boolean,
): Promise<{ entry: TeamMessage; failure: string | null; typed: boolean; unseen: string | null }> {
  const commit = await deps.headCommit(project.directory);
  const entry = await store.append({ from: message.from, to: message.to, commit, text: oneLine(message.text), delivered: false });
  debugLog(store, "owed", { role: entry.to, id: entry.id, from: entry.from, change: "added", text: entry.text });
  await logged?.();
  const typed = await typeLogged(deps, project, store, message.team, entry, { cancelled });
  return { entry: { ...entry, ...shownDelivery(typed) }, failure: typed.failure ?? typed.unseen, typed: typed.typed || typed.unseen !== null, unseen: typed.unseen };
}

/** Types Aya's own message and logs it at its Enter (`onEnter` first): Aya going down while the turn is proven must not
 *  lose it or type a round twice. The turn is a note on the entry; `entry` null: no Enter, the caller logs it. */
export async function typeFromAya(
  deps: TypingDeps,
  project: ProjectConfig,
  store: TeamStore,
  message: { team: string; from: string; to: string; text: string },
  onEnter: () => Promise<void> = async () => {},
  cancelled?: () => boolean,
): Promise<Awaited<ReturnType<typeof typeMessage>> & { entry: TeamMessage | null }> {
  const commit = await deps.headCommit(project.directory);
  const at: { entered?: boolean; entry?: TeamMessage; lost?: unknown } = {};
  const record = async () => {
    if (at.entered) return;
    at.entered = true;
    try {
      await onEnter();
    } catch (err) {
      at.lost = err;
    }
    try {
      at.entry = await store.append({ from: message.from, to: message.to, commit, text: oneLine(message.text), delivered: true });
    } catch (err) {
      at.lost ??= err;
    }
  };
  const typed = await typeMessage({ ...deps, deliver: (pane, text, cancel, _entered, pasting) => deps.deliver(pane, text, cancel, record, pasting) }, project, store, { ...message, commit }, undefined, cancelled);
  // A deliver that does not say when its Enter went: recorded once it returns.
  if (!typed.failure) await record();
  if (at.lost !== undefined) throw notRecorded(message.to, at.lost);
  const note = typed.failure ?? typed.unseen;
  if (at.entry && note) await store.noteDelivery(message.to, at.entry.id, { kind: "withheld", reason: note, ...(typed.afterEnter ? { afterEnter: true } : {}) });
  return { ...typed, entry: at.entry ?? null };
}

/** The log entry of a message typeMessage handled; one whose Enter started no turn is typedOnly, so progress does not hear it. */
export function logTyped(
  store: TeamStore,
  message: { from: string; to: string; text: string },
  typed: Typed & { commit: string | null; reached: boolean },
): Promise<TeamMessage> {
  return store
    .append({ from: message.from, to: message.to, commit: typed.commit, text: oneLine(message.text), ...shownDelivery(typed) })
    .catch((err: unknown) => {
      if (!typed.reached) throw err;
      throw notRecorded(message.to, err);
    });
}

// Two agents answering each other can loop forever; a role that sends this many
// in a minute is refused until the minute passes, and the user sees why.
export const TEAM_SENDS_PER_MINUTE = 10;

/** A line from Aya in the team log, addressed to `to` and never typed. */
export const systemLine = (store: TeamStore, to: string, text: string) => store.append({ from: TEAM_SYSTEM_SENDER, to, commit: null, text, delivered: true });

/** One line in the team log per minute of refusals, so the window shows what the tool output alone said. */
async function logRefusedSend({ role, store }: Membership, to: string): Promise<void> {
  const text = `${role.id}'s message to ${to} was refused: ${TEAM_SENDS_PER_MINUTE} messages in the last minute`;
  const since = Date.now() - WALL_MINUTE_MS;
  const told = (await store.log()).some((l) => l.from === TEAM_SYSTEM_SENDER && l.text === text && Date.parse(l.time) >= since);
  if (!told) await systemLine(store, role.id, text);
}

/** Records a refused send for the lead's round (refused.jsonl) and returns the error to throw; a failed record must
 *  not change what the sender is told. */
async function refused(m: Membership, to: string, text: string, reason: string, error: string): Promise<Error> {
  await m.store.recordRefusal({ from: m.role.id, to, reason, text: oneLine(text) }).catch((err: unknown) => console.warn("[aya] refused send not recorded:", err));
  return new Error(error);
}

async function send(m: Membership, to: string, text: string, deps: TeamControlDeps): Promise<string> {
  const paused = m.store.pausedSince();
  if ((await m.store.state()).paused) throw await refused(m, to, text, "team paused", `team ${m.team.name} is paused; nothing was sent`);
  if ((await m.store.sentSince(m.role.id, Date.now() - WALL_MINUTE_MS)) >= TEAM_SENDS_PER_MINUTE) {
    await logRefusedSend(m, to);
    throw await refused(
      m,
      to,
      text,
      `${TEAM_SENDS_PER_MINUTE} sends in a minute`,
      `${m.role.id} sent ${TEAM_SENDS_PER_MINUTE} messages in the last minute; nothing was sent. If two roles keep answering each other, stop and report to the user`,
    );
  }
  if (!m.role.sendsTo.some((r) => r.to === to)) {
    const reason = m.team.roles.some((r) => r.id === to) ? "not in its sends-to" : "no such role";
    throw await refused(m, to, text, reason, `${m.role.id} does not send to ${to}; sends to: ${m.role.sendsTo.map((r) => r.to).join(", ") || "nobody"}`);
  }
  // A Pause while this waits for the receiver's pane (another message is being typed there) stops it there too.
  const { entry, failure, typed, unseen } = await deliverAndLog(deps, m.project, m.store, { team: m.team.name, from: m.role.id, to, text }, undefined, paused);
  // Its Enter went: the sender must not send it again, only learn that nothing showed it was taken.
  if (unseen) return `written to ${to}'s pane (message ${entry.id}), but ${unseen.replace(/^typed, /, "")}; it is not resent\n`;
  if (failure && typed) throw new Error(`${to}: ${failure}; message ${entry.id} is not resent`);
  if (failure) {
    const kept = `${to}: ${failure}; nothing was typed, message ${entry.id} is kept for aya team inbox`;
    // Kept for the inbox, but a role without a pane may never read it: the lead hears of it with the refusals.
    if (failure === NO_PANE_HOLD) throw await refused(m, to, text, `no pane, kept as #${entry.id}`, kept);
    throw new Error(kept);
  }
  return `written to ${to}'s pane (message ${entry.id}); this does not mean it was read\n`;
}

// oneLine again on the way out: entries stored before the text was cleaned on the way in.
function formatInbox(team: string, messages: TeamMessage[]): string {
  if (messages.length === 0) return "no unread messages\n";
  return messages.map((m) => `#${m.id} ${typedTeamMessage(team, m.from, m.time, m.commit, m.text)}\n`).join("");
}

/** The lead's `aya team pause`: the Pause button's pause, logged with who asked and why. */
async function pauseByLead(m: Membership, reason: string | undefined, pause: ((slug: string, team: string, by: string) => Promise<void>) | undefined): Promise<string> {
  const { team, role, store } = m;
  if (team.lead === null) throw new Error(`team ${team.name} has no lead; pause it in the Teams window`);
  if (team.lead !== role.id) throw new Error(`only the lead (${team.lead}) can pause the team; ${role.id} reports to the lead`);
  const state = await store.state();
  if (state.paused) return `team ${team.name} is already paused\n`;
  if (!state.running) throw new Error(`team ${team.name} is not running; nothing to pause`);
  if (!pause) throw new Error(TEAMS_UNAVAILABLE);
  await pause(m.project.slug, team.name, role.id);
  const why = reason ? `: ${oneLine(reason)}` : ".";
  await systemLine(store, role.id, `${role.id} (the lead) paused the team${why}`);
  return `team ${team.name} is paused; the user can resume it in the Teams window\n`;
}

export async function handleTeamRequest(
  request: TeamRequest,
  callerId: string | undefined,
  deps: TeamControlDeps,
  pause?: (slug: string, team: string, by: string) => Promise<void>,
): Promise<{ output: string; undo?: () => Promise<void> }> {
  const m = await membership(callerId, deps);
  if (request.type === "team-whoami") return { output: whoami(m) };
  if (request.type === "team-pause") return { output: await pauseByLead(m, request.text, pause) };
  if (request.type === "team-send") return { output: await send(m, request.role, request.text, deps) };
  const { taken: unread, giveBack } = await m.store.takeUnread(m.role.id);
  // Aya's own held rounds and delivery tests are stale by now, as in redelivery: marked read, not printed.
  const waiting = unread.filter((u) => !goesStale(u));
  // A held peer message read here is the progress its redelivery would have been.
  try {
    for (const held of waiting) await noteTyped(m.store, held, new Date().toISOString());
  } catch (err) {
    console.warn("[aya] team progress not updated by the inbox read:", err instanceof Error ? err.message : err);
  }
  // The reply may never reach the CLI (killed, its pane closed): then the messages are owed again.
  return { output: formatInbox(m.team.name, waiting), undo: giveBack };
}
