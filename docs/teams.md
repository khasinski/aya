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
  responsibilities, what each role must not do, who it sends to and what
  it sends there (`Sends to: implementer (findings to fix), tester`), a
  protocol, and a cadence. A per-project screen edits it; outside edits
  apply only after Save team. It offers a two-role template, drafts a role
  from its name and the rest of the team with any Aya Intelligence
  provider, and previews the flow from the routes (no model).
- **Why routes carry a what**: reading the flow back out of prose failed.
  On Apple's on-device model, five prompt designs over 18 labeled sentences
  got at most 8 right; "code submitted by the implementer" read as the
  reviewer sending code. Agents read the same prose, so the route says it.
- **Assign panes** locally in `~/.aya`: one pane per role, local panes
  only. Closing a pane frees its role; restarting it keeps the role.
- **Identity**: `aya team whoami` prints the pane's role, each route with
  what it carries, and the protocol; every team pane is reminded to run it.
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

## When Aya does not type a message

A message waits in the receiver's inbox, and goes out by itself once the
pane is free (checked every 15 s), when the pane:

- is not running, or its agent has not drawn its composer yet (Claude
  took about 1 s, Codex 0.5 s, measured);
- shows an approval prompt, Claude's folder-trust dialog, or a numbered
  menu;
- has text the user is typing, or runs a plain shell.

Messages go in as a bracketed paste: Codex took fast raw typing for a
paste and swallowed the Enter after 600+ characters (measured on 0.158).
Start checks every pane first and sends nothing while one is not ready.

## Testing teams in Aya Dev

- Aya Dev rebuilds and restarts when `electron/` changes, and a change in
  a module the pty host runs restarts the panes too. A team working on
  Aya's own `electron/` restarts itself mid-round; give it another repo,
  or expect to reassign roles.
- Aya Dev panes get this branch's `aya` first on PATH, so `aya team` works
  even when an older Aya.app is installed.
- Start Aya Dev from a plain terminal if you can; panes drop the markers
  of a Claude Code session they inherit, but nothing else.
