// Switching a pane between its terminal and its Conversation GUI keeps the agent's conversation: both modes run the
// same CLI on the same session (Claude's transcript, Codex's rollout), so the other mode only has to resume its id.
// Going to the Conversation, Aya also reads the transcript's messages back, so the pane does not start out empty.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { codexHomeFor } from "./agent-brief";
import { claudeConfigDir, claudeProjectDirName } from "./claude-session";
import type { ConversationSnapshot } from "./gui-conversation-store";
import { isSafeSessionId } from "./osc-extractor";
import { pathExists } from "./path-exists";
import { expandUserPath } from "./usage";
import { CODEX_SESSIONS_SUBDIR, DEFAULT_CODEX_HOME } from "./usage-codex";

export type SwitchAgent = "claude" | "codex" | "pi" | "antigravity";
export interface TranscriptMessage { id: string; type: "user" | "assistant"; text: string }

const MESSAGE_LIMIT = 500;
const TAIL_BYTES = 8 * 1024 * 1024;

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});
const str = (value: unknown) => (typeof value === "string" ? value : "");

/** Claude Code wraps slash commands, hook output and reminders in tags; none of it is something the user typed. */
const CLAUDE_NOISE = /^\s*<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook)>/;

function claudeText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(record).filter((part) => part.type === "text").map((part) => str(part.text)).join("\n");
}

/** The user and assistant text of a Claude Code transcript (JSONL), oldest first; tool calls, tool results, thinking,
 *  side chains and meta lines are left out. An assistant message Claude wrote in several lines is one message. */
export function claudeTranscriptMessages(jsonl: string): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  const assistantIndex = new Map<string, number>();
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try { entry = record(JSON.parse(line)); } catch { continue; }
    if (entry.isSidechain === true || entry.isMeta === true || entry.isCompactSummary === true) continue;
    const message = record(entry.message);
    if (entry.type === "user" && message.role === "user") {
      const text = claudeText(message.content).trim();
      if (!text || CLAUDE_NOISE.test(text)) continue;
      out.push({ id: `claude-user-${str(entry.uuid) || out.length}`, type: "user", text });
    } else if (entry.type === "assistant") {
      const text = claudeText(message.content).trim();
      if (!text) continue;
      const messageId = str(message.id);
      const at = messageId ? assistantIndex.get(messageId) : undefined;
      if (at !== undefined && at === out.length - 1) { out[at] = { ...out[at]!, text: `${out[at]!.text}\n\n${text}` }; continue; }
      if (messageId) assistantIndex.set(messageId, out.length);
      out.push({ id: `claude-assistant-${messageId || str(entry.uuid) || out.length}-${out.length}`, type: "assistant", text });
    }
  }
  return out.slice(-MESSAGE_LIMIT);
}

/** The user and agent messages of a Codex rollout (JSONL), oldest first. Codex has written two shapes: event_msg
 *  `user_message` / `agent_message`, and later event_msg `item_completed` with UserMessage / AgentMessage items. */
export function codexRolloutMessages(jsonl: string, beforeOrdinal?: number): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try { entry = record(JSON.parse(line)); } catch { continue; }
    if (entry.type !== "event_msg") continue;
    // A later segment rewrote the thread from this ordinal on (Edit from here's rollback): what follows is gone.
    if (beforeOrdinal !== undefined && typeof entry.ordinal === "number" && entry.ordinal >= beforeOrdinal) continue;
    const payload = record(entry.payload);
    if (payload.type === "user_message" || payload.type === "agent_message") {
      const text = str(payload.message).trim();
      if (text) out.push({ id: `codex-${payload.type}-${out.length}`, type: payload.type === "user_message" ? "user" : "assistant", text });
      continue;
    }
    if (payload.type !== "item_completed") continue;
    const item = record(payload.item);
    if (item.type !== "UserMessage" && item.type !== "AgentMessage") continue;
    const text = (Array.isArray(item.content) ? item.content : []).map(record)
      .filter((part) => part.type === "text" || part.type === "Text").map((part) => str(part.text)).join("\n").trim();
    if (text) out.push({ id: `codex-${str(item.id) || out.length}`, type: item.type === "UserMessage" ? "user" : "assistant", text });
  }
  return out.slice(-MESSAGE_LIMIT);
}

