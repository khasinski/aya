// Numbered migrations for the search database.
//
// Migration discipline: every schema change becomes a new entry in
// MIGRATIONS with a monotonically increasing `to` value matching
// PRAGMA user_version after it runs. Migrations are idempotent — they
// only run when the current user_version is less than their `to`.
//
// Triggers on terminal_lines automatically mirror inserts/deletes into the
// FTS5 shadow table. We use `content='terminal_lines'` so FTS5 stores only
// the inverted index, not a duplicate of the text.

import type Database from "better-sqlite3";

export interface Migration {
  to: number;
  description: string;
  /** Statements to run inside a transaction. Idempotent failures (table
   *  already exists) are not expected because we gate by user_version. */
  sql: string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    to: 1,
    description: "initial schema: sessions, lines, FTS5 shadow",
    sql: [
      `CREATE TABLE terminal_sessions (
        id            TEXT PRIMARY KEY,
        terminal_id   TEXT NOT NULL,
        project_slug  TEXT NOT NULL,
        preset_id     TEXT NOT NULL,
        cwd           TEXT NOT NULL,
        started_at    INTEGER NOT NULL,
        ended_at      INTEGER,
        excluded      INTEGER NOT NULL DEFAULT 0
          CHECK (excluded IN (0, 1))
      )`,
      `CREATE INDEX idx_sessions_terminal_started
        ON terminal_sessions(terminal_id, started_at DESC)`,
      `CREATE INDEX idx_sessions_project_started
        ON terminal_sessions(project_slug, started_at DESC)`,

      `CREATE TABLE terminal_lines (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id    TEXT NOT NULL,
        terminal_id   TEXT NOT NULL,
        project_slug  TEXT NOT NULL,
        preset_id     TEXT NOT NULL,
        cwd           TEXT NOT NULL,
        line_no       INTEGER NOT NULL,
        kind          TEXT NOT NULL
          CHECK (kind IN ('output', 'screen', 'scrollback', 'status')),
        text          TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES terminal_sessions(id) ON DELETE CASCADE
      )`,
      `CREATE INDEX idx_lines_created_at
        ON terminal_lines(created_at DESC)`,
      `CREATE INDEX idx_lines_terminal_created
        ON terminal_lines(terminal_id, created_at DESC)`,
      `CREATE INDEX idx_lines_session
        ON terminal_lines(session_id, line_no)`,

      `CREATE VIRTUAL TABLE terminal_lines_fts USING fts5(
        text,
        project_slug UNINDEXED,
        terminal_id  UNINDEXED,
        session_id   UNINDEXED,
        preset_id    UNINDEXED,
        kind         UNINDEXED,
        content      = 'terminal_lines',
        content_rowid = 'id',
        tokenize     = 'unicode61 remove_diacritics 2'
      )`,

      `CREATE TRIGGER terminal_lines_fts_ins AFTER INSERT ON terminal_lines BEGIN
        INSERT INTO terminal_lines_fts(rowid, text, project_slug, terminal_id, session_id, preset_id, kind)
        VALUES (new.id, new.text, new.project_slug, new.terminal_id, new.session_id, new.preset_id, new.kind);
      END`,

      `CREATE TRIGGER terminal_lines_fts_del AFTER DELETE ON terminal_lines BEGIN
        INSERT INTO terminal_lines_fts(terminal_lines_fts, rowid, text, project_slug, terminal_id, session_id, preset_id, kind)
        VALUES ('delete', old.id, old.text, old.project_slug, old.terminal_id, old.session_id, old.preset_id, old.kind);
      END`,
    ],
  },
];

/** Apply any migrations newer than the current user_version. Safe to call on
 *  every open. */
export function runMigrations(db: Database.Database): void {
  const current = (db.pragma("user_version", { simple: true }) as number) ?? 0;
  for (const m of MIGRATIONS) {
    if (m.to <= current) continue;
    const tx = db.transaction(() => {
      for (const stmt of m.sql) db.exec(stmt);
      db.pragma(`user_version = ${m.to}`);
    });
    tx();
  }
}

/** Latest schema version this build knows how to produce. */
export function latestSchemaVersion(): number {
  return MIGRATIONS[MIGRATIONS.length - 1]?.to ?? 0;
}
