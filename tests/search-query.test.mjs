// Query layer: FTS match expression building, structured filters, ranking
// overlay. Each test seeds an in-memory DB through the indexer (rather than
// raw SQL) so the schema and indexer agree on what shape the data takes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { openSearchDatabase, closeSearchDatabase } from "../dist-electron/search/db.js";
import { SearchIndexer } from "../dist-electron/search/indexer.js";
import {
  buildMatchExpression,
  searchTerminalLines,
} from "../dist-electron/search/query.js";

function setup() {
  const db = openSearchDatabase({ filePath: ":memory:" });
  const indexer = new SearchIndexer(db, { batchLines: 1, flushMs: 60_000 });
  return { db, indexer };
}

function seed(indexer, sessionOverrides, lines, kindOverride = "output") {
  const session = {
    id: "s-" + Math.random().toString(36).slice(2, 8),
    terminalId: "t-default",
    projectSlug: "demo",
    presetId: "claude",
    cwd: "/tmp/demo",
    ...sessionOverrides,
  };
  indexer.startSession(session, { startedAt: 1000 });
  if (kindOverride === "output") {
    indexer.ingestOutput(session.id, lines.join("\n") + "\n", 1000);
  } else if (kindOverride === "status") {
    for (const ln of lines) indexer.ingestStatus(session.id, ln, 1000);
  } else if (kindOverride === "screen") {
    indexer.ingestScreen(
      session.id,
      lines.map((text, i) => ({ lineNo: i, text })),
      "screen",
      1000,
    );
  }
  indexer.endSession(session.id, 2000);
  return session;
}

// --- buildMatchExpression -----------------------------------------------

test("buildMatchExpression: plain words are AND'd (FTS5 default)", () => {
  assert.equal(buildMatchExpression("permission denied"), "permission denied");
});

test("buildMatchExpression: tokens with non-alphanumerics are quoted", () => {
  // Slashes, dots, dashes show up constantly in stack traces and paths.
  // Without quoting they confuse the FTS5 tokenizer.
  assert.equal(
    buildMatchExpression("src/bell.ts"),
    '"src/bell.ts"',
  );
});

test("buildMatchExpression: an unquoted token containing a double quote gets safely escaped", () => {
  // FTS5 requires "" for a literal quote inside a quoted token. A token like
  // `say"hi` must end up as `"say""hi"` so the FTS5 parser doesn't choke.
  assert.equal(buildMatchExpression('say"hi'), '"say""hi"');
});

test("buildMatchExpression: explicit phrase syntax is preserved", () => {
  assert.equal(buildMatchExpression('"permission denied"'), '"permission denied"');
});

test("buildMatchExpression: empty / whitespace-only input returns empty string", () => {
  assert.equal(buildMatchExpression(""), "");
  assert.equal(buildMatchExpression("   \t  "), "");
});

// --- end-to-end FTS queries --------------------------------------------

test("plain word search finds matching output lines across sessions", () => {
  const { db, indexer } = setup();
  try {
    seed(indexer, { id: "sa", terminalId: "ta", projectSlug: "alpha" }, [
      "compiling foo",
      "permission denied opening file",
    ]);
    seed(indexer, { id: "sb", terminalId: "tb", projectSlug: "beta" }, [
      "normal output",
      "all done",
    ]);
    const hits = searchTerminalLines(db, { text: "permission" });
    assert.equal(hits.length, 1);
    assert.match(hits[0].text, /permission denied/);
    assert.match(hits[0].snippet, /<mark>permission<\/mark>/);
    assert.equal(hits[0].projectSlug, "alpha");
  } finally {
    closeSearchDatabase(db);
  }
});

test("two unquoted tokens AND together (both must appear)", () => {
  const { db, indexer } = setup();
  try {
    seed(indexer, { id: "sa", terminalId: "ta" }, [
      "starting server on port 3000",
      "server bound to 127.0.0.1",
      "port already in use",
    ]);
    const hits = searchTerminalLines(db, { text: "server port" });
    assert.equal(hits.length, 1);
    assert.match(hits[0].text, /starting server on port/);
  } finally {
    closeSearchDatabase(db);
  }
});

test("quoted phrase requires consecutive tokens", () => {
  const { db, indexer } = setup();
  try {
    seed(indexer, { id: "sa", terminalId: "ta" }, [
      "permission denied opening file",
      "denied your permission earlier",
    ]);
    const hits = searchTerminalLines(db, { text: '"permission denied"' });
    assert.equal(hits.length, 1);
    assert.match(hits[0].text, /permission denied opening file/);
  } finally {
    closeSearchDatabase(db);
  }
});

test("projectSlugs filter excludes lines from other projects", () => {
  const { db, indexer } = setup();
  try {
    seed(indexer, { id: "sa", terminalId: "ta", projectSlug: "alpha" }, ["hit me"]);
    seed(indexer, { id: "sb", terminalId: "tb", projectSlug: "beta" }, ["hit me"]);
    const hits = searchTerminalLines(db, {
      text: "hit",
      projectSlugs: ["alpha"],
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].projectSlug, "alpha");
  } finally {
    closeSearchDatabase(db);
  }
});

test("terminalIds filter narrows results to specific terminals", () => {
  const { db, indexer } = setup();
  try {
    seed(indexer, { id: "sa", terminalId: "t-claude" }, ["unique-keyword"]);
    seed(indexer, { id: "sb", terminalId: "t-codex" }, ["unique-keyword"]);
    const hits = searchTerminalLines(db, {
      text: "unique-keyword",
      terminalIds: ["t-codex"],
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].terminalId, "t-codex");
  } finally {
    closeSearchDatabase(db);
  }
});

