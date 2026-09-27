# Teams (design)

A team gives panes roles, and Aya carries the messages between them, for any
agent CLI or model.

## Why

A 22-round UX review (reviewer and implementer panes) hit:

1. After rotation or `/resume`, the reviewer lost its role and edited `src/`
   about 20 times.
2. Agents forgot the recipient's tab name. They sent to their own pane, hit
   "no pane named Tester" after a rename, and ran `aya pane list` 20 times.
3. The user had to nudge reports along at least 10 times.
4. `aya pane read` returned 64 KB of spinner noise.

## v1

- **Define team**, stored in the repo as `.aya/teams/<name>.md`, next to
  `.aya/project.json`. It lists each role with its responsibilities, what
  it must not do, and who it sends to (picked from the team's roles), plus
  a free-text protocol. A per-project screen edits the file. Aya
  Intelligence can draft a role from its name, as fields the user edits.
- **Assign panes**, stored locally in `~/.aya` because pane ids exist on
  one machine only. Assign in the team screen or from the tab menu.
- **Identity**: `aya team whoami` resolves the pane from `AYA_TERMINAL_ID`
  and prints role, send-to and protocol. Every team pane gets a note at
  spawn to run it after a start, `/clear` or `/resume`, even without
  brief opt-in. Survival across compaction is unmeasured per CLI.
- **Send by role**: `aya team send <role> "text"` resolves to a pane id.
  A send to yourself, to a dead pane or outside send-to fails clearly.
  "Written to the pane" is not proof it was read.
- **Log**: the main process appends each message (id, sender, recipient,
  time, sender commit, text) to `~/.aya/teams/`, outside the repo, as
  messages may hold secrets. `aya team inbox` prints unread messages.

## Later

Cadence, write/measure lock, item states, log retention.