/** The last `TAIL_BYTES` of a file, from its first whole line: a long session keeps its newest messages. */
async function readTail(file: string): Promise<string> {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
  } finally { await handle.close(); }
}

/** Claude's transcript for a session, by the cwd's project folder first, then in any project folder (a symlinked or
 *  very long cwd gets a name Aya cannot rebuild). */
export async function findClaudeTranscript(configDir: string | undefined, cwd: string, sessionId: string): Promise<string | null> {
  const projects = path.join(claudeConfigDir(configDir), "projects");
  const named = path.join(projects, claudeProjectDirName(cwd), `${sessionId}.jsonl`);
  if (await pathExists(named)) return named;
  const real = await fs.realpath(cwd).catch(() => cwd);
  const byReal = path.join(projects, claudeProjectDirName(real), `${sessionId}.jsonl`);
  if (await pathExists(byReal)) return byReal;
  for (const dir of await fs.readdir(projects).catch(() => [] as string[])) {
    const file = path.join(projects, dir, `${sessionId}.jsonl`);
    if (await pathExists(file)) return file;
  }
  return null;
}

/** Codex's rollout files for a thread, oldest first: sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl, then (Codex
 *  0.172) a segment rollout-<time>-<id>_<segment>.jsonl for each rollback of the thread, which goes on from the
 *  ordinal the rollback returned to. Newest days first, down to the day of the thread's first file. */
export async function findCodexRolloutSegments(home: string, threadId: string): Promise<string[]> {
  const root = path.join(home, CODEX_SESSIONS_SUBDIR);
  const desc = async (dir: string) => (await fs.readdir(dir).catch(() => [] as string[])).sort().reverse();
  const found: string[] = [];
  let days = 0;
  for (const year of await desc(root)) for (const month of await desc(path.join(root, year))) for (const day of await desc(path.join(root, year, month))) {
    if (++days > 400) return [];
    const dir = path.join(root, year, month, day);
    const names = (await desc(dir)).filter((name) => name.endsWith(`-${threadId}.jsonl`) || (name.includes(`-${threadId}_`) && name.endsWith(".jsonl")));
    found.push(...names.map((name) => path.join(dir, name)));
    if (names.some((name) => name.endsWith(`-${threadId}.jsonl`))) return found.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  }
  return [];
}

/** The rollout a Codex thread started in. */
export async function findCodexRollout(home: string, threadId: string): Promise<string | null> {
  return (await findCodexRolloutSegments(home, threadId))[0] ?? null;
}

/** The ordinal of a rollout's first line, which starts `{"timestamp":…,"ordinal":N,`; undefined for older rollouts. */
async function firstOrdinal(file: string): Promise<number | undefined> {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const match = /^[^\n]*?"ordinal":(\d+)/.exec(buffer.toString("utf8", 0, bytesRead));
    return match ? Number(match[1]) : undefined;
  } finally { await handle.close(); }
}

/** A Codex thread's messages across its rollout segments: each segment replaces what the one before held from the
 *  segment's first ordinal on, so the turns a rollback dropped stay out. */
export async function codexThreadMessages(files: string[]): Promise<TranscriptMessage[]> {
  let out: TranscriptMessage[] = [];
  let before: number | undefined;
  for (let index = files.length - 1; index >= 0; index--) {
    const messages = codexRolloutMessages(await readTail(files[index]!), before).map((m) => (files.length > 1 ? { ...m, id: `${m.id}-s${index}` } : m));
    out = [...messages, ...out];
    if (out.length >= MESSAGE_LIMIT || index === 0) break;
    before = await firstOrdinal(files[index]!);
    if (before === undefined) break;
  }
  return out.slice(-MESSAGE_LIMIT);
}

