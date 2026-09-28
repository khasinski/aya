// Drafts a team role with Aya Intelligence from its name and the rest of the
// team; the model returns fields, the code normalizes them.

import type { RoleDraft, SendRoute, TeamDefinition, TeamRole } from "./types";

export type Chat = (system: string, user: string) => Promise<string>;

// A role draft is three short fields; room for them, not for an essay. Apple's
// on-device model took 13-44 s per draft when measured, so the wait is long.
export const ROLE_DRAFT_CHAT = { temperature: 0.2, maxTokens: 400, timeoutMs: 90_000 };

export const RESPONSIBILITIES_MAX = 400;
export const MUST_NOT_MAX = 120;
export const WHAT_MAX = 60;
const SYSTEM = "You define roles for a team of coding agents working in terminal panes. Return JSON only.";

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max).replace(/\s+\S*$/, "");
}

function roleIn(team: TeamDefinition, roleId: string): { role: TeamRole; others: TeamRole[] } {
  const role = team.roles.find((r) => r.id === roleId);
  if (!role) throw new Error(`no role "${roleId}" in the team`);
  return { role, others: team.roles.filter((r) => r.id && r.id !== roleId) };
}

export function roleDraftPrompt(team: TeamDefinition, roleId: string): string {
  const { role, others } = roleIn(team, roleId);
  const name = roleId.replace(/-/g, " ");
  const ids = others.map((r) => r.id);
  const known = others
    .filter((r) => r.responsibilities.trim() || r.mustNot.trim())
    .map((r) => `- ${r.id}: ${clip(r.responsibilities, RESPONSIBILITIES_MAX)}${r.mustNot.trim() ? ` Must not: ${clip(r.mustNot, MUST_NOT_MAX)}.` : ""}`);
  const receives = others.flatMap((r) =>
    r.sendsTo.filter((s) => s.to === roleId && s.what.trim()).map((s) => `${clip(s.what, WHAT_MAX)} from ${r.id}`),
  );
  const sends = role.sendsTo.map((s) => s.to).filter((to) => ids.includes(to));
  return [
    `Define the role "${name}" for a team of coding agents.`,
    ids.length ? `The other roles in the team: ${ids.join(", ")}.` : "It has no other roles yet.",
    ...(known.length ? ["What the other roles already do (do not repeat it):", ...known] : []),
    ...(receives.length ? [`It receives: ${receives.join("; ")}.`] : []),
    `Keep "${name}" to what its name says.`,
    ...(sends.length ? [`It sends to: ${sends.join(", ")}. For each, say what it sends.`] : []),
    'Reply with one JSON object: {"responsibilities": string, "mustNot": string, "sendsTo": {"<role>": "<what it sends them>"}}.',
    "responsibilities: two or three plain sentences on what this role does each round.",
    `mustNot: one mistake a ${name} is tempted to make, as a short phrase. Never forbid the work its name says it does.`,
    sends.length
      ? `sendsTo: exactly these roles: ${sends.join(", ")}, each with what it sends them in 2 to 6 words.`
      : "sendsTo: the roles it sends to, choose only from the other roles, each with what it sends them in 2 to 6 words.",
  ].join("\n");
}

/** {"b": "notes"}, ["b"] or [{"to": "b", "what": "notes"}]: every shape a model gives. */
function modelRoutes(value: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const add = (to: unknown, what: unknown) => {
    if (typeof to === "string" && !out.has(to)) out.set(to, typeof what === "string" ? what : "");
  };
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === "object") add((item as Record<string, unknown>).to ?? (item as Record<string, unknown>).role, (item as Record<string, unknown>).what);
      else add(item, "");
    }
  } else if (value && typeof value === "object") {
    for (const [to, what] of Object.entries(value)) add(to, what);
  }
  return out;
}

/** Throws unless the reply holds a JSON object with a must-not. Ticked routes
 *  win over the model's pick, and a what typed by hand wins over the model's. */
export function parseRoleDraft(reply: string, team: TeamDefinition, roleId: string): RoleDraft {
  const { role, others } = roleIn(team, roleId);
  const json = reply.match(/\{[\s\S]*\}/);
  let raw: Record<string, unknown> = {};
  try {
    raw = json ? (JSON.parse(json[0]) as Record<string, unknown>) : {};
  } catch {
    raw = {};
  }
  const mustNot = typeof raw.mustNot === "string" ? clip(raw.mustNot, MUST_NOT_MAX) : "";
  if (!mustNot) throw new Error("the model gave no usable draft; fill the role in by hand");
  const ids = new Set(others.map((r) => r.id));
  const said = modelRoutes(raw.sendsTo);
  const what = (to: string) => clip((said.get(to) ?? "").replace(/[()]/g, ""), WHAT_MAX);
  const ticked = role.sendsTo.filter((s) => ids.has(s.to));
  const sendsTo: SendRoute[] = ticked.length
    ? ticked.map((s) => ({ to: s.to, what: s.what.trim() || what(s.to) }))
    : [...said.keys()].filter((to) => ids.has(to)).map((to) => ({ to, what: what(to) }));
  const responsibilities =
    typeof raw.responsibilities === "string" ? clip(raw.responsibilities, RESPONSIBILITIES_MAX) : "";
  return { responsibilities, mustNot, sendsTo };
}

export async function draftRole(team: TeamDefinition, roleId: string, chat: Chat): Promise<RoleDraft> {
  return parseRoleDraft(await chat(SYSTEM, roleDraftPrompt(team, roleId)), team, roleId);
}
