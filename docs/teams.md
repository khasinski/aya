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

## Define a team from an agent

`aya team new [description]` prints a guide for any agent CLI: where the
file goes, the format with a complete example, every rule the parser
enforces, and the two mistakes seen in drafted roles (a must-not that
forbids the role's own work, a long what). The rule values are printed from
the parser's constants, and a test saves the guide's example. The agent
writes the file and runs `aya team save <file|->`: main parses it, then
saves it through the same `saveTeam` as **Save team** (repo file and the
copy Aya runs), so it reaches agents at once. Scope: the calling pane's
project, else `AYA_PROJECT_SLUG`, else the open project the cwd is in. An
existing name needs `--replace`, as the window edits rather than creates.

## Give roles panes

A saved team with no panes has nobody to Start. `aya presets` lists the
presets with the agent each runs and whether its CLI is installed, by the
same check a pane spawn makes ("command not found"). The guide's last step
has the agent propose a pane per role and wait for the user's yes, then run
`aya team open <team> <role>=<target> ...`. A target is `this` (the calling
pane), `new:<preset>` (a new session), `pane:<name-or-id>`, or the bare
preset id, pane id or pane name when only one of them matches; a name that
is both a preset id and a pane name, or two panes' name, is refused with the
explicit forms or the candidate ids. Roles not listed keep their panes.

Main checks every pick before anything changes: the team is saved in Aya,
each role exists and is listed once, each preset is installed, no pane goes
to two roles, and a role with a live pane or a pane that plays another role
needs `--replace` (the old pane keeps running); a dead pane of another role
does not, and the output names the role that lost it. On any problem it
names them all and opens nothing. Main picks the new panes' ids and asks the window
that shows the project (`teams:open-panes`) to add them as tabs named
`<preset> - <role>`; the window saves the project and answers
(`teams:panes-opened`, 10 s deadline). A reply that misses the deadline
still leaves the tabs the window saved: main reloads the project and assigns
every pane it finds, and says which roles got none, as it does for a picked
pane that closed meanwhile. When the window saved none by the deadline,
nothing is assigned; a late reply gives only its new panes their roles, and
only if the check still passes and the role still has the pane it had. A
window that cannot save the project removes the tabs again. Opens of one team
run one at a time, each checked against what the one before assigned; Apply
panes sends its "No pane" rows in the same call, released only once every
pick passed. Then each role is assigned with the
Teams window's `assignRole`; in a running team a new pane is told its role
once its agent has drawn its composer (up to 20 s). Start stays the user's:
`aya team start <team> ["task"] [--to role]` runs the Teams window's Start
(the same pane check, nothing sent while a role is missing or busy); the
guide has the agent ask whether to start and with what task, and run it only
on the user's word. A task then goes, after the delivery tests, as a message
from `user` (reserved like `aya`, and redelivered like a peer's message) to
`--to`, else the cadence role that leads the rounds, else the first role;
the output and the Teams window's Start (with its Task field) say who got it.
`user` is reserved when a team is saved, not when a saved one loads: a team
saved with a `user` role before keeps working, and starts, but takes no task,
so its log never mixes the role with the user. A team saved with `aya team save` from a pane is
marked as the agent's, so the window's "Assign team roles?" prompt does not
compete with the agent's proposal; a team that arrives with a pull still
gets the prompt.

The Teams window runs the same `openTeamPanes`: per role it offers the open
panes, each labelled with the role it already plays, and `New: <preset>`
for installed presets. Picks wait for **Apply panes**, which spells out a
move that leaves another role without a pane.

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