/** The transcript messages of a terminal session, or null when Aya cannot find the session on disk (it was never
 *  saved, or it belongs to an agent whose sessions Aya does not read). */
export async function terminalSessionMessages(agent: SwitchAgent, cwd: string, configDir: string | undefined, sessionId: string): Promise<TranscriptMessage[] | null> {
  if (agent === "claude") {
    const file = await findClaudeTranscript(configDir, cwd, sessionId);
    return file ? claudeTranscriptMessages(await readTail(file)) : null;
  }
  if (agent === "codex") {
    const home = codexHomeFor({ configDir }, DEFAULT_CODEX_HOME, expandUserPath, cwd) ?? DEFAULT_CODEX_HOME;
    const files = await findCodexRolloutSegments(home, sessionId);
    return files.length ? codexThreadMessages(files) : null;
  }
  return null;
}

export interface AdoptTerminalRequest { cwd: string; configDir?: string; agent: SwitchAgent; sessionId?: string }

/** The saved conversation a pane switching from its terminal opens with. It resumes the terminal's session when Aya
 *  finds it on disk; else it starts fresh and says so. The pane's own GUI choices (approval mode, model) carry over,
 *  and so does what the pane showed before when it is the same conversation (artifacts, turn diffs). */
export async function adoptTerminalSession(
  request: AdoptTerminalRequest,
  saved: ConversationSnapshot | null,
  read: typeof terminalSessionMessages = terminalSessionMessages,
): Promise<ConversationSnapshot> {
  const { cwd, configDir, agent } = request;
  const sessionId = request.sessionId && isSafeSessionId(request.sessionId) ? request.sessionId : undefined;
  const sameBinding = !!saved && saved.cwd === cwd && saved.configDir === configDir && (saved.agent || "codex") === agent;
  const keep = sameBinding ? saved!.view ?? {} : {};
  const prefs = Object.fromEntries(["permissionMode", "selectedModel", "effort", "drawer", "selected"].filter((key) => key in keep).map((key) => [key, keep[key]]));
  const messages = sessionId ? await read(agent, cwd, configDir, sessionId).catch(() => null) : null;
  const name = agent === "claude" ? "Claude" : agent === "codex" ? "Codex" : agent === "pi" ? "Pi" : "Antigravity";
  // Pi and Antigravity panes report no terminal session; their GUI resumes the id the conversation had, if any.
  const resumable = messages !== null || ((agent === "pi" || agent === "antigravity") && !!sessionId);
  if (!resumable) {
    return { cwd, configDir, agent, view: { ...prefs, importNotice: `Started a new ${name} conversation: Aya could not find the terminal session to continue${sessionId ? "" : " (the agent never reported one)"}.` } };
  }
  const sameConversation = sameBinding && saved!.threadId === sessionId;
  const shown = messages && messages.length ? messages : sameConversation && Array.isArray(keep.messages) ? keep.messages : [];
  return {
    cwd, configDir, agent, threadId: sessionId,
    view: {
      ...(sameConversation ? keep : prefs),
      messages: shown,
      busy: false, queue: [], turnOutcome: null,
      importNotice: `Continued the terminal session. ${name} keeps the whole conversation; tool calls from the terminal are not shown here.`,
    },
  };
}

/** Adds a terminal pane's `aya present` artifacts to the Conversation it switches to, so the drawer shows what the
 *  terminal presented. Those already in the Conversation keep their own (newer or equal) copy. */
export function withTerminalArtifacts(snapshot: ConversationSnapshot, terminalArtifacts: { id: string }[]): ConversationSnapshot {
  if (!terminalArtifacts.length) return snapshot;
  const view = { ...(snapshot.view ?? {}) };
  const existing = Array.isArray(view.artifacts) ? (view.artifacts as { id: string }[]) : [];
  const known = new Set(existing.map(artifact => artifact.id));
  // paneTuiArtifacts lists newest first; the drawer keeps them oldest first.
  view.artifacts = [...existing, ...[...terminalArtifacts].reverse().filter(artifact => !known.has(artifact.id))];
  return { ...snapshot, view };
}
