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
import { codexHomeFor } from "./agent-brief";
import { claudeProjectDirName } from "./claude-session";
import { DEFAULT_CLAUDE_CONFIG_DIR, expandUserPath } from "./usage";
import { CODEX_SESSIONS_SUBDIR, DEFAULT_CODEX_HOME } from "./usage-codex";
import { scanJsonlLinesReverse } from "./bounded-file-read";

export interface HarnessSearchRequest {
  agent: "claude" | "codex";
  /** The tab's working directory — scopes which sessions are searched. */
  cwd: string;
  /** Preset's config-dir override (may be ~-relative); defaults to the
   *  agent's standard home (~/.claude / CODEX_HOME, else ~/.codex). */
  configDir?: string;
  /** The preset's command; a leading CODEX_HOME=... there is codex's home. */
  command?: string;
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

export interface HarnessSearchResult {
  hits: HarnessSearchHit[];
  coverage: {
    partial: boolean;
    /** Oldest message timestamp examined, or the session's modified time. */
    searchedBackTo?: string;
    /** Some messages exceeded the safe per-line search limit. */
    longMessagesSkipped?: boolean;
  };
}

// Newest sessions to search per query — bounds worst-case parse cost when a
// project has months of history. The freshest sessions are what per-tab
// search is for; the global Cmd+K can grow a real index later.
const MAX_SESSIONS_SCANNED = 12;
const MAX_HITS_TOTAL = 80;
const MAX_HITS_PER_SESSION = 20;
const MAX_TRANSCRIPT_MESSAGES = 1000;
const MAX_CACHEABLE_TRANSCRIPT_BYTES = 512 * 1024;
const MAX_CACHED_TRANSCRIPT_BYTES_PER_FILE = 4 * 1024 * 1024;
const MAX_CACHED_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
const MAX_CACHED_MESSAGE_CHARS = 64 * 1024;
// Full message text returned with a hit (shown when the user expands it).
const MAX_HIT_TEXT_CHARS = 2000;
const SNIPPET_CONTEXT_BEFORE = 60;
const SNIPPET_CONTEXT_AFTER = 100;
// Parsed-transcript LRU; both file count and retained message bytes are capped.
const PARSE_CACHE_MAX_FILES = 32;
const CODEX_CWD_CACHE_MAX_FILES = 256;
// Codex session_meta is the first JSONL line; its base_instructions blob can
// be a few KB, so probe generously but never read the whole rollout for it.
const META_PROBE_BYTES = 64 * 1024;
export const HARNESS_SEARCH_TIME_BUDGET_MS = 3_000;
export const MAX_SEARCH_MESSAGE_BYTES = 64 * 1024;

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

interface SessionDiscovery {
  sessions: SessionFile[];
  partial: boolean;
}

type StopCheck = () => boolean;

export { claudeProjectDirName };

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

async function claudeSessionFiles(
  cwd: string,
  configDir: string | undefined,
  shouldStop: StopCheck,
): Promise<SessionDiscovery> {
  if (shouldStop()) return { sessions: [], partial: true };
  const base = expandUserPath(configDir?.trim() || DEFAULT_CLAUDE_CONFIG_DIR);
  const dir = path.join(base, "projects", claudeProjectDirName(cwd));
  let directory: Awaited<ReturnType<typeof fs.opendir>>;
  try {
    directory = await fs.opendir(dir);
  } catch {
    return { sessions: [], partial: false }; // no history for this cwd (or no Claude at all)
  }
  const files: SessionFile[] = [];
  let partial = false;
  try {
    for await (const entry of directory) {
      if (shouldStop()) {
        partial = true;
        break;
      }
      if (!entry.name.endsWith(".jsonl")) continue;
      const file = path.join(dir, entry.name);
      try {
        const st = await fs.stat(file);
        files.push({
          file,
          sessionId: entry.name.slice(0, -".jsonl".length),
          mtimeMs: st.mtimeMs,
          size: st.size,
        });
      } catch {
        // Vanished between readdir and stat.
      }
      if (shouldStop()) {
        partial = true;
        break;
      }
    }
  } finally {
    await directory.close().catch(() => {});
  }
  if (shouldStop()) partial = true;
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { sessions: files.slice(0, MAX_SESSIONS_SCANNED), partial };
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
  while (codexCwdCache.size > CODEX_CWD_CACHE_MAX_FILES) {
    const oldest = codexCwdCache.keys().next().value;
    if (oldest === undefined) break;
    codexCwdCache.delete(oldest);
  }
  return cwd;
}

async function codexSessionFiles(
  cwd: string,
  configDir: string | undefined,
  command: string | undefined,
  shouldStop: StopCheck,
): Promise<SessionDiscovery> {
  const home = codexHomeFor({ configDir, command }, DEFAULT_CODEX_HOME, expandUserPath, cwd);
  if (!home) return { sessions: [], partial: false };
  const root = path.join(home, CODEX_SESSIONS_SUBDIR);
  const all: { file: string; mtimeMs: number; size: number }[] = [];
  let partial = false;
  async function walk(dir: string): Promise<void> {
    if (shouldStop()) {
      partial = true;
      return;
    }
    let directory: Awaited<ReturnType<typeof fs.opendir>>;
    try {
      directory = await fs.opendir(dir);
    } catch {
      return;
    }
    try {
      for await (const entry of directory) {
        if (shouldStop()) {
          partial = true;
          return;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          if (partial) return;
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
          if (shouldStop()) {
            partial = true;
            return;
          }
        }
      }
    } finally {
      await directory.close().catch(() => {});
    }
  }
  await walk(root);
  if (shouldStop()) partial = true;
  all.sort((a, b) => b.mtimeMs - a.mtimeMs);

  // Rollouts are project-agnostic on disk; keep the newest ones whose
  // session_meta cwd matches this tab. The probe is one small read per file,
  // once ever (cached), walking newest-first so a busy cwd fills up fast.
  const matched: SessionFile[] = [];
  for (const f of all) {
    if (shouldStop()) {
      partial = true;
      break;
    }
    if (matched.length >= MAX_SESSIONS_SCANNED) break;
    const sessionCwd = await codexSessionCwd(f.file);
    if (shouldStop()) {
      partial = true;
      break;
    }
    if (sessionCwd !== cwd) continue;
    const base = path.basename(f.file);
    matched.push({
      ...f,
      sessionId: base.slice("rollout-".length, -".jsonl".length),
    });
  }
  return { sessions: matched, partial };
}

interface ParsedTranscript {
  mtimeMs: number;
  size: number;
  messages: HarnessMessage[];
  weight: number;
}

const parseCache = new Map<string, ParsedTranscript>();
let parseCacheBytes = 0;

/** Test hook: forget cached parses and Codex cwd probes. */
export function resetHarnessSearchCaches(): void {
  parseCache.clear();
  parseCacheBytes = 0;
  codexCwdCache.clear();
}

function cacheTranscript(file: string, parsed: ParsedTranscript): void {
  const old = parseCache.get(file);
  if (old) {
    parseCacheBytes -= old.weight;
    parseCache.delete(file);
  }
  if (parsed.weight > MAX_CACHED_TRANSCRIPT_BYTES_PER_FILE) return;
  parseCache.set(file, parsed);
  parseCacheBytes += parsed.weight;
  while (
    parseCache.size > PARSE_CACHE_MAX_FILES ||
    parseCacheBytes > MAX_CACHED_TRANSCRIPT_BYTES
  ) {
    const oldest = parseCache.keys().next().value;
    if (oldest === undefined) break;
    const entry = parseCache.get(oldest);
    parseCache.delete(oldest);
    if (entry) parseCacheBytes -= entry.weight;
  }
}

function cachedTranscript(session: SessionFile): HarnessMessage[] | null {
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
  if (cached) {
    parseCache.delete(session.file);
    parseCacheBytes -= cached.weight;
  }
  return null;
}

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

export interface HarnessSearchOptions {
  /** Internal deterministic hooks; production callers use the 3-second budget. */
  timeBudgetMs?: number;
  now?: () => number;
  chunkBytes?: number;
  onMaxCarryBytes?: (bytes: number) => void;
  onBytesRead?: (bytes: number) => void;
  signal?: AbortSignal;
}

export async function searchHarnessSessions(
  req: HarnessSearchRequest,
  options: HarnessSearchOptions = {},
): Promise<HarnessSearchResult> {
  const tokens = req.query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { hits: [], coverage: { partial: false } };
  const now = options.now ?? (() => performance.now());
  const deadline = now() + (options.timeBudgetMs ?? HARNESS_SEARCH_TIME_BUDGET_MS);
  const shouldStop = () => options.signal?.aborted === true || now() >= deadline;
  const discovery =
    req.agent === "claude"
      ? await claudeSessionFiles(req.cwd, req.configDir, shouldStop)
      : await codexSessionFiles(req.cwd, req.configDir, req.command, shouldStop);
  const sessions = discovery.sessions;
  const hits: HarnessSearchHit[] = [];
  let partial = discovery.partial;
  let longMessagesSkipped = false;
  let searchedBackToMs: number | undefined;
  let transcriptExamined = false;
  let lastTranscriptMtimeMs: number | undefined;
  const noteTimestamp = (timestamp: string | undefined) => {
    const parsed = timestamp ? Date.parse(timestamp) : NaN;
    if (Number.isFinite(parsed) && (searchedBackToMs === undefined || parsed < searchedBackToMs)) {
      searchedBackToMs = parsed;
    }
  };
  const appendHit = (session: SessionFile, message: HarnessMessage, sessionHits: number[]) => {
    const match = matchMessage(message, tokens);
    if (!match) return;
    if (sessionHits[0] >= MAX_HITS_PER_SESSION || hits.length >= MAX_HITS_TOTAL) {
      partial = true;
      return;
    }
    hits.push({
      sessionId: session.sessionId,
      role: message.role,
      timestamp: message.timestamp,
      text: message.text.length > MAX_HIT_TEXT_CHARS
        ? message.text.slice(0, MAX_HIT_TEXT_CHARS) + "…"
        : message.text,
      snippet: match.snippet,
      matchStart: match.matchStart,
      matchLength: match.matchLength,
    });
    sessionHits[0] += 1;
  };
  for (let sessionIndex = 0; sessionIndex < sessions.length; sessionIndex++) {
    const session = sessions[sessionIndex];
    if (shouldStop()) {
      partial = true;
      break;
    }
    const sessionHits = [0];
    let sessionOldestTimestampMs: number | undefined;
    const noteSessionTimestamp = (timestamp: string | undefined) => {
      const parsed = timestamp ? Date.parse(timestamp) : NaN;
      if (!Number.isFinite(parsed)) return;
      if (sessionOldestTimestampMs === undefined || parsed < sessionOldestTimestampMs) {
        sessionOldestTimestampMs = parsed;
      }
      noteTimestamp(timestamp);
    };
    const cached = session.size <= MAX_CACHEABLE_TRANSCRIPT_BYTES
      ? cachedTranscript(session)
      : null;
    if (cached) {
      transcriptExamined = true;
      lastTranscriptMtimeMs = session.mtimeMs;
      for (let i = cached.length - 1; i >= 0; i--) {
        noteSessionTimestamp(cached[i].timestamp);
        appendHit(session, cached[i], sessionHits);
      }
      if (hits.length >= MAX_HITS_TOTAL && sessionIndex < sessions.length - 1) {
        partial = true;
        break;
      }
      continue;
    }
    if (session.size > MAX_CACHEABLE_TRANSCRIPT_BYTES) cachedTranscript(session);

    const cacheMessages: HarnessMessage[] = [];
    let cacheWeight = 0;
    let cacheable = session.size <= MAX_CACHEABLE_TRANSCRIPT_BYTES;
    let scanResult: Awaited<ReturnType<typeof scanJsonlLinesReverse>> | undefined;
    try {
      scanResult = await scanJsonlLinesReverse(session.file, (line) => {
        const extracted = req.agent === "claude"
          ? extractClaudeMessages([line])
          : extractCodexMessages([line]);
        for (const message of extracted) {
          if (message.text.length > MAX_CACHED_MESSAGE_CHARS) {
            cacheable = false;
            partial = true;
            longMessagesSkipped = true;
            continue;
          }
          noteSessionTimestamp(message.timestamp);
          appendHit(session, message, sessionHits);
          if (cacheable && cacheMessages.length >= MAX_TRANSCRIPT_MESSAGES) {
            cacheable = false;
            cacheMessages.length = 0;
            cacheWeight = 0;
          }
          if (cacheable) {
            const bounded: HarnessMessage = { ...message, lower: message.text.toLowerCase() };
            const weight = (bounded.text.length + bounded.lower.length) * 2 + 128;
            if (cacheWeight + weight <= MAX_CACHED_TRANSCRIPT_BYTES_PER_FILE) {
              cacheMessages.push(bounded);
              cacheWeight += weight;
            } else {
              cacheable = false;
              cacheMessages.length = 0;
              cacheWeight = 0;
            }
          }
        }
      }, {
        maxBytes: Number.MAX_SAFE_INTEGER,
        maxLineBytes: MAX_SEARCH_MESSAGE_BYTES,
        shouldStop,
        chunkBytes: options.chunkBytes,
        onMaxCarryBytes: options.onMaxCarryBytes,
        onBytesRead: options.onBytesRead,
      });
    } catch {
      scanResult = undefined;
    }
    if (scanResult && scanResult.bytesRead > 0) {
      transcriptExamined = true;
      lastTranscriptMtimeMs = session.mtimeMs;
      if (sessionOldestTimestampMs === undefined && scanResult.truncated) {
        noteTimestamp(new Date(session.mtimeMs).toISOString());
      }
    }
    if (scanResult?.truncated) partial = true;
    if (scanResult?.skippedOversizedLines) {
      partial = true;
      longMessagesSkipped = true;
    }
    if (!scanResult || scanResult.truncated) cacheable = false;
    if (cacheable) {
      cacheTranscript(session.file, {
        mtimeMs: session.mtimeMs,
        size: session.size,
        messages: cacheMessages.reverse(),
        weight: cacheWeight,
      });
    }
    if (!scanResult || shouldStop()) {
      partial = true;
      break;
    }
    // Once the global result cap is reached, older sessions are intentionally
    // not visited; disclose that the returned result is a partial search.
    if (hits.length >= MAX_HITS_TOTAL && sessionIndex < sessions.length - 1) {
      partial = true;
      break;
    }
  }
  return {
    hits,
    coverage: {
      partial,
      ...(options.signal?.aborted ? { cancelled: true } : {}),
      ...(longMessagesSkipped ? { longMessagesSkipped: true } : {}),
      ...(!discovery.partial && partial && searchedBackToMs === undefined && transcriptExamined && lastTranscriptMtimeMs !== undefined
        ? { searchedBackTo: new Date(lastTranscriptMtimeMs).toISOString() }
        : {}),
      ...(!discovery.partial && partial && searchedBackToMs !== undefined
        ? { searchedBackTo: new Date(searchedBackToMs).toISOString() }
        : {}),
    },
  };
}
