// Per-session indexer: turns PTY chunks into normalized lines and writes
// them to the search database in batched transactions.
//
// We split on LF only. CR-only "lines" (cursor returns inside TUI repaints)
// are intentionally not broken: that content is better captured later by the
// 'screen' kind, which comes from xterm's interpreted buffer.
//
// Lines that are blank after ANSI strip are dropped. They contribute nothing
// to search recall and inflate storage.

import type Database from "better-sqlite3";
import type { LineKind, SessionKey } from "./types";

const DEFAULT_BATCH_LINES = 256;
const DEFAULT_FLUSH_MS = 250;

interface SessionRuntime {
  key: SessionKey;
  /** Partial last line of the most recent chunk, awaiting the next '\n'. */
  pending: string;
  /** Next line number to assign within this session. */
  nextLineNo: number;
  /** Queued lines awaiting flush. */
  batch: PendingLine[];
  /** Flush timer handle, if scheduled. */
  flushTimer: NodeJS.Timeout | null;
  /** True if the session was opted out of indexing. */
  excluded: boolean;
}

interface PendingLine {
  kind: LineKind;
  text: string;
  lineNo: number;
  createdAt: number;
}

/** Strips CSI / OSC / DCS escape sequences and remaining control chars.
 *  Matches the regex set used by src/bell.ts so output indexing and bell
 *  detection see identical "cleaned" text. */
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b[PX^_].*?\x1b\\/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

export interface IndexerOptions {
  batchLines?: number;
  flushMs?: number;
}

export class SearchIndexer {
  private readonly db: Database.Database;
  private readonly batchLines: number;
  private readonly flushMs: number;
  private readonly sessions = new Map<string, SessionRuntime>();
  private readonly insertSession: Database.Statement;
  private readonly closeSession: Database.Statement;
  private readonly insertLine: Database.Statement;

  constructor(db: Database.Database, opts: IndexerOptions = {}) {
    this.db = db;
    this.batchLines = opts.batchLines ?? DEFAULT_BATCH_LINES;
    this.flushMs = opts.flushMs ?? DEFAULT_FLUSH_MS;

    this.insertSession = db.prepare(`
      INSERT INTO terminal_sessions (id, terminal_id, project_slug, preset_id, cwd, started_at, excluded)
      VALUES (@id, @terminalId, @projectSlug, @presetId, @cwd, @startedAt, @excluded)
      ON CONFLICT(id) DO NOTHING
    `);
    this.closeSession = db.prepare(`
      UPDATE terminal_sessions SET ended_at = @endedAt WHERE id = @id AND ended_at IS NULL
    `);
    this.insertLine = db.prepare(`
      INSERT INTO terminal_lines
        (session_id, terminal_id, project_slug, preset_id, cwd, line_no, kind, text, created_at)
      VALUES
        (@sessionId, @terminalId, @projectSlug, @presetId, @cwd, @lineNo, @kind, @text, @createdAt)
    `);
  }

  /** Begin recording a new session. Idempotent on the session id. */
  startSession(key: SessionKey, opts: { startedAt?: number; excluded?: boolean } = {}): void {
    const startedAt = opts.startedAt ?? Date.now();
    const excluded = opts.excluded ? 1 : 0;
    this.insertSession.run({
      id: key.id,
      terminalId: key.terminalId,
      projectSlug: key.projectSlug,
      presetId: key.presetId,
      cwd: key.cwd,
      startedAt,
      excluded,
    });
    this.sessions.set(key.id, {
      key,
      pending: "",
      nextLineNo: 0,
      batch: [],
      flushTimer: null,
      excluded: !!opts.excluded,
    });
  }

  /** Mark a session ended. Flushes any remaining lines and the trailing
   *  partial. */
  endSession(sessionId: string, endedAt: number = Date.now()): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      // Treat the trailing partial as a final line so we don't lose the last
      // command output if the PTY exits without a newline.
      const tail = stripAnsi(s.pending).trimEnd();
      if (tail.length > 0) {
        s.batch.push({
          kind: "output",
          text: tail,
          lineNo: s.nextLineNo++,
          createdAt: endedAt,
        });
      }
      s.pending = "";
      this.flushNow(sessionId);
    }
    this.closeSession.run({ id: sessionId, endedAt });
    this.sessions.delete(sessionId);
  }

  /** Ingest a raw PTY chunk as 'output' kind. */
  ingestOutput(sessionId: string, chunk: string, now: number = Date.now()): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.excluded || chunk.length === 0) return;

    let combined = s.pending + chunk;
    let from = 0;
    let nlIdx = combined.indexOf("\n", from);
    while (nlIdx >= 0) {
      const raw = combined.slice(from, nlIdx);
      // Drop trailing CR from CRLF line endings before stripping.
      const trimmed = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      const cleaned = stripAnsi(trimmed).trimEnd();
      if (cleaned.length > 0) {
        s.batch.push({
          kind: "output",
          text: cleaned,
          lineNo: s.nextLineNo++,
          createdAt: now,
        });
      }
      from = nlIdx + 1;
      nlIdx = combined.indexOf("\n", from);
    }
    s.pending = combined.slice(from);

    this.maybeFlush(sessionId, s);
  }

  /** Ingest a status payload from `aya status` / control protocol. */
  ingestStatus(sessionId: string, text: string, now: number = Date.now()): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.excluded) return;
    const cleaned = text.trim();
    if (cleaned.length === 0) return;
    s.batch.push({
      kind: "status",
      text: cleaned,
      lineNo: s.nextLineNo++,
      createdAt: now,
    });
    this.maybeFlush(sessionId, s);
  }

  /** Ingest interpreted screen/scrollback lines coming from the renderer. */
  ingestScreen(
    sessionId: string,
    lines: ReadonlyArray<{ lineNo: number; text: string }>,
    kind: "screen" | "scrollback" = "screen",
    now: number = Date.now(),
  ): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.excluded || lines.length === 0) return;
    for (const ln of lines) {
      const cleaned = ln.text.trim();
      if (cleaned.length === 0) continue;
      s.batch.push({
        kind,
        text: cleaned,
        lineNo: ln.lineNo,
        createdAt: now,
      });
    }
    this.maybeFlush(sessionId, s);
  }

  /** Flush all pending lines for all sessions. Called on shutdown. */
  flushAll(): void {
    for (const id of this.sessions.keys()) this.flushNow(id);
  }

  private maybeFlush(sessionId: string, s: SessionRuntime): void {
    if (s.batch.length >= this.batchLines) {
      this.flushNow(sessionId);
      return;
    }
    if (s.flushTimer === null) {
      s.flushTimer = setTimeout(() => {
        s.flushTimer = null;
        this.flushNow(sessionId);
      }, this.flushMs);
      // Don't keep the event loop alive just for this timer.
      if (typeof s.flushTimer.unref === "function") s.flushTimer.unref();
    }
  }

  private flushNow(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.flushTimer) {
      clearTimeout(s.flushTimer);
      s.flushTimer = null;
    }
    if (s.batch.length === 0) return;

    const lines = s.batch;
    s.batch = [];
    const key = s.key;
    const insertLine = this.insertLine;

    const tx = this.db.transaction(() => {
      for (const ln of lines) {
        insertLine.run({
          sessionId,
          terminalId: key.terminalId,
          projectSlug: key.projectSlug,
          presetId: key.presetId,
          cwd: key.cwd,
          lineNo: ln.lineNo,
          kind: ln.kind,
          text: ln.text,
          createdAt: ln.createdAt,
        });
      }
    });
    tx();
  }
}

// Exposed for tests.
export const __testInternals = { stripAnsi };
