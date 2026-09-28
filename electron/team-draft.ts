// Drafts a team role from its name with Aya Intelligence. The model returns
// fields; the code normalizes them, and the user edits before Save team.

import type { RoleDraft } from "./types";

export type { RoleDraft };

/** Sends one system + user message and returns the reply text. */
export type Chat = (system: string, user: string) => Promise<string>;

const RESPONSIBILITIES_MAX = 400;
const MUST_NOT_MAX = 120;
const SYSTEM = "You define roles for a team of coding agents working in terminal panes. Return JSON only.";

function otherRoles(role: string, teamRoles: string[]): string[] {
  return teamRoles.filter((r) => r !== role && r !== role.replace(/ /g, "-"));
}

/** `picked`: the roles the user already ticked under Sends to. */
export function roleDraftPrompt(role: string, teamRoles: string[], picked: string[] = []): string {
  const others = otherRoles(role, teamRoles);
  const sends = picked.filter((r) => others.includes(r));
  return [
    `Define the role "${role}" for a team of coding agents.`,
    others.length ? `The other roles in the team: ${others.join(", ")}.` : "It has no other roles yet.",
    ...(sends.length ? [`It sends to: ${sends.join(", ")}. Describe its work with that in mind.`] : []),
    'Reply with one JSON object: {"responsibilities": string, "mustNot": string, "sendsTo": string[]}.',
    "responsibilities: two or three plain sentences on what this role does each round.",
    'mustNot: the one thing this role must never do, as a short phrase, e.g. "edit code".',
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

export async function draftRole(role: string, teamRoles: string[], chat: Chat, picked: string[] = []): Promise<RoleDraft> {
  return parseRoleDraft(await chat(SYSTEM, roleDraftPrompt(role, teamRoles, picked)), role, teamRoles, picked);
}
