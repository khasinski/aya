// PTY chunk -> normalized line pipeline. Covers ANSI strip parity with the
// bell heuristic, CRLF handling, batching by line count, and per-session
// isolation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { openSearchDatabase, closeSearchDatabase } from "../dist-electron/search/db.js";
import { SearchIndexer } from "../dist-electron/search/indexer.js";

const SESSION = {
  id: "s-test-1",
  terminalId: "t-1",
  projectSlug: "demo",
  presetId: "claude",
  cwd: "/tmp/demo",
};

function setup() {
  const db = openSearchDatabase({ filePath: ":memory:" });
  // Small batch size makes the flush-trigger tests deterministic.
  const indexer = new SearchIndexer(db, { batchLines: 4, flushMs: 60_000 });
  return { db, indexer };
}

function readLines(db, sessionId) {
  return db.prepare(`
    SELECT line_no AS lineNo, text, kind FROM terminal_lines
    WHERE session_id = ? ORDER BY line_no
  `).all(sessionId);
}

test("splits a multi-line chunk on \\n and assigns sequential line numbers", () => {
  const { db, indexer } = setup();
  try {
    indexer.startSession(SESSION);
    indexer.ingestOutput(SESSION.id, "one\ntwo\nthree\n", 1000);
    indexer.endSession(SESSION.id, 2000);
    const rows = readLines(db, SESSION.id);
    assert.deepEqual(
      rows.map((r) => r.text),
      ["one", "two", "three"],
    );
    assert.deepEqual(
      rows.map((r) => r.lineNo),
      [0, 1, 2],
    );
    assert.ok(rows.every((r) => r.kind === "output"));
  } finally {
    closeSearchDatabase(db);
  }
});

test("buffers a trailing partial line until the next \\n arrives", () => {
  const { db, indexer } = setup();
  try {
    indexer.startSession(SESSION);
    indexer.ingestOutput(SESSION.id, "abc", 1000);
    indexer.ingestOutput(SESSION.id, "def\n", 1001);
    indexer.endSession(SESSION.id, 2000);
    const rows = readLines(db, SESSION.id);
    assert.deepEqual(rows.map((r) => r.text), ["abcdef"]);
  } finally {
    closeSearchDatabase(db);
  }
});

test("CRLF line endings produce the same line text as LF", () => {
  const { db, indexer } = setup();
  try {
    indexer.startSession(SESSION);
    indexer.ingestOutput(SESSION.id, "alpha\r\nbeta\r\n", 1000);
    indexer.endSession(SESSION.id, 2000);
    const rows = readLines(db, SESSION.id);
    assert.deepEqual(rows.map((r) => r.text), ["alpha", "beta"]);
  } finally {
    closeSearchDatabase(db);
  }
});

test("ANSI escape sequences are stripped before indexing", () => {
  const { db, indexer } = setup();
  try {
    indexer.startSession(SESSION);
    indexer.ingestOutput(
      SESSION.id,
      "\x1b[1;34mhello\x1b[0m \x1b[32mworld\x1b[0m\n",
      1000,
    );
    indexer.endSession(SESSION.id, 2000);
    const rows = readLines(db, SESSION.id);
    assert.deepEqual(rows.map((r) => r.text), ["hello world"]);
  } finally {
    closeSearchDatabase(db);
  }
});

test("OSC title-set sequences are stripped (only the visible part survives)", () => {
  const { db, indexer } = setup();
  try {
    indexer.startSession(SESSION);
    indexer.ingestOutput(
      SESSION.id,
      "\x1b]0;Aya - claude\x07Running tests...\n",
      1000,
    );
    indexer.endSession(SESSION.id, 2000);
    const rows = readLines(db, SESSION.id);
    assert.deepEqual(rows.map((r) => r.text), ["Running tests..."]);
  } finally {
    closeSearchDatabase(db);
  }
});

test("blank lines (whitespace / empty after strip) are dropped", () => {
  const { db, indexer } = setup();
  try {
    indexer.startSession(SESSION);
    indexer.ingestOutput(SESSION.id, "\n   \n\x1b[2K\nactual\n", 1000);
    indexer.endSession(SESSION.id, 2000);
    const rows = readLines(db, SESSION.id);
    assert.deepEqual(rows.map((r) => r.text), ["actual"]);
    // Line numbers reflect only kept lines, so search results have stable refs.
    assert.deepEqual(rows.map((r) => r.lineNo), [0]);
  } finally {
    closeSearchDatabase(db);
  }
});

