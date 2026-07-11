// Harness-aware search ("History" mode of the in-pane find bar, experimental).
//
// Claude Code and Codex already persist every session as JSONL on disk —
// Claude under <configDir>/projects/<cwd-slug>/*.jsonl, Codex under
// <home>/sessions/YYYY/MM/DD/rollout-*.jsonl. Those transcripts are the real
// conversation history (full prompts and replies), unlike the terminal
// buffer, where TUI redraws shred the text. This module searches those files
// on demand, scoped to one tab's cwd. Aya never writes an index and does no
// work while idle: the agents pay the persistence cost, we only read.
//
// Perf model: discovery is a readdir walk (+ a first-line probe per Codex
// rollout, cached forever — that line is immutable). Parsing a transcript is
// cached per file keyed on mtime+size, so keystroke-to-keystroke a search is
// just substring scans over already-extracted message strings.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { expandUserPath } from "./usage";

export interface HarnessSearchRequest {
  agent: "claude" | "codex";
  /** The tab's working directory — scopes which sessions are searched. */
  cwd: string;
  /** Preset's config-dir override (may be ~-relative); defaults to the
   *  agent's standard home (~/.claude / ~/.codex). */
  configDir?: string;
  query: string;
}

export interface HarnessSearchHit {
  sessionId: string;
  role: "user" | "assistant";
  /** ISO timestamp of the matched message, when the transcript carried one. */
  timestamp?: string;
  /** Full message text (capped) — shown when the user expands the hit. */
  text: string;
  snippet: string;
  /** Offset/length of the first matched token WITHIN the snippet. */
  matchStart: number;
  matchLength: number;
}

// Newest sessions to search per query — bounds worst-case parse cost when a
// project has months of history. The freshest sessions are what per-tab
// search is for; the global Cmd+K can grow a real index later.
const MAX_SESSIONS_SCANNED = 12;
const MAX_HITS_TOTAL = 80;
const MAX_HITS_PER_SESSION = 20;
// A transcript bigger than this is skipped rather than read into memory.
const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024;
// Full message text returned with a hit (shown when the user expands it).
const MAX_HIT_TEXT_CHARS = 2000;
const SNIPPET_CONTEXT_BEFORE = 60;
const SNIPPET_CONTEXT_AFTER = 100;
// Parsed-transcript LRU: 12 sessions × a couple of live tabs fits well under
// this; beyond it the oldest parse is dropped, not the newest.
const PARSE_CACHE_MAX_FILES = 32;
// Codex session_meta is the first JSONL line; its base_instructions blob can
// be a few KB, so probe generously but never read the whole rollout for it.
const META_PROBE_BYTES = 64 * 1024;

export interface HarnessMessage {
  role: "user" | "assistant";
  text: string;
  /** Lowercased once at parse time so per-keystroke search never re-lowers. */
  lower: string;
  timestamp?: string;
}

interface SessionFile {
  file: string;
  sessionId: string;
  mtimeMs: number;
  size: number;
}

// ---- Message extraction ------------------------------------------------------

/** Claude Code's project-directory name for a cwd: every non-alphanumeric
 *  character becomes "-" (e.g. /Users/x/proj → -Users-x-proj). */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Injected wrappers, command echoes, and context blobs recorded as "user"
 *  messages that no human typed — not worth surfacing as history hits. */
function isNoiseUserText(text: string): boolean {
  const t = text.trimStart();
  return (
    !t ||
    t.startsWith("<") || // <command-name>, <system-reminder>, <environment_context>, …
    t.startsWith("Caveat:") ||
    t.startsWith("# AGENTS.md")
  );
}

function pushMessage(
  out: HarnessMessage[],
  role: "user" | "assistant",
  text: string,
  timestamp: string | undefined,
): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  if (role === "user" && isNoiseUserText(trimmed)) return;
  out.push({ role, text: trimmed, lower: trimmed.toLowerCase(), timestamp });
}

/** Text of a content-block array, keeping only real prose blocks (Claude
 *  "text", Codex "input_text"/"output_text") — tool calls/results are noise
 *  at this altitude. Unknown shapes are skipped, not errors: transcript
 *  formats are undocumented and drift between CLI versions. */
function textFromBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as { type?: unknown; text?: unknown };
    if (
      (b.type === "text" || b.type === "input_text" || b.type === "output_text") &&
      typeof b.text === "string"
    ) {
      parts.push(b.text);
    }
  }
  return parts.join("\n");
}

