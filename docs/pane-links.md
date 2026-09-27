# Pane links (design)

A link joins panes into a working pair: each pane gets a role, and Aya carries
the messages between them. Neither the agent CLI nor the model matters.

## Why

A 22-round UX review in one project (a reviewer pane plus an implementer pane)
hit these problems again and again:

1. The reviewer's role was lost after rotation or `/resume`. It edited
   `src/` about 20 times, and the user had to restate the role.
2. Agents forgot the recipient's tab name. They sent reports to their own
   pane, got "no pane named Tester" after a rename, and ran
   `aya pane list` 20 times.
3. The user had to tell agents to pass reports on at least 10 times.
4. `aya pane read` returned 64 KB of spinner noise.

## v1

- **Definition**: `.aya/links/<name>.md` lists the roles and the pane
  bound to each one, then the protocol in prose. Settings edits the same
  file.
- **Roles bound to panes**: the pane's role, peers and protocol are
  injected on every spawn through the agent-brief channels, so they survive
  `/clear`, compaction and `/resume`. `aya link whoami` prints them.
- **Addressing by role**: `aya link send <role> "text"` and
  `aya link reply`. They resolve by pane id, so renaming a tab breaks
  nothing. A send to your own pane is refused. Each send reports
  "delivered to tester (pane X)".
- **Exchange log**: `.aya/links/<name>.log.jsonl` records sender,
  recipient, time, the sender's commit and the text.
  `aya link inbox` prints clean messages instead of screen scrapes.

The protocol template keeps what worked: "hypothesis, not fact" plus a
measurement request, `[reported -> confirmed]` round numbers, and
"one-way, do not reply".

## Later

- **Rounds on a cadence**: the cron lived in one session and died with it.
- **Write/measure lock**: a rebuild reset the reviewer mid-round.
- **Item states**: open, rejected with a reason, or closed. One item was
  reported for 7 rounds because the rejection never reached the reviewer.
