# Aya Search Plan (rev 2)

The current search is useful as a command palette but the terminal-output side
is weak: live rolling buffers only, exact substring on stripped raw PTY bytes,
no persistence, and bad behavior for Claude Code / Codex TUIs that repaint
constantly. This plan rebuilds the substrate and ships the TUI fix together,
so the first user-visible release is meaningful rather than "the old search
but persisted".

## Goals

- Search terminal output across restarts, not only live buffers.
- Match what users remember: commands, filenames, stack traces, errors, URLs,
  agent status text, and TUI-visible output.
- Excellent lexical recall before any semantic search.
- Local-first and private by default. No cloud.
- Index only PTY output Aya already displays plus `aya status` payloads.

## Non-goals

- No automation of Claude Code, Codex, or any provider-specific surface.
- Embeddings are not on the v1 path.
- No cloud indexing, ever, in this scope.
- Not a worktree/task database.

## Why this revision differs

The original plan sequenced FTS first, then UI polish, then TUI-aware
snapshots. That makes the first user-visible release underwhelming: it
persists today's bad results. Two changes:

1. **Ship the substrate and TUI snapshots together.** The persistence value
   only lands when the indexed content is actually usable. For shell tabs
   raw PTY lines are fine; for `claude` and `codex` tabs they are garbage.
   Without screen-snapshot indexing in the first release, users see "more
   of the same noise but persisted".
2. **Commit to operational constraints up front.** WAL mode, opinionated
   storage cap, per-session opt-out, and schema-migration discipline are
   non-optional. They are far cheaper to install now than retrofit later.

## Storage model (v1)

One SQLite database per Aya home:

```text
~/.aya/terminal-search.sqlite
~/.aya-dev/terminal-search.sqlite
```

Open with:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA user_version = 1;
```

WAL mode is non-negotiable: the indexer writes from main while the renderer
queries via IPC, and we cannot have writes blocking reads on a busy session.

### Schema

Deliberately small. No `terminals` or `projects` cache table: the JSON config
files remain the source of truth for metadata, and the FTS query layer joins
to them in memory if it ever needs richer per-project info.

```sql
CREATE TABLE terminal_sessions (
  id            TEXT PRIMARY KEY,
  terminal_id   TEXT NOT NULL,
  project_slug  TEXT NOT NULL,
  preset_id     TEXT NOT NULL,
  cwd           TEXT NOT NULL,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  excluded      INTEGER NOT NULL DEFAULT 0
    CHECK (excluded IN (0, 1))
);
CREATE INDEX idx_sessions_terminal_started
  ON terminal_sessions(terminal_id, started_at DESC);
CREATE INDEX idx_sessions_project_started
  ON terminal_sessions(project_slug, started_at DESC);

CREATE TABLE terminal_lines (
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
);
CREATE INDEX idx_lines_created_at      ON terminal_lines(created_at DESC);
CREATE INDEX idx_lines_terminal_created ON terminal_lines(terminal_id, created_at DESC);
CREATE INDEX idx_lines_session         ON terminal_lines(session_id, line_no);