/** Extract searchable messages from Claude Code transcript JSONL lines. */
export function extractClaudeMessages(lines: string[]): HarnessMessage[] {
  const out: HarnessMessage[] = [];
  for (const line of lines) {
    if (!line.includes('"message"')) continue;
    let obj: {
      type?: unknown;
      isSidechain?: unknown;
      timestamp?: unknown;
      message?: { role?: unknown; content?: unknown };
    };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type !== "user" && obj.type !== "assistant") continue;
    // Sidechains are subagent transcripts — voluminous and not what the user
    // remembers seeing in the conversation.
    if (obj.isSidechain === true) continue;
    const role = obj.type;
    const timestamp =
      typeof obj.timestamp === "string" ? obj.timestamp : undefined;
    pushMessage(out, role, textFromBlocks(obj.message?.content), timestamp);
  }
  return out;
}

/** Extract searchable messages from Codex rollout JSONL lines. */
export function extractCodexMessages(lines: string[]): HarnessMessage[] {
  const out: HarnessMessage[] = [];
  for (const line of lines) {
    if (!line.includes('"response_item"')) continue;
    let obj: {
      type?: unknown;
      timestamp?: unknown;
      payload?: { type?: unknown; role?: unknown; content?: unknown };
    };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type !== "response_item") continue;
    const payload = obj.payload;
    if (!payload || payload.type !== "message") continue;
    if (payload.role !== "user" && payload.role !== "assistant") continue;
    const timestamp =
      typeof obj.timestamp === "string" ? obj.timestamp : undefined;
    pushMessage(out, payload.role, textFromBlocks(payload.content), timestamp);
  }
  return out;
}

// ---- Session discovery -------------------------------------------------------

async function claudeSessionFiles(
  cwd: string,
  configDir: string | undefined,
): Promise<SessionFile[]> {
  const base = expandUserPath(configDir?.trim() || "~/.claude");
  const dir = path.join(base, "projects", claudeProjectDirName(cwd));
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return []; // no history for this cwd (or no Claude at all)
  }
  const files: SessionFile[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const file = path.join(dir, name);
    try {
      const st = await fs.stat(file);
      files.push({
        file,
        sessionId: name.slice(0, -".jsonl".length),
        mtimeMs: st.mtimeMs,
        size: st.size,
      });
    } catch {
      // Vanished between readdir and stat.
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.slice(0, MAX_SESSIONS_SCANNED);
}

// A rollout's first line (session_meta, carrying the session cwd) never
// changes after the file is created, so this cache never invalidates.
const codexCwdCache = new Map<string, string | null>();

/** Read the session cwd from a rollout's first line without reading the file. */
async function codexSessionCwd(file: string): Promise<string | null> {
  const cached = codexCwdCache.get(file);
  if (cached !== undefined) return cached;
  let cwd: string | null = null;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, "r");
    const buf = Buffer.alloc(META_PROBE_BYTES);
    const { bytesRead } = await handle.read(buf, 0, META_PROBE_BYTES, 0);
    const chunk = buf.toString("utf-8", 0, bytesRead);
    const firstLine = chunk.slice(0, chunk.indexOf("\n"));
    const obj = JSON.parse(firstLine) as {
      type?: unknown;
      payload?: { cwd?: unknown };
    };
    if (obj.type === "session_meta" && typeof obj.payload?.cwd === "string") {
      cwd = obj.payload.cwd;
    }
  } catch {
    cwd = null;
  } finally {
    await handle?.close().catch(() => {});
  }
  codexCwdCache.set(file, cwd);
  return cwd;
}

