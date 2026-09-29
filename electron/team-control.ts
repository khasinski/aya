// `aya team whoami|send|inbox`: the caller is known by its pane id, its role
// by the local assignments, and the team by the definition the user saved.

import type { TeamRequest } from "./control-protocol";
import { loadTeam, paneTeamRole } from "./team-files";
import type { TeamStore, TeamMessage } from "./team-store";
import type { ProjectConfig, TeamDefinition, TeamRole } from "./types";

export interface TeamControlDeps {
  teamHome: string;
  listProjects: () => Promise<ProjectConfig[]>;
  /** Types text into a pane and presses Enter; throws when the pane refuses,
   *  PaneHeldError when it is held by the time the text would go in. */
  deliver: (terminalId: string, text: string) => Promise<void>;
  headCommit: (directory: string) => Promise<string | null>;
  /** Set when Enter would do something else there; the message then waits. */
  holdReason: (terminalId: string) => Promise<string | null>;
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
  if (!project) throw new Error("this pane belongs to no open project");
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
  if (role.responsibilities) lines.push("", role.responsibilities);
  if (team.protocol) lines.push("", "protocol", team.protocol);
  return `${lines.join("\n")}\n`;
}

function clock(iso: string): string {
  const time = new Date(iso);
  return `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
}

export const NO_PANE_HOLD = "no pane assigned";

/** `deliver` found the pane held once it had the pane to itself. */
export class PaneHeldError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** The role's pane and why a message must not be typed into it now, or null. */
export async function roleHold(
  deps: Pick<TeamControlDeps, "holdReason">,
  store: TeamStore,
  role: string,
): Promise<{ pane: string | null; hold: string | null }> {
  const pane = await store.paneOf(role);
  return { pane, hold: pane ? await deps.holdReason(pane) : NO_PANE_HOLD };
}

/** Control bytes would submit extra turns without the header; flatten them. */
function oneLine(text: string): string {
  return text.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
}

/** Marks a message as a peer's dated report, not the user's instruction. */
function teamHeader(team: string, from: string, time: string, commit: string | null): string {
  return `[team ${team} | from ${from} | ${clock(time)}${commit ? ` | ${commit}` : ""}]`;
}

export function typedTeamMessage(team: string, from: string, time: string, commit: string | null, text: string): string {
  return oneLine(`${teamHeader(team, from, time, commit)} ${text}`);
}

/** Types a message into the receiver's pane unless it is held, and logs it
 *  either way; `failure` says why it was not typed. */
export async function deliverAndLog(
  deps: Pick<TeamControlDeps, "deliver" | "holdReason" | "headCommit">,
  project: ProjectConfig,
  store: TeamStore,
  message: { team: string; from: string; to: string; text: string },
): Promise<{ entry: TeamMessage; failure: string | null }> {
  const commit = await deps.headCommit(project.directory);
  const { pane, hold } = await roleHold(deps, store, message.to);
  let failure = hold;
  if (pane && !failure) {
    try {
      await deps.deliver(pane, typedTeamMessage(message.team, message.from, new Date().toISOString(), commit, message.text));
    } catch (err) {
      if (err instanceof PaneHeldError) {
        failure = err.reason;
      } else {
        // The write error is written for the CLI; the team log and window get the gist.
        console.warn("[aya] team message to %s not typed:", message.to, err);
        failure = "did not take the text (it may have exited)";
      }
    }
  }
  const entry = await store.append({
    from: message.from,
    to: message.to,
    commit,
    text: message.text,
    delivered: !failure,
    ...(failure ? { held: failure } : {}),
  });
  return { entry, failure };
}

// Two agents answering each other can loop forever; a role that sends this many
// in a minute is refused until the minute passes, and the user sees why.
export const TEAM_SENDS_PER_MINUTE = 10;
const MINUTE_MS = 60_000;

async function send(m: Membership, to: string, text: string, deps: TeamControlDeps): Promise<string> {
  if ((await m.store.state()).paused) throw new Error(`team ${m.team.name} is paused; nothing was sent`);
  if ((await m.store.sentSince(m.role.id, Date.now() - MINUTE_MS)) >= TEAM_SENDS_PER_MINUTE) {
    throw new Error(
      `${m.role.id} sent ${TEAM_SENDS_PER_MINUTE} messages in the last minute; nothing was sent. If two roles keep answering each other, stop and report to the user`,
    );
  }
  if (!m.role.sendsTo.some((r) => r.to === to)) {
    throw new Error(`${m.role.id} does not send to ${to}; sends to: ${m.role.sendsTo.map((r) => r.to).join(", ") || "nobody"}`);
  }
  const { entry, failure } = await deliverAndLog(deps, m.project, m.store, { team: m.team.name, from: m.role.id, to, text });
  if (failure) throw new Error(`${to}: ${failure}; nothing was typed, message ${entry.id} is kept for aya team inbox`);
  return `written to ${to}'s pane (message ${entry.id}); this does not mean it was read\n`;
}

function formatInbox(team: string, messages: TeamMessage[]): string {
  if (messages.length === 0) return "no unread messages\n";
  return messages.map((m) => `#${m.id} ${teamHeader(team, m.from, m.time, m.commit)} ${m.text}\n`).join("");
}

export async function handleTeamRequest(
  request: TeamRequest,
  callerId: string | undefined,
  deps: TeamControlDeps,
): Promise<{ output: string }> {
  const m = await membership(callerId, deps);
  if (request.type === "team-whoami") return { output: whoami(m) };
  if (request.type === "team-send") return { output: await send(m, request.role, request.text, deps) };
  const unread = await m.store.unread(m.role.id);
  if (unread.length) await m.store.markRead(m.role.id, unread[unread.length - 1].id);
  return { output: formatInbox(m.team.name, unread) };
}
