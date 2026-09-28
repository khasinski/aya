// Drafts a team role from its name with Aya Intelligence. The model returns
// fields; the code normalizes them, and the user edits before Save team.

import type { RoleDraft } from "./types";

export type { RoleDraft };

/** Sends one system + user message and returns the reply text. */
export type Chat = (system: string, user: string) => Promise<string>;

/** A role as the editor holds it now, so a draft can build on the others. */
export type RolePeer = { id: string; responsibilities: string; mustNot: string };

// A role draft is three short fields; room for them, not for an essay. Apple's
// on-device model took 13-44 s per draft when measured, so the wait is long.
export const ROLE_DRAFT_CHAT = { temperature: 0.2, maxTokens: 400, timeoutMs: 90_000 };

const RESPONSIBILITIES_MAX = 400;
const MUST_NOT_MAX = 120;
const SYSTEM = "You define roles for a team of coding agents working in terminal panes. Return JSON only.";

function otherRoles(role: string, teamRoles: string[]): string[] {
  return teamRoles.filter((r) => r !== role && r !== role.replace(/ /g, "-"));
}

/** `picked`: the roles the user already ticked under Sends to. `peers`: the
 *  other roles' current text, so the draft does work none of them does. */
export function roleDraftPrompt(role: string, teamRoles: string[], picked: string[] = [], peers: RolePeer[] = []): string {
  const others = otherRoles(role, teamRoles);
  const sends = picked.filter((r) => others.includes(r));
  const known = peers
    .filter((p) => others.includes(p.id) && (p.responsibilities.trim() || p.mustNot.trim()))
    .map((p) => `- ${p.id}: ${clip(p.responsibilities, RESPONSIBILITIES_MAX)}${p.mustNot.trim() ? ` Must not: ${clip(p.mustNot, MUST_NOT_MAX)}.` : ""}`);
  return [
    `Define the role "${role}" for a team of coding agents.`,
    others.length ? `The other roles in the team: ${others.join(", ")}.` : "It has no other roles yet.",
    ...(known.length ? ["What the other roles already do (do not repeat it):", ...known] : []),
    `Keep "${role}" to what its name says.`,
    ...(sends.length ? [`It sends to: ${sends.join(", ")}. Describe its work with that in mind.`] : []),
    'Reply with one JSON object: {"responsibilities": string, "mustNot": string, "sendsTo": string[]}.',
    "responsibilities: two or three plain sentences on what this role does each round.",
    `mustNot: one mistake a ${role} is tempted to make, as a short phrase. Never forbid the work its name says it does.`,
    "sendsTo: which of the other roles it reports to, chosen only from the list above.",
  ].join("\n");
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max).replace(/\s+\S*$/, "");
}

/** Throws unless the reply holds a JSON object with a must-not. Ticked roles win. */
export function parseRoleDraft(reply: string, role: string, teamRoles: string[], picked: string[] = []): RoleDraft {
  const json = reply.match(/\{[\s\S]*\}/);
  let raw: Record<string, unknown> = {};
  try {
    raw = json ? (JSON.parse(json[0]) as Record<string, unknown>) : {};
  } catch {
    raw = {};
  }
  const mustNot = typeof raw.mustNot === "string" ? clip(raw.mustNot, MUST_NOT_MAX) : "";
  if (!mustNot) throw new Error("the model gave no usable draft; fill the role in by hand");
  const allowed = new Set(otherRoles(role, teamRoles));
  const sends = picked.length ? picked : Array.isArray(raw.sendsTo) ? raw.sendsTo : [];
  const sendsTo = [...new Set(sends.filter((r): r is string => typeof r === "string" && allowed.has(r)))];
  const responsibilities =
    typeof raw.responsibilities === "string" ? clip(raw.responsibilities, RESPONSIBILITIES_MAX) : "";
  return { responsibilities, mustNot, sendsTo };
}

export async function draftRole(
  role: string,
  teamRoles: string[],
  chat: Chat,
  picked: string[] = [],
  peers: RolePeer[] = [],
): Promise<RoleDraft> {
  return parseRoleDraft(await chat(SYSTEM, roleDraftPrompt(role, teamRoles, picked, peers)), role, teamRoles, picked);
}
