// Schema migrations + FTS shadow integrity. The triggers behind
// terminal_lines_fts are easy to break, so a round-trip insert/delete test
// catches them more reliably than reading the SQL.

import { test } from "node:test";
import assert from "node:assert/strict";
import { openSearchDatabase, closeSearchDatabase } from "../dist-electron/search/db.js";
import { latestSchemaVersion } from "../dist-electron/search/schema.js";

function open() {
  return openSearchDatabase({ filePath: ":memory:" });
}

test("opening an empty DB applies all migrations and sets user_version", () => {
  const db = open();
  try {
    const v = db.pragma("user_version", { simple: true });
    assert.equal(v, latestSchemaVersion());
  } finally {
    closeSearchDatabase(db);
  }
});

test("re-opening does not re-run migrations (idempotent)", async () => {
  const db = open();
  try {
    const before = db.pragma("user_version", { simple: true });
    // Simulate a second open by running migrations again. The CREATE TABLE
    // statements would throw if the user_version guard didn't gate them.
    const { runMigrations } = await import("../dist-electron/search/schema.js");
    runMigrations(db);
    const after = db.pragma("user_version", { simple: true });
    assert.equal(after, before);
  } finally {
    closeSearchDatabase(db);
  }
});

test("FTS5 insert trigger mirrors terminal_lines rows into the shadow table", () => {
  const db = open();
  try {
    db.prepare(`
      INSERT INTO terminal_sessions (id, terminal_id, project_slug, preset_id, cwd, started_at)
      VALUES ('s1', 't1', 'demo', 'claude', '/tmp', 0)
    `).run();
    db.prepare(`
      INSERT INTO terminal_lines
        (session_id, terminal_id, project_slug, preset_id, cwd, line_no, kind, text, created_at)
      VALUES
        ('s1', 't1', 'demo', 'claude', '/tmp', 0, 'output', 'permission denied opening /etc', 100)
    `).run();
    const rows = db.prepare(`
      SELECT terminal_lines.text FROM terminal_lines_fts
      JOIN terminal_lines ON terminal_lines.id = terminal_lines_fts.rowid
      WHERE terminal_lines_fts MATCH 'permission'
    `).all();
    assert.equal(rows.length, 1);
    assert.match(rows[0].text, /permission denied/);
  } finally {
    closeSearchDatabase(db);
  }
});

test("FTS5 delete trigger removes shadow rows when terminal_lines rows go away", () => {
  const db = open();
  try {
    db.prepare(`
      INSERT INTO terminal_sessions (id, terminal_id, project_slug, preset_id, cwd, started_at)
      VALUES ('s1', 't1', 'demo', 'claude', '/tmp', 0)
    `).run();
    db.prepare(`
      INSERT INTO terminal_lines
        (session_id, terminal_id, project_slug, preset_id, cwd, line_no, kind, text, created_at)
      VALUES
        ('s1', 't1', 'demo', 'claude', '/tmp', 0, 'output', 'hello world', 100)
    `).run();
    const lineId = db.prepare("SELECT id FROM terminal_lines").get().id;
    db.prepare("DELETE FROM terminal_lines WHERE id = ?").run(lineId);
    const remaining = db.prepare(`
      SELECT COUNT(*) AS c FROM terminal_lines_fts WHERE terminal_lines_fts MATCH 'hello'
    `).get();
    assert.equal(remaining.c, 0);
  } finally {
    closeSearchDatabase(db);
  }
});

test("ending a session cascades and removes its lines + FTS entries", () => {
  const db = open();
  try {
    db.prepare(`
      INSERT INTO terminal_sessions (id, terminal_id, project_slug, preset_id, cwd, started_at)
      VALUES ('s1', 't1', 'demo', 'claude', '/tmp', 0)
    `).run();
    db.prepare(`
      INSERT INTO terminal_lines
        (session_id, terminal_id, project_slug, preset_id, cwd, line_no, kind, text, created_at)
      VALUES
        ('s1', 't1', 'demo', 'claude', '/tmp', 0, 'output', 'doomed line', 100)
    `).run();
    db.prepare("DELETE FROM terminal_sessions WHERE id = 's1'").run();
    const remaining = db.prepare(`SELECT COUNT(*) AS c FROM terminal_lines`).get();
    assert.equal(remaining.c, 0);
    const ftsRemaining = db.prepare(`
      SELECT COUNT(*) AS c FROM terminal_lines_fts WHERE terminal_lines_fts MATCH 'doomed'
    `).get();
    assert.equal(ftsRemaining.c, 0);
  } finally {
    closeSearchDatabase(db);
  }
});

test("WAL mode is enabled on file-backed databases", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(tmpdir(), "aya-search-"));
  try {
    const db = openSearchDatabase({ filePath: path.join(dir, "search.sqlite") });
    try {
      const mode = db.pragma("journal_mode", { simple: true });
      assert.equal(String(mode).toLowerCase(), "wal");
    } finally {
      closeSearchDatabase(db);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("kind CHECK constraint rejects unknown values", () => {
  const db = open();
  try {
    db.prepare(`
      INSERT INTO terminal_sessions (id, terminal_id, project_slug, preset_id, cwd, started_at)
      VALUES ('s1', 't1', 'demo', 'claude', '/tmp', 0)
    `).run();
    assert.throws(() =>
      db.prepare(`
        INSERT INTO terminal_lines
          (session_id, terminal_id, project_slug, preset_id, cwd, line_no, kind, text, created_at)
        VALUES
          ('s1', 't1', 'demo', 'claude', '/tmp', 0, 'wat', 'x', 0)
      `).run(),
    );
  } finally {
    closeSearchDatabase(db);
  }
});
