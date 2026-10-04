// An agent that says it sent to a role while nothing from it reached that role (finding 17: small models wrote
// `aya team send lead "..."` as text, then "I sent the findings earlier"). Aya reads the agent's reply on its screen
// and the team log; the Teams window and the lead's round name the claim until a message to that role arrives.

import * as path from "node:path";
import { writeFileAtomic } from "./atomic-write";
import type { AgentKind } from "./presets";
import type { RefusedSend, Digest } from "./team-digest";
import { TEAM_FILES } from "./team-records";
import { readText, type TeamStore } from "./team-store";
import { typedTeamMessage } from "./team-control";
import { clock } from "./team-times";
import type { TeamMessage } from "./types";

/** A role's reply claimed a send to `to` after message #`turn` (at `since`) reached it. */
export interface Claim {
  to: string;
  turn: number;
  since: string;
}

/** Per role: the last turn read off its screen, and its claims no message has answered yet. */
export type ClaimsFile = Record<string, { checked: number; claims: Claim[] }>;

export const unsentNote = (role: string, to: string): string => `${role} says it sent to ${to}, nothing arrived`;

const squash = (text: string): string => text.replace(/\s+/g, "");
// What a CLI draws left of a typed message's rows: a prompt glyph or the message box's edge.
const MESSAGE_EDGE = /^[\s❯›>┃│]+/;

/** The rows of the agent's reply to `turn`, read below where its typed line is drawn; null when that line is not on
 *  the screen whole (scrolled out, read from the inbox, drawn some other way): then nothing is read. */
export function replyRows(screen: string, team: string, turn: Pick<TeamMessage, "from" | "time" | "commit" | "text">): string[] | null {
  const lines = screen.split("\n");
  const header = `[team ${team} | from ${turn.from} | ${clock(turn.time)}`;
  let at = lines.length - 1;
  while (at >= 0 && !lines[at].includes(header)) at -= 1;
  if (at < 0) return null;
  const want = squash(typedTeamMessage(team, turn.from, turn.time, turn.commit, turn.text));
  let seen = squash(lines[at].slice(lines[at].indexOf(header)));
  let next = at + 1;
  while (seen.length < want.length && next < lines.length) {
    const row = squash(lines[next].replace(MESSAGE_EDGE, ""));
    if (!want.startsWith(seen + row)) break;
    seen += row;
    next += 1;
  }
  return seen === want ? lines.slice(next) : null;
}

interface ReplyShape {
  /** The composer under the reply: the reply ends there. */
  composer: RegExp;
  /** A tool call's first row: it and the rows under it until the next block are the tool's, not the reply's. */
  tool: RegExp;
  /** A block's first row: the reply's text or the next tool call. */
  block: RegExp;
}