test("a session ending with no trailing newline still records the final line", () => {
  const { db, indexer } = setup();
  try {
    indexer.startSession(SESSION);
    indexer.ingestOutput(SESSION.id, "last line no newline", 1000);
    indexer.endSession(SESSION.id, 2000);
    const rows = readLines(db, SESSION.id);
    assert.deepEqual(rows.map((r) => r.text), ["last line no newline"]);
  } finally {
    closeSearchDatabase(db);
  }
});

test("auto-flush fires when the batch reaches batchLines without waiting for end", () => {
  const { db, indexer } = setup();
  try {
    indexer.startSession(SESSION);
    indexer.ingestOutput(SESSION.id, "1\n2\n3\n4\n", 1000);
    // batchLines=4, so the 4th line should have triggered an automatic flush
    // already — without endSession, the rows should already be in the DB.
    const rows = readLines(db, SESSION.id);
    assert.equal(rows.length, 4);
    indexer.endSession(SESSION.id, 2000);
  } finally {
    closeSearchDatabase(db);
  }
});

test("two sessions running concurrently keep separate line counters", () => {
  const { db, indexer } = setup();
  try {
    const A = { ...SESSION, id: "sA", terminalId: "tA" };
    const B = { ...SESSION, id: "sB", terminalId: "tB" };
    indexer.startSession(A);
    indexer.startSession(B);
    indexer.ingestOutput(A.id, "A-one\nA-two\n", 1000);
    indexer.ingestOutput(B.id, "B-only\n", 1001);
    indexer.endSession(A.id, 2000);
    indexer.endSession(B.id, 2001);

    const rowsA = readLines(db, A.id);
    const rowsB = readLines(db, B.id);
    assert.deepEqual(rowsA.map((r) => r.text), ["A-one", "A-two"]);
    assert.deepEqual(rowsA.map((r) => r.lineNo), [0, 1]);
    assert.deepEqual(rowsB.map((r) => r.text), ["B-only"]);
    assert.deepEqual(rowsB.map((r) => r.lineNo), [0]);
  } finally {
    closeSearchDatabase(db);
  }
});

test("ingestStatus writes a 'status' kind row with the trimmed text", () => {
  const { db, indexer } = setup();
  try {
    indexer.startSession(SESSION);
    indexer.ingestStatus(SESSION.id, "  build passed  ", 1000);
    indexer.endSession(SESSION.id, 2000);
    const rows = readLines(db, SESSION.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].text, "build passed");
    assert.equal(rows[0].kind, "status");
  } finally {
    closeSearchDatabase(db);
  }
});

test("ingestScreen writes 'screen' kind rows preserving caller line numbers", () => {
  const { db, indexer } = setup();
  try {
    indexer.startSession(SESSION);
    indexer.ingestScreen(
      SESSION.id,
      [
        { lineNo: 10, text: "what you see" },
        { lineNo: 11, text: "is what you get" },
      ],
      "screen",
      1000,
    );
    indexer.endSession(SESSION.id, 2000);
    const rows = readLines(db, SESSION.id);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.lineNo), [10, 11]);
    assert.ok(rows.every((r) => r.kind === "screen"));
  } finally {
    closeSearchDatabase(db);
  }
});

test("excluded sessions accept ingest calls but write nothing", () => {
  const { db, indexer } = setup();
  try {
    indexer.startSession(SESSION, { excluded: true });
    indexer.ingestOutput(SESSION.id, "secret token=abcd\n", 1000);
    indexer.ingestStatus(SESSION.id, "still secret", 1001);
    indexer.endSession(SESSION.id, 2000);
    const rows = readLines(db, SESSION.id);
    assert.equal(rows.length, 0);
    const excluded = db
      .prepare("SELECT excluded FROM terminal_sessions WHERE id = ?")
      .get(SESSION.id).excluded;
    assert.equal(excluded, 1);
  } finally {
    closeSearchDatabase(db);
  }
});

test("ingest for an unknown session id is a silent no-op", () => {
  const { db, indexer } = setup();
  try {
    indexer.ingestOutput("nope", "hello\n", 1000);
    const rows = readLines(db, "nope");
    assert.equal(rows.length, 0);
  } finally {
    closeSearchDatabase(db);
  }
});

test("endSession sets ended_at on the session row", () => {
  const { db, indexer } = setup();
  try {
    indexer.startSession(SESSION, { startedAt: 100 });
    indexer.endSession(SESSION.id, 500);
    const row = db
      .prepare("SELECT started_at AS startedAt, ended_at AS endedAt FROM terminal_sessions WHERE id = ?")
      .get(SESSION.id);
    assert.equal(row.startedAt, 100);
    assert.equal(row.endedAt, 500);
  } finally {
    closeSearchDatabase(db);
  }
});