CREATE VIRTUAL TABLE terminal_lines_fts USING fts5(
  text,
  project_slug UNINDEXED,
  terminal_id  UNINDEXED,
  session_id   UNINDEXED,
  preset_id    UNINDEXED,
  kind         UNINDEXED,
  content      = 'terminal_lines',
  content_rowid = 'id',
  tokenize     = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER terminal_lines_fts_ins AFTER INSERT ON terminal_lines BEGIN
  INSERT INTO terminal_lines_fts(rowid, text, project_slug, terminal_id, session_id, preset_id, kind)
  VALUES (new.id, new.text, new.project_slug, new.terminal_id, new.session_id, new.preset_id, new.kind);
END;

CREATE TRIGGER terminal_lines_fts_del AFTER DELETE ON terminal_lines BEGIN
  INSERT INTO terminal_lines_fts(terminal_lines_fts, rowid, text, project_slug, terminal_id, session_id, preset_id, kind)
  VALUES ('delete', old.id, old.text, old.project_slug, old.terminal_id, old.session_id, old.preset_id, old.kind);
END;
```

Denormalizing `project_slug`, `terminal_id`, `preset_id`, `cwd` into every
line row is a deliberate space-for-speed trade. FTS5 needs unindexed filter
columns next to the indexed text, and joins from FTS rowids back to a metadata
table at query time get slow once you have millions of lines.

`kind` semantics:

- `output`: ANSI-stripped, line-split raw PTY bytes. Good for shells.
  Imperfect for TUIs; that's what `screen` is for.
- `screen`: snapshots of the interpreted xterm.js buffer (what the user sees).
- `scrollback`: lines that scrolled off the visible viewport but were captured
  before xterm dropped them.
- `status`: payloads from `aya status` (idle / waiting / done / error / busy).

## Indexing pipeline

```
PTY chunk (electron/pty.ts)
        |
        v
indexer.ingestOutput(sessionId, chunk)
        - splits on '\n', strips ANSI, drops blank/decorative-only lines
        - buffers per-session lines into a write batch
        - flush every 250ms OR 256 lines OR end-of-session
        - INSERT INTO terminal_lines (kind='output', ...)

xterm snapshot (renderer)
        |
        v IPC: terminal:snapshot { sessionId, lines: [{lineNo, text}] }
        v
indexer.ingestScreen(sessionId, lines)
        - per-line content hash; skip if hash unchanged since last snapshot
        - INSERT INTO terminal_lines (kind='screen', ...)

aya status (electron/control.ts)
        |
        v
indexer.ingestStatus(sessionId, level, text)
        - INSERT INTO terminal_lines (kind='status', ...)
```

Operational rules:

- All writes go through a single per-DB queue. Main process. Sync better-sqlite3.
- Batching protects the UI thread. Single transaction per flush.
- Renderer snapshot pushes are debounced (~500ms per terminal) and ship only
  changed lines, identified by `(terminal_id, line_no)` plus content hash.
- After laptop wake or app foreground, a "catch up" flush runs immediately
  and the queue cap is checked: if it exceeds 5000 lines, the oldest pending
  data is dropped with a warning, not the newest.

## Sessions

A session is one PTY lifetime: id, terminal_id, project, cwd, started_at,
ended_at. When a terminal restarts (Shift+Enter) a new session starts.
This is also how history survives PTY death.

`excluded = 1` opts a session out of indexing. v1 sets this via a
`AYA_INDEX=0` env var or a per-project flag in `projects/<slug>.json`. Future
work can add a per-terminal UI toggle.

## Query layer

```ts
interface SearchQuery {
  text: string;                  // FTS5 MATCH expression, sanitized
  projectSlugs?: string[];       // filter
  terminalIds?: string[];        // filter
  presets?: string[];            // filter
  kinds?: Array<'output'|'screen'|'scrollback'|'status'>;
  since?: number;                // unix ms
  until?: number;                // unix ms
  limit?: number;                // default 100
}

interface SearchHit {
  lineId: number;
  sessionId: string;
  projectSlug: string;
  terminalId: string;
  presetId: string;
  cwd: string;
  kind: 'output'|'screen'|'scrollback'|'status';
  text: string;                  // raw line, not snippet
  snippet: string;               // FTS5 highlight('<mark>...</mark>')
  rank: number;                  // bm25 score, lower=better
  createdAt: number;
}
```

Ranking is a hand-rolled overlay on bm25:

- Multiply rank by `0.7` when `project_slug` is currently open in Aya.
- Multiply rank by `0.5` when `terminal_id` is currently the active tab.
- Multiply rank by `(1 - age_days/365)` clamped at `[0.5, 1]` for recency.
- `kind='status'` beats `kind='output'` at equal text; `kind='screen'`
  beats `kind='output'` for known TUI presets (`claude`, `codex`).
- Exact-phrase queries (`"..."` in the input) get a bonus.

Query parser is a small recursive-descent over:

```
query     := term (WS term)*
term      := filter | phrase | word | not
filter    := key ':' value
phrase    := '"' .*? '"'
word      := [^\s:"]+
not       := '-' (filter | phrase | word)
```

Keys: `project`, `terminal`, `preset`, `kind`, `cwd`, `today`, `yesterday`,
`since`.

## Pruning

Default policy: prune when DB exceeds 500 MB OR contains lines older than
90 days, whichever fires first. Pruning runs on app launch and every 6h
while running. Order:

1. Closed-project sessions oldest-first.
2. Open-project sessions oldest-first, but never the most-recent N=5 sessions
   per terminal.
3. Within a session, oldest lines first.

Settings exposes "Search storage usage" and "Clear all search history" so
the user has visibility and an out.

## Telemetry (local-only)

Every query / click pair lands in a rolling `search_events` table behind a
default-off setting:

```sql
CREATE TABLE search_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  query       TEXT NOT NULL,
  result_kind TEXT NOT NULL,
  clicked     INTEGER NOT NULL CHECK (clicked IN (0, 1)),
  rank_position INTEGER
);
```

Goal is private retrospection: "did the new ranking actually fix this?",
not analytics. Never leaves the machine.

## Build order

1. **Foundation (this branch)**: better-sqlite3 dep, db open + WAL + migrations
   framework + v1 schema. `output`-kind indexing wired from `electron/pty.ts`.
   Search API mirrors the current `searchPtyOutputs` shape so the renderer
   keeps working unchanged. Tests for migrations, indexer line-splitting,
   FTS-backed query.
2. **Renderer screen snapshots**: xterm buffer extraction + IPC + indexer
   `screen` kind. Debouncing + hash-dedup. Ranking boost for `screen` lines
   on Claude/Codex presets. This is the "search now finds what Claude
   actually showed me" release.
3. **Query parser + grouped UI**: parser, filter keys, ranking overlay,
   grouped result sections (Open terminals / Terminal output / Projects /
   Launchers).
4. **Transcript view + jump-to-hit**: clicking an output hit opens a
   read-only transcript anchored at the hit. Live xterm-scroll comes later;
   transcript first gives consistent UX regardless of buffer state.
5. **Pruning + storage UI in Settings**.
6. **Sessions/projects opt-out toggle in Settings**.
7. **Optional, later**: semantic search on aggregated blocks. Only if 1-6
   are clearly good.

## Open questions answered

- **History default**: 90 days OR 500 MB, whichever hits first.
- **Closed projects searchable**: yes, until pruned.
- **Per-project/session exclude**: yes, ship at v1 via env + JSON flag;
  UI toggle in step 6.
- **Redaction**: no automated redaction. Per-session opt-out covers it.
- **Cmd+K vs Cmd+Shift+F**: unified Cmd+K. Add a dedicated shortcut only
  if ranking proves it can't disambiguate.
- **xterm scrollback mirroring**: Aya does NOT try to mirror xterm's buffer.
  Index a normalized stream and let xterm own UI scrollback.

## Implementation skeleton

```
electron/
  search/
    db.ts          // openDatabase(path), connection pooling
    schema.ts      // numbered migrations, runMigrations(db)
    indexer.ts     // ingestOutput / ingestScreen / ingestStatus
    query.ts       // search(query): Promise<SearchHit[]>
    prune.ts       // pruneIfNeeded(db, policy)
    types.ts       // SearchQuery / SearchHit / SessionKey
src/
  hooks/
    useTerminalSnapshot.ts  // schedules screen-snapshot IPC
```

Tests sit next to the existing suite:

```
tests/
  search-schema.test.mjs
  search-indexer.test.mjs
  search-query.test.mjs
  search-prune.test.mjs
```

All tests use `:memory:` SQLite so they're hermetic and fast.

## Scope of step 1 (this branch)

- Add `better-sqlite3` to dependencies; rebuild for Electron.
- `electron/search/db.ts` + `schema.ts` with v1 migration.
- `electron/search/indexer.ts` with `ingestOutput`, session lifecycle hooks.
- Wire `electron/pty.ts` to call indexer on spawn / data / exit.
- `electron/search/query.ts` exposing `searchTerminals(query)`.
- Tests: schema v1 round-trip, line-split + ANSI strip, FTS query + filters.
- Renderer keeps its current `searchPtyOutputs` IPC name; the implementation
  becomes a thin shim over the new query layer.
- Telemetry, pruning, snapshots, and the new UI sections come in subsequent
  branches.