// Claude Code: "⏺ Bash(aya team send ...)" with "⎿" output under it, text as "⏺ ..." (recorded screens in tests).
// Codex: "• Ran aya team send ...", text as "• ..." (recorded busy-codex). OpenCode and the rest: not recorded with a
// tool call; a "$ command" row is read as the tool's, the rest as the reply.
const SHAPES: Partial<Record<AgentKind, ReplyShape>> = {
  claude: { composer: /^\s*─{8,}/, tool: /^\s*[⏺●]\s+[A-Za-z][\w.:-]*(?: [\w.:-]+)?\(/, block: /^\s*[⏺●]\s/ },
  codex: {
    composer: /^\s*›/,
    tool: /^\s*[•◦]\s+(?:Ran|Running|Explored|Exploring|Edited|Editing|Called|Calling|Read|Reading|Searched|Searching|Waited|Waiting|Interacted|Applied|Updated Plan)\b/,
    block: /^\s*[•◦]\s/,
  },
};
const OTHER: ReplyShape = { composer: /^\s*[┃╹]/, tool: /^\s*[$⚙]\s/, block: /^\s*\S/ };

/** The reply's own text, its tool calls and the composer under it left out. */
export function replyText(rows: readonly string[], agent: AgentKind | undefined): string {
  const shape = (agent && SHAPES[agent]) || OTHER;
  const out: string[] = [];
  let inTool = false;
  for (const row of rows) {
    if (shape.composer.test(row)) break;
    if (shape.tool.test(row)) inTool = true;
    else if (shape.block.test(row)) inTool = false;
    if (!inTool) out.push(row.replace(/^\s*[⏺●•◦]?\s*/, ""));
  }
  return out.join("\n");
}

const NAME = String.raw`([A-Za-z0-9_.-]+)`;
// The command as text: not after a path or a word, so "./aya" or "my-aya" is not it.
const COMMAND = new RegExp(String.raw`(?:^|[^\w./-])aya\s+team\s+send\s+(?:-\S+\s+)*["']?${NAME}`, "g");
// "I sent the findings to lead", "forwarded it to the tester"; within one sentence.
const SENT_TO = new RegExp(String.raw`\b(?:sent|forwarded|delivered|passed)\b[^.!?\n]{0,60}?\bto\s+(?:the\s+)?${NAME}`, "gi");
// "wysłałem raport do lead", "przesłałam do testera" (only the role's own name counts).
const SENT_DO = new RegExp(String.raw`(?<!\p{L})(?:wy|prze)sła(?:łem|łam|ł|ła|ło|li|ły|no|ne|ny)(?!\p{L})[^.!?\n]{0,60}?(?<!\p{L})do\s+${NAME}`, "giu");
// Not a claim: "haven't sent", "will be sent", "need to send", "nie wysłałem".
const NOT_DONE = /(?:\b(?:not|never|will|would|should|could|can|must|going to|need to|needs to|about to|yet to|if|once|nie)|n't)\s+(?:\w+\s+){0,2}$/i;

/** The roles the reply says it sent to: its command written as text, or the send told in words naming the role. */
export function claimedRecipients(reply: string, roles: readonly string[], self: string): string[] {
  const found = new Set<string>();
  const byName = new Map(roles.filter((r) => r !== self).map((r) => [r.toLowerCase(), r]));
  for (const pattern of [COMMAND, SENT_TO, SENT_DO]) {
    for (const m of reply.matchAll(pattern)) {
      const role = byName.get(m[1].toLowerCase().replace(/[.]+$/, ""));
      if (!role) continue;
      if (pattern !== COMMAND && NOT_DONE.test(reply.slice(Math.max(0, m.index - 40), m.index))) continue;
      found.add(role);
    }
  }
  return [...found];
}

/** The message that started the role's turn now: the last one typed into its pane with its Enter. */
export const turnOf = (log: readonly TeamMessage[], role: string): TeamMessage | undefined =>
  log.filter((m) => m.to === role && m.delivered && !m.typedOnly).at(-1);

/** Whether `role` sent to `to` after message #`turn`: logged (held or not), or run and refused. */
function sentAfter(log: readonly TeamMessage[], refused: readonly RefusedSend[], role: string, to: string, claim: Pick<Claim, "turn" | "since">): boolean {
  return log.some((m) => m.from === role && m.to === to && m.id > claim.turn) || refused.some((r) => r.from === role && r.to === to && Date.parse(r.time) >= Date.parse(claim.since));
}

/** The claims nothing answers: per role, the roles it says it sent to. */
export function unsentClaims(file: ClaimsFile, log: readonly TeamMessage[], refused: readonly RefusedSend[], roles: readonly string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const role of roles) {
    const open = (file[role]?.claims ?? []).filter((c) => roles.includes(c.to) && !sentAfter(log, refused, role, c.to, c)).map((c) => c.to);
    if (open.length) out[role] = [...new Set(open)];
  }
  return out;
}

const claimsPath = (store: TeamStore) => path.join(store.dir, TEAM_FILES.claims);

export async function readClaims(store: TeamStore): Promise<ClaimsFile> {
  try {
    const raw = JSON.parse((await readText(claimsPath(store))) ?? "{}") as ClaimsFile;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

export interface ClaimLook {
  team: string;
  roles: readonly string[];
  /** Per role, the pane's hold now (null: free). */
  holds: Record<string, string | null>;
  pane: (role: string) => Promise<string | null>;
  busy?: (pane: string) => Promise<boolean>;
  screen: (pane: string) => Promise<string | null>;
  agentOf: (pane: string) => Promise<AgentKind | undefined>;
}

/** Reads each free, idle role's reply to its current turn once, and keeps what it claims; a turn whose reply is not
 *  drawn yet is read again at the next look. */
export async function lookForClaims(store: TeamStore, look: ClaimLook): Promise<void> {
  const log = await store.annotatedLog();
  const file = await readClaims(store);
  let changed = false;
  for (const role of look.roles) {
    const turn = turnOf(log, role);
    if (!turn || file[role]?.checked === turn.id || look.holds[role] !== null) continue;
    const pane = await look.pane(role);
    if (!pane || (await look.busy?.(pane).catch(() => true))) continue;
    const screen = await look.screen(pane).catch(() => null);
    if (screen === null) continue;
    const rows = replyRows(screen, look.team, turn);
    const reply = rows === null ? "" : replyText(rows, await look.agentOf(pane));
    // Not drawn yet: the agent has not answered this turn.
    if (rows !== null && !reply.trim()) continue;
    const claims = file[role]?.claims ?? [];
    const kept = new Set(claims.map((c) => c.to));
    const fresh = claimedRecipients(reply, look.roles, role).filter((to) => !kept.has(to)).map((to) => ({ to, turn: turn.id, since: turn.time }));
    file[role] = { checked: turn.id, claims: [...claims, ...fresh] };
    changed = true;
  }
  if (!changed) return;
  // Claims a message answered since are done with.
  const refused = await store.refusals();
  for (const [role, entry] of Object.entries(file)) entry.claims = entry.claims.filter((c) => !sentAfter(log, refused, role, c.to, c));
  await writeFileAtomic(claimsPath(store), JSON.stringify(file));
}

/** The lead's round with the open claims as their own section. */
export function withUnsentSection(digest: Digest, unsent: Record<string, string[]>): Digest {
  const items = Object.entries(unsent).flatMap(([role, tos]) => tos.map((to) => unsentNote(role, to)));
  return items.length ? { ...digest, sections: [...digest.sections, { title: "Said it sent", items }] } : digest;
}
