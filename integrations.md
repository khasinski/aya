# Aya TUI Integration

How TUI apps (Claude Code, Codex, Aider, htop, anything) can opt into
Aya-specific affordances without coupling to Aya internals, and how Aya
captures useful signals from TUIs that won't be modified.

## Why this matters

Aya today knows almost nothing about what a TUI is doing beyond
"running / waiting / exited", inferred from a regex over scraped output.
That gives a single status light and an OS notification on approval. Most
of what makes a coding-agent session useful — what's being edited, what
tool is firing, how much it cost, what task is in progress — is invisible.

The goal: make richer signals available without forcing any TUI to depend
on Aya or change its behavior when Aya isn't present.

## Signals worth capturing

- **Tool-call indicator**. "running Bash", "reading file", "calling Edit".
  Turns the sidebar from a status light into a status line.
- **File touches**. Which files the agent has read or edited in this
  session. Sidebar badges, search filter, "files changed today" rollup.
- **Cost / tokens**. Cumulative spend per session. Status bar slot,
  hover for the per-request breakdown.
- **Context / current task**. The agent's current goal in one line.
  "Implementing search foundation" beats "Claude (running)".
- **Explicit approval signal**. Replaces the regex bell heuristic and
  its false positives on agent narration that contains "do you want to".
- **Session id**. Groups restarts of the same conversation, links
  transcripts across PTY lifetimes, enables resume.
- **Error category**. Rate-limited / tool error / auth expired —
  different badges, different recovery affordances.
- **Progress**. "step 3/7", percentage. Sidebar progress strip.

## Three mechanisms

### 1. OSC escape sequences (primary channel)

A TUI emits a control sequence to stdout. Aya intercepts in `pty.ts`,
extracts the structured event, and strips the sequence from the byte
stream before forwarding to xterm.js. The TUI's visible output is
unchanged.

Pick an OSC code in the unused range, e.g. `OSC 9001`. Vocabulary:

```
ESC ]9001; aya.status   = waiting : Approval needed    BEL
ESC ]9001; aya.tool     = Read : src/foo.ts            BEL
ESC ]9001; aya.file     = touched : src/foo.ts         BEL
ESC ]9001; aya.cost     = 0.05 : 1.23                  BEL
ESC ]9001; aya.context  = Implementing search          BEL
ESC ]9001; aya.session  = claude-abc123                BEL
ESC ]9001; aya.error    = rate-limited                 BEL
ESC ]9001; aya.progress = 3/7                          BEL
```

Properties:

- Zero interference: if Aya isn't running, every terminal already knows
  how to safely ignore OSC framing.
- Optional: TUIs only emit when they detect `$AYA_SOCKET` in env
  (already set by Aya for spawned PTYs).
- TUI-agnostic: anyone can adopt the vocabulary.
- Cheap to implement on both sides.
- Same pattern iTerm uses for shell integration (their OSC 1337).
  Battle-tested.

Implementation fits cleanly into the search work in flight: bytes pass
through `pty.ts`, get parsed by a new `osc-extractor.ts`, the structured
event flows to renderer state and into the search store as
`kind='status'` lines.

### 2. The `aya` CLI as a one-shot helper

You already have `aya status set / waiting / done / error / clear`.
Extend it:

```sh
aya tool start "Edit src/foo.ts"
aya tool end
aya file touched src/foo.ts
aya cost add 0.05
aya context "Implementing search foundation"
aya progress 3/7
```

Internally each writes the OSC 9001 sequence to `/dev/tty` (or messages
`AYA_SOCKET` directly when the env var is set). Two ways to invoke for
the price of one: TUI authors can call OSC directly; shell scripts and
Makefiles use the `aya` helper.

This unlocks the wrapper approach: people who don't control the TUI's
source can still emit signals from shell hooks, pre-commit hooks, mise /
asdf shim wrappers, etc.

### 3. Wrapper commands around existing TUIs

For TUIs we can't modify, ship reference wrappers that watch the TUI's
existing state directories and emit OSC on its behalf. Example for
Claude Code:

```sh
#!/usr/bin/env bash
# aya-wrap-claude — drop-in for `claude` in an Aya preset
set -e

# Spawn a background watcher that polls Claude's state files and emits
# OSC events via `aya`. Dies with us thanks to parent-process tracking.
(
  while kill -0 $PPID 2>/dev/null; do
    if [[ -f "$HOME/.claude/projects/$AYA_PROJECT_SLUG/current.json" ]]; then
      jq -r '.cost_usd // empty' "$HOME/.claude/projects/$AYA_PROJECT_SLUG/current.json" \
        | xargs -r -I{} aya cost set {}
      jq -r '.recently_edited[]?' "$HOME/.claude/projects/$AYA_PROJECT_SLUG/current.json" \
        | while read -r f; do aya file touched "$f"; done
    fi
    sleep 1
  done
) &

# Replace ourselves with claude so no extra process sits in the PTY.
exec claude "$@"
```

