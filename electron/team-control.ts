// `aya team whoami|send|inbox`: the caller is known by its pane id, its role
// by the local assignments, and the team by the definition the user saved.

import { loadTeam, paneTeamRole } from "./team-files";
import type { TeamDefinition, TeamRole } from "./teams";
import type { TeamStore, TeamMessage } from "./team-store";
import type { ProjectConfig } from "./types";

export type TeamRequest =
  | { type: "team-whoami" }
  | { type: "team-inbox" }
  | { type: "team-send"; role: string; text: string };

export interface TeamControlDeps {
  teamHome: string;
  listProjects: () => Promise<ProjectConfig[]>;
  /** Types text into a pane and presses Enter; throws when the pane refuses. */
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
  const plays = await paneTeamRole(deps.teamHome, project, callerId);
  const team = plays && (await loadTeam(project, plays.team, plays.store));
  const role = team?.roles.find((r) => r.id === plays?.role);
  if (!plays || !team || !role) throw new Error("this pane has no team role; assign one from the tab menu");
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

/** Control bytes would submit extra turns without the header; flatten them. */
export function oneLine(text: string): string {
  return text.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
}

/** Marks a message as a peer's dated report, not the user's instruction. */
export function teamHeader(team: string, from: string, time: string, commit: string | null): string {
  return `[team ${team} | from ${from} | ${clock(time)}${commit ? ` | ${commit}` : ""}]`;
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
  const pane = await store.paneOf(message.to);
  let failure = pane ? await deps.holdReason(pane) : "no pane assigned";
  if (pane && !failure) {
    const header = teamHeader(message.team, message.from, new Date().toISOString(), commit);
    try {
      await deps.deliver(pane, oneLine(`${header} ${message.text}`));
    } catch (err) {
      // The write error is written for the CLI; the team log and window get the gist.
      console.warn(`[aya] team message to ${message.to} not typed:`, err);
      failure = "did not take the text (it may have exited)";
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

async function send(m: Membership, to: string, text: string, deps: TeamControlDeps): Promise<string> {
  if ((await m.store.state()).paused) throw new Error(`team ${m.team.name} is paused; nothing was sent`);
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