async function codexSessionFiles(
  cwd: string,
  configDir: string | undefined,
): Promise<SessionFile[]> {
  const home = expandUserPath(configDir?.trim() || "~/.codex");
  const root = path.join(home, "sessions");
  const all: { file: string; mtimeMs: number; size: number }[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (
        entry.name.startsWith("rollout-") &&
        entry.name.endsWith(".jsonl")
      ) {
        try {
          const st = await fs.stat(full);
          all.push({ file: full, mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          // Vanished between readdir and stat.
        }
      }
    }
  }
  await walk(root);
  all.sort((a, b) => b.mtimeMs - a.mtimeMs);

  // Rollouts are project-agnostic on disk; keep the newest ones whose
  // session_meta cwd matches this tab. The probe is one small read per file,
  // once ever (cached), walking newest-first so a busy cwd fills up fast.
  const matched: SessionFile[] = [];
  for (const f of all) {
    if (matched.length >= MAX_SESSIONS_SCANNED) break;
    if ((await codexSessionCwd(f.file)) !== cwd) continue;
    const base = path.basename(f.file);
    matched.push({
      ...f,
      sessionId: base.slice("rollout-".length, -".jsonl".length),
    });
  }
  return matched;
}

// ---- Transcript parse cache --------------------------------------------------

interface ParsedTranscript {
  mtimeMs: number;
  size: number;
  messages: HarnessMessage[];
}

const parseCache = new Map<string, ParsedTranscript>();

/** Test hook: forget cached parses and Codex cwd probes. */
export function resetHarnessSearchCaches(): void {
  parseCache.clear();
  codexCwdCache.clear();
}

async function transcriptMessages(
  session: SessionFile,
  agent: "claude" | "codex",
): Promise<HarnessMessage[]> {
  const cached = parseCache.get(session.file);
  if (
    cached &&
    cached.mtimeMs === session.mtimeMs &&
    cached.size === session.size
  ) {
    // Re-insert to refresh LRU recency (Map preserves insertion order).
    parseCache.delete(session.file);
    parseCache.set(session.file, cached);
    return cached.messages;
  }
  let raw: string;
  try {
    raw = await fs.readFile(session.file, "utf-8");
  } catch {
    return [];
  }
  const lines = raw.split("\n");
  const messages =
    agent === "claude"
      ? extractClaudeMessages(lines)
      : extractCodexMessages(lines);
  parseCache.set(session.file, {
    mtimeMs: session.mtimeMs,
    size: session.size,
    messages,
  });
  while (parseCache.size > PARSE_CACHE_MAX_FILES) {
    const oldest = parseCache.keys().next().value;
    if (oldest === undefined) break;
    parseCache.delete(oldest);
  }
  return messages;
}

// ---- Matching ----------------------------------------------------------------

interface MessageMatch {
  snippet: string;
  matchStart: number;
  matchLength: number;
}

/** Case-insensitive AND over whitespace tokens (same semantics as the live
 *  PTY buffer search), snippet centered on the earliest token occurrence.
 *  Newlines in the snippet become spaces char-for-char so match offsets into
 *  the snippet stay valid. */
export function matchMessage(
  message: HarnessMessage,
  tokens: string[],
): MessageMatch | null {
  let earliest = -1;
  let earliestLength = 0;
  for (const token of tokens) {
    const idx = message.lower.indexOf(token);
    if (idx < 0) return null;
    if (earliest < 0 || idx < earliest) {
      earliest = idx;
      earliestLength = token.length;
    }
  }
  if (earliest < 0) return null;
  const start = Math.max(0, earliest - SNIPPET_CONTEXT_BEFORE);
  const end = Math.min(
    message.text.length,
    earliest + earliestLength + SNIPPET_CONTEXT_AFTER,
  );
  const prefix = start > 0 ? "…" : "";
  const suffix = end < message.text.length ? "…" : "";
  const body = message.text.slice(start, end).replace(/\s/g, " ");
  return {
    snippet: prefix + body + suffix,
    matchStart: prefix.length + (earliest - start),
    matchLength: earliestLength,
  };
}

// ---- Entry point ---------------------------------------------------------------

export async function searchHarnessSessions(
  req: HarnessSearchRequest,
): Promise<HarnessSearchHit[]> {
  const tokens = req.query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const sessions =
    req.agent === "claude"
      ? await claudeSessionFiles(req.cwd, req.configDir)
      : await codexSessionFiles(req.cwd, req.configDir);
  const hits: HarnessSearchHit[] = [];
  for (const session of sessions) {
    if (session.size > MAX_TRANSCRIPT_BYTES) continue;
    const messages = await transcriptMessages(session, req.agent);
    let sessionHits = 0;
    // Newest messages first within the (already newest-first) session order.
    for (let i = messages.length - 1; i >= 0; i--) {
      if (sessionHits >= MAX_HITS_PER_SESSION) break;
      const match = matchMessage(messages[i], tokens);
      if (!match) continue;
      const m = messages[i];
      hits.push({
        sessionId: session.sessionId,
        role: m.role,
        timestamp: m.timestamp,
        text:
          m.text.length > MAX_HIT_TEXT_CHARS
            ? m.text.slice(0, MAX_HIT_TEXT_CHARS) + "…"
            : m.text,
        snippet: match.snippet,
        matchStart: match.matchStart,
        matchLength: match.matchLength,
      });
      sessionHits += 1;
      if (hits.length >= MAX_HITS_TOTAL) return hits;
    }
  }
  return hits;
}
