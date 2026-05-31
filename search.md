# Aya Search Plan

Aya search should become a dependable way to recover what happened across
long-lived project terminals. The current search is useful as a command
palette, but terminal-output search is limited to live rolling PTY buffers,
exact substring matching, and snippets made from stripped raw PTY bytes. That
is why it misses things, ranks oddly, and feels weak for Claude Code/Codex
TUI sessions.

This plan keeps `Cmd+K` fast while building a real search substrate underneath
it.

## Goals

- Search terminal output across restarts, not only live buffers.
- Match what users remember: commands, filenames, stack traces, errors, URLs,
  agent status text, and TUI-visible output.
- Keep exact technical search excellent before adding semantic search.
- Stay local-first and private by default.
- Avoid scraping Claude Code/Codex internals. Aya should index only PTY output
  it already displays and side-channel statuses provided through `aya status`.

## Non-Goals

- Do not automate Claude Code, Codex, or any provider-specific hidden surface.
- Do not make embeddings required for normal search.
- Do not ship cloud indexing.
- Do not turn Aya into a worktree/task database as part of search.

## Phase 1: Durable SQLite + FTS

Build a local SQLite search store in Aya home, for example:

```text
~/.aya/terminal-search.sqlite
~/.aya-dev/terminal-search.sqlite
```

Use SQLite FTS5 as the first serious search backend. Terminal output is highly
technical; lexical recall matters more than semantic similarity.

Suggested schema:

```sql
projects(
  slug text primary key,
  name text not null,
  directory text not null,
  updated_at integer not null
)

terminals(
  id text primary key,
  project_slug text not null,
  preset_id text not null,
  name text not null,
  cwd text not null,
  updated_at integer not null
)

terminal_sessions(
  id text primary key,
  terminal_id text not null,
  project_slug text not null,
  preset_id text not null,
  cwd text not null,
  started_at integer not null,
  ended_at integer
)

terminal_chunks(
  id integer primary key,
  session_id text not null,
  terminal_id text not null,
  project_slug text not null,
  written_at integer not null,
  raw text not null
)

terminal_lines(
  id integer primary key,
  session_id text not null,
  terminal_id text not null,
  project_slug text not null,
  preset_id text not null,
  cwd text not null,
  line_no integer not null,
  kind text not null,
  text text not null,
  created_at integer not null
)

terminal_fts using fts5(
  text,
  project_slug unindexed,
  terminal_id unindexed,
  session_id unindexed,
  line_id unindexed,
  tokenize = 'unicode61'
)
```

Implementation notes:

- Index PTY data in the main process, next to `electron/pty.ts`.
- Append raw chunks for short-term replay/debug and normalized lines for search.
- Flush writes in small batches so busy terminals do not block the UI.
- Prune by policy: for example keep 30-90 days or a configurable size cap.
- Keep the existing rolling output buffer for terminal repaint; do not make
  search depend on it.
- Add migration/version metadata so schema changes are cheap later.

What Phase 1 should improve:

- Search survives app restarts.
- Results include older output from long-lived sessions.
- Snippets are based on durable indexed rows.
- Output search can return multiple hits per terminal, not only one terminal row.

## Phase 2: Query Parser, Ranking, and Search UI

Once FTS exists, make search pleasant rather than just technically available.

Query behavior:

- Plain words: AND search by default.
- Quoted text: exact phrase search, for example `"permission denied"`.
- Prefixes: support partial technical terms like `Permiss*` internally, without
  exposing SQL syntax.
- Filters:
  - `project:aya`
  - `terminal:claude`
  - `preset:codex`
  - `cwd:packages/api`
  - `today`
  - `yesterday`
  - `since:2d`
  - `kind:status`
  - `kind:output`
- Shortcuts:
  - `run claude` should still surface launchers.
  - Project and terminal names should still be fuzzy matched in memory.

Ranking:

- Exact project/terminal/launcher matches stay at the top for command-palette
  usage.
- Recent terminal output beats old terminal output when scores are otherwise
  close.
- Open project results beat closed project results.
- Active project output gets a small boost.
- Exact phrase hits beat token-only hits.
- Filename/path-like hits should rank strongly when the query contains slashes,
  dots, or extensions.
- Agent-provided statuses from `aya status` should rank higher than noisy TUI
  redraw text.

UI changes:

- Group results:
  - Open terminals
  - Terminal output
  - Projects
  - Launchers
- Terminal-output rows should show:
  - project name
  - terminal name
  - preset icon
  - relative time
  - highlighted snippet
  - optional count like `+4`
- Avoid duplicate rows when a terminal matched by name and content.
- Keep the modal fast for empty and short queries.
- Consider a distinct deep-search mode later, but do not split the UX too
  early. `Cmd+K` can remain one unified surface if ranking is good.

What Phase 2 should improve:

