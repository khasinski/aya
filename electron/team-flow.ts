// Flow preview: the routes are the ticked Sends to (code); the model only says
// what the team's text sends along each route, and which routes the text implies.

import { ROLE_DRAFT_CHAT, type Chat } from "./team-draft";
import type { FlowPreview, FlowRoute, TeamDefinition } from "./types";

// A phrase per route, so more room than a role draft; the same long wait.
export const FLOW_PREVIEW_CHAT = { ...ROLE_DRAFT_CHAT, maxTokens: 800 };

const CARRIES_MAX = 80;
const SYSTEM = "You read the definition of a team of coding agents and report what it says. Return JSON only.";

type Route = { from: string; to: string };

export function allowedRoutes(team: TeamDefinition): Route[] {
  const ids = new Set(team.roles.map((r) => r.id).filter(Boolean));
  const seen = new Set<string>();
  const routes: Route[] = [];
  for (const role of team.roles) {
    if (!role.id) continue;
    for (const to of role.sendsTo) {
      const key = `${role.id}>${to}`;
      if (to === role.id || !ids.has(to) || seen.has(key)) continue;
      seen.add(key);
      routes.push({ from: role.id, to });
    }
  }
  return routes;
}

function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Only role ids, responsibilities, must-nots and the protocol reach the model. */
export function flowPreviewPrompt(team: TeamDefinition): string {
  const roles = team.roles
    .filter((r) => r.id)
    .map((r) => `- ${r.id}. Responsibilities: ${flat(r.responsibilities) || "(none)"} Must not: ${flat(r.mustNot) || "(none)"}`);
  const routes = allowedRoutes(team).map((r) => `- ${r.from} -> ${r.to}`);
  return [
    "Roles:",
    ...roles,
    `Protocol: ${flat(team.protocol) || "(none)"}`,
    "Allowed routes (sender -> receiver):",
    ...(routes.length ? routes : ["(none)"]),
    "Steps, the same every time:",
    "1. For each allowed route, find where the text above says what the sender sends to that receiver.",
    '2. Write that as a short phrase of at most 8 words, or "unclear" when the text does not say.',
    "3. List the routes the text describes that are not in the allowed list, with what they carry.",
    'Do not fill a route because it seems likely for such a role; a route the text does not describe is "unclear".',
    'Reply with one JSON object: {"routes": [{"from": string, "to": string, "carries": string}], "unlisted": [{"from": string, "to": string, "carries": string}]}.',
  ].join("\n");
}

function carries(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = flat(value);
  if (!text || text.toLowerCase() === "unclear") return null;
  return text.length <= CARRIES_MAX ? text : text.slice(0, CARRIES_MAX).replace(/\s+\S*$/, "");
}

function entries(value: unknown): { from: unknown; to: unknown; carries: unknown }[] {
  return Array.isArray(value) ? value.filter((e) => e && typeof e === "object") : [];
}

/** Exactly one entry per allowed route, in checkbox order; throws on no JSON. */
export function parseFlowPreview(reply: string, team: TeamDefinition): FlowPreview {
  const json = reply.match(/\{[\s\S]*\}/);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json ? json[0] : "") as Record<string, unknown>;
  } catch {
    throw new Error("the model gave no usable explanation; try again");
  }
  const allowed = allowedRoutes(team);
  const said = new Map<string, string | null>();
  for (const e of entries(raw.routes)) {
    const key = `${e.from}>${e.to}`;
    if (!said.has(key)) said.set(key, carries(e.carries));
  }
  const routes: FlowRoute[] = allowed.map((r) => ({ ...r, carries: said.get(`${r.from}>${r.to}`) ?? null }));
  const ids = new Set(team.roles.map((r) => r.id).filter(Boolean));
  const taken = new Set(allowed.map((r) => `${r.from}>${r.to}`));
  const unlisted: FlowRoute[] = [];
  for (const e of entries(raw.unlisted)) {
    const text = carries(e.carries);
    if (typeof e.from !== "string" || typeof e.to !== "string" || !text) continue;
    const key = `${e.from}>${e.to}`;
    if (e.from === e.to || !ids.has(e.from) || !ids.has(e.to) || taken.has(key)) continue;
    taken.add(key);
    unlisted.push({ from: e.from, to: e.to, carries: text });
  }
  return { routes, unlisted };
}

export async function previewFlow(team: TeamDefinition, chat: Chat): Promise<FlowPreview> {
  return parseFlowPreview(await chat(SYSTEM, flowPreviewPrompt(team)), team);
}
