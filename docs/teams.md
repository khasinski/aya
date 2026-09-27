# Teams (design)

A team gives panes roles; Aya carries messages between them, for any CLI.

## Why

A 22-round reviewer/implementer UX session hit:

1. After rotation or `/resume`, the reviewer lost its role and edited `src/`
   about 20 times.
2. Agents forgot the recipient's tab name, sent reports to themselves, and
   ran `aya pane list` 20 times.
3. The user had to nudge reports along at least 10 times, and the round
   cron died with the one session that held it.

## v1

- **Define team** in the repo, in `.aya/teams/<name>.md`: roles,
  responsibilities, what each role must not do, who it sends to, a
  protocol, and a cadence. A per-project screen edits it; outside edits
  apply only after Save team. It offers a two-role template and drafts a
  role from its name with Aya Intelligence.
- **Assign panes** locally in `~/.aya`: one pane per role, local panes
  only. Closing a pane frees its role; restarting it keeps the role.
- **Identity**: `aya team whoami` prints the pane's role, send-to list
  and protocol; every team pane is reminded to run it.
- **Send by role**: `aya team send <role> "text"` finds the pane by id
  and delivers at once, because the agent CLIs queue input themselves.
  It holds back only when Enter would do something else: an approval
  prompt, half-typed user text, or a shell pane. Each message has a
  sender header, time and commit: a peer's report, not the user's
  instruction, and dated so staleness shows.
- **Cadence**: Aya sends the round prompt; a pause stops the team.
  Write/measure turn-taking stays in the protocol.
- **Log and inbox**: every message is logged in `~/.aya/teams/`, outside
  the repo. Start team sends a delivery test.

## Measured screen detection (Aya's `evaluateScreen`, real CLIs)

| CLI | approval prompt | half-typed text |
|---|---|---|
| Claude | waiting | not detected |
| Codex | waiting | not detected |
| Grok | not shown (always-approve) | not detected |

Half-typed text needs a new rule.