test("kinds filter restricts to output / status / screen / scrollback", () => {
  const { db, indexer } = setup();
  try {
    seed(indexer, { id: "sa", terminalId: "ta" }, ["build passed via output"]);
    seed(indexer, { id: "sb", terminalId: "tb" }, ["build passed via status"], "status");
    const justStatus = searchTerminalLines(db, {
      text: "build",
      kinds: ["status"],
    });
    assert.equal(justStatus.length, 1);
    assert.equal(justStatus[0].kind, "status");
  } finally {
    closeSearchDatabase(db);
  }
});

test("since / until restrict results by created_at window", () => {
  const { db, indexer } = setup();
  try {
    // The seed helper passes a fixed time of 1000, so we override here.
    const session = {
      id: "sa", terminalId: "ta",
      projectSlug: "demo", presetId: "claude", cwd: "/tmp",
    };
    indexer.startSession(session, { startedAt: 0 });
    indexer.ingestOutput(session.id, "early entry\n", 100);
    indexer.ingestOutput(session.id, "late entry\n", 999);
    indexer.endSession(session.id, 1000);

    const recent = searchTerminalLines(db, { text: "entry", since: 500 });
    assert.equal(recent.length, 1);
    assert.match(recent[0].text, /late entry/);

    const old = searchTerminalLines(db, { text: "entry", until: 500 });
    assert.equal(old.length, 1);
    assert.match(old[0].text, /early entry/);
  } finally {
    closeSearchDatabase(db);
  }
});

test("empty text returns no hits even when filters would match rows", () => {
  const { db, indexer } = setup();
  try {
    seed(indexer, { id: "sa", terminalId: "ta" }, ["anything"]);
    assert.deepEqual(searchTerminalLines(db, { text: "" }), []);
  } finally {
    closeSearchDatabase(db);
  }
});

test("ranking boosts hits in open projects above otherwise-equal hits", () => {
  const { db, indexer } = setup();
  try {
    const open = seed(
      indexer,
      { id: "sa", terminalId: "ta", projectSlug: "open-one" },
      ["compile error"],
    );
    const closed = seed(
      indexer,
      { id: "sb", terminalId: "tb", projectSlug: "closed-one" },
      ["compile error"],
    );
    const hits = searchTerminalLines(
      db,
      { text: "compile error" },
      { openProjectSlugs: new Set(["open-one"]) },
      { now: 2000 },
    );
    assert.equal(hits.length, 2);
    // Smaller rank = better. The open-project hit should come first.
    assert.equal(hits[0].projectSlug, "open-one");
    assert.ok(hits[0].rank < hits[1].rank, "open project hit should outrank closed-project hit");
    void open;
    void closed;
  } finally {
    closeSearchDatabase(db);
  }
});

test("ranking boosts hits in the active terminal even harder", () => {
  const { db, indexer } = setup();
  try {
    seed(indexer, { id: "sa", terminalId: "t-active" }, ["compile error"]);
    seed(indexer, { id: "sb", terminalId: "t-bystander" }, ["compile error"]);
    const hits = searchTerminalLines(
      db,
      { text: "compile error" },
      { activeTerminalId: "t-active" },
      { now: 2000 },
    );
    assert.equal(hits[0].terminalId, "t-active");
  } finally {
    closeSearchDatabase(db);
  }
});

test("ranking boosts 'status' kind above 'output' for equal text", () => {
  const { db, indexer } = setup();
  try {
    seed(indexer, { id: "sa", terminalId: "ta" }, ["release deployed"]);
    seed(indexer, { id: "sb", terminalId: "tb" }, ["release deployed"], "status");
    const hits = searchTerminalLines(db, { text: "release deployed" });
    assert.equal(hits[0].kind, "status");
  } finally {
    closeSearchDatabase(db);
  }
});

test("ranking boosts 'screen' kind above 'output' for TUI presets", () => {
  const { db, indexer } = setup();
  try {
    seed(
      indexer,
      { id: "sa", terminalId: "ta", presetId: "claude" },
      ["TUI redraw line"],
      "screen",
    );
    seed(
      indexer,
      { id: "sb", terminalId: "tb", presetId: "claude" },
      ["TUI redraw line"],
      "output",
    );
    const hits = searchTerminalLines(
      db,
      { text: "TUI redraw line" },
      { tuiPresets: new Set(["claude"]) },
    );
    assert.equal(hits[0].kind, "screen");
  } finally {
    closeSearchDatabase(db);
  }
});

test("results are capped by the limit option", () => {
  const { db, indexer } = setup();
  try {
    const lines = Array.from({ length: 25 }, (_, i) => `repeat-token row ${i}`);
    seed(indexer, { id: "sa", terminalId: "ta" }, lines);
    const hits = searchTerminalLines(db, { text: "repeat-token", limit: 5 });
    assert.equal(hits.length, 5);
  } finally {
    closeSearchDatabase(db);
  }
});

test("path-like tokens with slashes are findable (don't blow up the FTS parser)", () => {
  const { db, indexer } = setup();
  try {
    seed(indexer, { id: "sa", terminalId: "ta" }, [
      "loading src/components/SearchModal.tsx",
      "unrelated line",
    ]);
    const hits = searchTerminalLines(db, { text: "src/components" });
    assert.ok(hits.length >= 1);
    assert.match(hits[0].text, /src\/components\/SearchModal/);
  } finally {
    closeSearchDatabase(db);
  }
});