- Search feels forgiving.
- Results explain why they matched.
- Users can narrow scope without opening settings or a separate page.

## Phase 3: TUI-Aware Screen and Scrollback Indexing

Raw PTY bytes are not enough for Claude Code and Codex. TUIs redraw status
bars, move cursors, clear regions, and overwrite text. Stripping ANSI from raw
bytes can produce duplicated fragments, missing visible text, or nonsense
ordering.

Add a second source of truth: the interpreted terminal screen/scrollback.

Options:

1. Renderer-side extraction from xterm.js
   - Pros: closest to what the user actually sees.
   - Cons: renderer has to send searchable snapshots back to main.

2. Main-process headless terminal parser
   - Pros: indexing stays in main and can run when renderer remounts.
   - Cons: more implementation complexity and risk of diverging from xterm.js.

Preferred first implementation:

- Use renderer-side xterm.js buffer snapshots for visible/searchable lines.
- Debounce snapshot updates per terminal.
- Send only changed logical lines to main.
- Store them as `kind = 'screen'` or `kind = 'scrollback'`.
- Keep append-only transcript lines as `kind = 'output'`.
- Rank `screen`/`scrollback` higher for known TUI presets like Claude Code and
  Codex.

Deduplication:

- Normalize whitespace.
- Drop repeated identical status/footer lines within a short time window.
- Keep the latest copy of frequently redrawn lines.
- Avoid indexing blank/decorative-only lines.
- Track a stable line hash per terminal/session/source.

What Phase 3 should improve:

- Search finds what the user saw in Claude Code/Codex.
- Results are less polluted by control sequences and redraw noise.
- Snippets reflect visible terminal content instead of raw byte history.

## Phase 4: Jump to Hit

Search should not only find a match; it should take the user back to it.

For live terminals:

- Selecting an output result focuses the project and terminal.
- If the hit is in current xterm scrollback, scroll to it and highlight it.
- If the hit is no longer in current xterm scrollback but exists in SQLite,
  open a transcript/history view anchored at the hit.

For dead/restarted terminals:

- Show the stored transcript result.
- Offer a lightweight read-only transcript view.
- Include project, terminal, session start/end, cwd, and timestamp.

Implementation options:

- Keep xterm search addon for live in-buffer navigation.
- Store enough line metadata to map a result to an xterm buffer line when
  possible.
- Add a read-only transcript panel only after live jump works.

What Phase 4 should improve:

- Search becomes actionable instead of just a locator.
- Old agent output remains usable even after a PTY exits.

## Phase 5: Optional Semantic Search

This phase is theoretical until lexical search is excellent.

Embeddings could help with queries like:

- `that signing problem from yesterday`
- `where did codex discuss onboarding`
- `the permission issue`
- `what changed around release packaging`

But embeddings are not a replacement for FTS. They are weaker for exact
technical recall, filenames, symbols, command flags, and stack traces.

If added, keep it optional and local-first:

- Build semantic blocks from meaningful spans, not individual lines.
- Candidate block types:
  - `aya status done/error/waiting`
  - command + output receipt
  - agent summary-looking paragraphs
  - error blocks
  - user-pinned snippets
- Store embeddings in a separate table with model metadata.
- Prefer local embedding models if practical.
- If cloud embeddings are supported, require explicit opt-in.
- Never send hidden provider auth files, internal logs, or anything outside
  Aya-displayed terminal output/statuses.

Possible schema:

```sql
semantic_blocks(
  id integer primary key,
  project_slug text not null,
  terminal_id text not null,
  session_id text not null,
  source_line_start integer not null,
  source_line_end integer not null,
  text text not null,
  created_at integer not null,
  embedding_model text
)

semantic_vectors(
  block_id integer primary key,
  vector blob not null
)
```

Ranking model:

- Run FTS first.
- Run semantic search only when the query looks natural-language or FTS has
  weak results.
- Merge results with clear labels so users know whether a hit is exact or
  semantic.

What Phase 5 might improve:

- Recovery of vague memories.
- Project-memory style search.
- Better recall across long-running agent conversations.

## Suggested Build Order

1. Add SQLite FTS store and index normalized PTY lines.
2. Replace `ptySearch(query)` internals with SQLite-backed results while
   preserving the renderer API shape.
3. Add query parser and grouped UI.
4. Add renderer xterm snapshot indexing for TUI-visible content.
5. Add jump-to-live-hit.
6. Add transcript view for old hits.
7. Revisit semantic search only after the above feels solid.

## Open Questions

- How much history should Aya keep by default?
- Should closed projects remain searchable?
- Should users be able to exclude a project or terminal from indexing?
- Should private-looking output be redacted or should search remain a local
  all-output index with clear settings?
- Should `Cmd+K` and deep output search remain unified, or should Aya add a
  dedicated `Cmd+Shift+F` later?
- How much xterm scrollback should Aya preserve independently of xterm's own
  buffer?