Key points:

- `exec` at the end means no proxy layer sits in the byte stream.
  The watcher is a sibling background process, not a parent. Zero
  added latency.
- The watcher dies when the PTY dies (`kill -0 $PPID` fails).
- Per-TUI knowledge stays in per-TUI wrappers. Aya doesn't try to be
  universal.
- Users opt in by editing their preset command from `claude` to
  `aya-wrap-claude`.

What the wrapper can do without TUI cooperation: file watching, polling
state files, scraping a stable log path, watching mtimes on directories
the TUI writes into.

What it can't do reliably: extract semantic events from the TUI's screen
output (too coupled to UI changes). Don't try to parse rendered terminal
content from a wrapper; that's what the bell heuristic does and we want
to retire that approach, not duplicate it.

## Where each mechanism wins

| Signal            | OSC native | `aya` CLI | Wrapper           |
| ----------------- | ---------- | --------- | ----------------- |
| explicit approval | best       | OK        | partial           |
| tool calls        | best       | OK        | hard              |
| file touches      | best       | OK        | best (state file) |
| cost              | best       | OK        | best (state file) |
| context label     | best       | best      | hard              |
| session id        | best       | OK        | best (state file) |
| progress          | best       | best      | hard              |
| error category    | best       | OK        | partial           |

OSC native is always cleanest IF the TUI cooperates. Wrappers are
essential for the long tail of TUIs that won't cooperate but expose
state on disk. The `aya` CLI is the glue that makes both feel uniform.

## Recommended ship order

1. **Define the OSC 9001 vocabulary** (this document is the source of
   truth) and write `electron/osc-extractor.ts`. Hook it into `pty.ts`
   between the rolling buffer and the renderer-bound forward path.
   Strip sequences before they reach xterm.js.
2. **Route extracted events to**:
   - Renderer state (status bar slot for cost, context label in the
     sidebar, explicit bell signal that supersedes the regex).
   - The search store as `kind='status'` lines so they're searchable
     across restarts.
3. **Extend `bin/aya`** with `tool`, `file`, `cost`, `context`,
   `progress`, `error` subcommands. Each writes the OSC sequence to
   the controlling tty.
4. **Document the vocabulary** so TUI authors have a stable reference.
   Mention the iTerm-style pattern so it doesn't feel exotic.
5. **Ship reference wrappers** in `skills/aya-wrap-claude/` and
   `skills/aya-wrap-codex/` as bash scripts. Optional, drop-in,
   documented. Retire gracefully if the official tools ever adopt OSC
   natively.
6. **Adopt the OSC channel in the existing bell detection path**: when
   the TUI emits `aya.status=waiting`, prefer that over the regex.
   Heuristic stays as fallback.

## Trade-offs to remember

- **OSC 9001 isn't an established standard.** Collision risk if another
  tool grabs the same code. Namespacing every key with `aya.` mitigates
  this; picking a less-used code (9009?) hedges further.
- **Wrappers couple to upstream state-file layouts.** Claude / Codex
  state formats can change every release. Wrappers must be best-effort
  and not fail loudly when the format shifts.
- **Some signals could leak into search.** Cost amounts in
  `kind='status'` lines are searchable. Tool-call inputs might contain
  paths or secrets. Document this in the integration guide and rely on
  the per-session search opt-out (search foundation already supports
  it).
- **The OSC parser needs to handle byte-boundary splits.** PTY chunks
  can land mid-sequence. Trivial to buffer correctly, easy to get
  wrong on first pass.
- **OSC stripping must not break existing OSC 0/2 title parsing or
  OSC 8 hyperlinks.** New code lives alongside, not in place of.

## What not to do

- A wrapper that proxies the PTY byte stream and scrapes content.
  Same fragility as the bell regex, plus latency, plus risk of
  corrupting TUI rendering.
- LD_PRELOAD or syscall interception to detect file touches.
  Cross-platform nightmare and brittle.
- A required SDK or daemon TUIs link against. The point is "optional
  and non-invasive".
- Inventing another control-socket protocol parallel to the existing
  `AYA_SOCKET`. Reuse what's there.

## End state

A three-level integration story:

- TUI authors who care: emit OSC. Best fidelity, lowest cost.
- Shell users and Makefile hooks: call `aya <subcommand>`.
- Ecosystems we can't touch: best-effort wrapper that watches state
  files.

Nothing forces participation. Nothing breaks if a TUI ignores everything.
The bell heuristic stays as the universal fallback so even a fresh TUI
with no integration still gets the basic "waiting" indicator.
