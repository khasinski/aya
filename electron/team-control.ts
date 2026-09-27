// `aya team whoami|send|inbox`: the caller is known by its pane id, its role
// by the local assignments, and the team by the definition the user saved.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parseTeamFile, type TeamDefinition, type TeamRole } from "./teams";
import { TeamStore, teamDir, type TeamMessage } from "./team-store";
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

async function teamNames(directory: string): Promise<string[]> {
  try {
    const files = await fs.readdir(path.join(directory, ".aya", "teams"));
    return files.filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
  } catch {
    return [];
  }
}

/** The team and role a pane plays in this project, or null. */
export async function paneTeamRole(
  teamHome: string,
  project: ProjectConfig,
  paneId: string,
): Promise<{ team: string; role: string } | null> {
  for (const team of await teamNames(project.directory)) {
    const role = await new TeamStore(teamDir(teamHome, project.slug, team)).roleOf(paneId);
    if (role) return { team, role };
  }
  return null;
}

/** The saved definition wins: repo edits apply only after Save team. */
export async function loadTeam(project: ProjectConfig, name: string, store: TeamStore): Promise<TeamDefinition> {
  const text =
    (await store.savedDefinition()) ??
    (await fs.readFile(path.join(project.directory, ".aya", "teams", `${name}.md`), "utf-8"));
  return parseTeamFile(name, text);
}

async function membership(callerId: string | undefined, deps: TeamControlDeps): Promise<Membership> {
  if (!callerId) throw new Error("run aya team inside an Aya pane");
  const project = (await deps.listProjects()).find((p) => p.tabs.some((t) => t.id === callerId));
  if (!project) throw new Error("this pane belongs to no open project");
  for (const name of await teamNames(project.directory)) {
    const store = new TeamStore(teamDir(deps.teamHome, project.slug, name));
    const roleId = await store.roleOf(callerId);
    if (!roleId) continue;
    const team = await loadTeam(project, name, store);
    const role = team.roles.find((r) => r.id === roleId);
    if (role) return { project, team, role, store };
  }
  throw new Error("this pane has no team role; assign one from the tab menu");
}

function whoami({ team, role }: Membership): string {
  const lines = [
    `team      ${team.name}`,
    `you       ${role.id}`,
    `sends to  ${role.sendsTo.join(", ") || "(nobody)"}`,
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

/** Marks a message as a peer's dated report, not the user's instruction. */
export function teamHeader(team: string, from: string, time: string, commit: string | null): string {
  return `[team ${team} | from ${from} | ${clock(time)}${commit ? ` | ${commit}` : ""}]`;
}

async function send(m: Membership, to: string, text: string, deps: TeamControlDeps): Promise<string> {
  if (await m.store.paused()) throw new Error(`team ${m.team.name} is paused; nothing was sent`);
  if (!m.role.sendsTo.includes(to)) {
    throw new Error(`${m.role.id} does not send to ${to}; sends to: ${m.role.sendsTo.join(", ") || "nobody"}`);
  }
  const commit = await deps.headCommit(m.project.directory);
  const time = new Date().toISOString();
  const pane = await m.store.paneOf(to);
  let failure: string | null = pane ? null : `${to} has no pane`;
  const held = pane ? await deps.holdReason(pane) : null;
  if (held) failure = `${to}'s pane ${held}, so nothing was typed`;
  if (pane && !held) {
    try {
      await deps.deliver(pane, `${teamHeader(m.team.name, m.role.id, time, commit)} ${text}`);
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
  }
  const entry = await m.store.append({ from: m.role.id, to, commit, text, delivered: failure === null });
  if (failure) throw new Error(`${failure}; message ${entry.id} is kept for aya team inbox`);
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
