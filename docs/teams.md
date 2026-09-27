# Pane links (design)

A link joins panes into a working pair: each pane gets a role and Aya carries
messages between them, for any agent CLI or model.

## Why

A 22-round UX review (reviewer and implementer panes) hit:

1. After rotation or `/resume`, the reviewer lost its role and edited `src/`
   about 20 times.
2. Agents forgot the recipient's tab name: they sent to their own pane, hit
   "no pane named Tester" after a rename, and ran `aya pane list` 20 times.
3. The user had to nudge reports along at least 10 times.
4. `aya pane read` returned 64 KB of spinner noise.

## v1

- **Definition**: `.aya/links/<name>.md` in the repo lists roles, their
  panes and the protocol in prose.
- **Identity**: `aya link whoami` resolves the pane from `AYA_TERMINAL_ID`
  and prints its role, peers and protocol, for any CLI.
- **Role at spawn**: every linked pane gets a note telling it to run
  `aya link whoami` after a start, `/clear` or `/resume`. It gets this
  even without the preset's brief opt-in. Claude and Grok get it
  per process; Codex and Antigravity only have shared files, so the note
  stays generic. Survival across compaction and `/resume` is
  unmeasured per CLI.
- **Send by role**: `aya link send <role> "text"` resolves to a pane id
  (`targetId`), so renaming a tab breaks nothing. A send to your own pane
  or to a dead pane fails with a clear error. On success it reports
  "written to tester's pane", which is not proof the agent read it.
- **Log**: Aya's main process appends every message to
  `~/.aya/links/<project>/<name>.jsonl` with an id, sender, recipient,
  time, sender commit and text; outside the repo, as messages may hold
  secrets. `aya link inbox` prints unread messages.

The protocol template keeps what worked: "hypothesis, not fact" plus a
measurement request, `[reported -> confirmed]`, and "one-way, do not reply".

## Later

Settings editor, cadence, write/measure lock, item states (open, rejected
with reason, closed), and log retention.
