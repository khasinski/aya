# Teams (design)

A team gives panes roles; Aya carries messages between them, for any CLI.

## States a team depends on

The way each agent CLI is launched is a state, and it decides whether the
team works at all: a pane whose `aya` calls cannot reach Aya's socket never
answers its role. Measured on codex-cli 0.158.0 (TUI), opencode 1.18.30,
Claude Code 2.1.284 and grok 1.0.44, with `node` connecting to a unix socket
outside the project:

| CLI | Launch mode | Reaches Aya | What Aya does for a role's pane |
|---|---|---|---|
| Codex | default: sandbox `workspace-write` | no: `connect EPERM`, then asks to rerun it outside the sandbox | adds `-s danger-full-access -a never` (below) |
| Codex | `workspace-write` + `network_access = true` (also as `sandbox_workspace_write = { network_access = true }`) | yes, but `git commit` cannot write `.git/index.lock` and `aya team send` waits for an approval (codex-cli 0.160) | adds `-s danger-full-access -a never`; an open pane's row notes it will stop for approvals |
| Codex | a project `.codex/config.toml` whose project is not trusted in `config.toml`; a sandbox setting in a form Aya does not read | unknown: Codex ignores an untrusted project's config, and asks to trust it on the first launch | not held: the role's row notes "may not reach Aya" and what to do. The verdict is the one made when the pane started, since Codex reads its config at startup: trusting the project, or editing any config, needs a restart of the pane; a Codex that cannot start with a legacy `profile` or `[profiles.x]` beside `-p x` gets its own note |
| Codex | `writable_roots` with the socket's dir, `--approve-for-me` | no: EPERM | as `workspace-write` |
| Codex | `read-only` (`-s` or `sandbox_mode`), even with `network_access` | no: EPERM | refuses a new pane: no silent escalation |
| Codex | `danger-full-access`, `--dangerously-bypass-approvals-and-sandbox`, `--yolo` | yes | uses it as picked |
| Codex | approval policy `untrusted` (`-a`, `-c approval_policy=` or `config.toml`) | yes, once you approve each call: `untrusted` runs only Codex's own read-only commands without asking (from Codex's help, not measured on a live Codex) | not held; the role's row says each `aya` call waits for you to approve it, and the pane's prompt holds it then |
| Codex | without `--no-daemon` | as another pane: two panes of one project, the second printed the first's `AYA_TERMINAL_ID` | adds `--no-daemon`; without it in codex, refuses |
| OpenCode | build agent (the default) | yes | adds `--agent build` when `default_agent` is plan, in a config file or in `OPENCODE_CONFIG_CONTENT` |
| OpenCode | plan agent | the socket yes; the work no: edits denied, it would not write a file | refuses a preset with `--agent plan` |
| Claude Code | no sandbox (default); `--dangerously-skip-permissions` | yes | nothing to add |
| Claude Code | `sandbox.enabled`, with or without `--dangerously-skip-permissions` | no: EPERM | adds `--settings` that puts the socket's real path in `sandbox.network.allowUnixSockets` |
| Claude Code | `sandbox.enabled` with `allowUnixSockets` naming the socket's directory (or an ancestor other than `/`), or `allowAllUnixSockets` | yes (2.1.285, scripted tool call); an exact entry spelled through a symlink (`/tmp/...` for `/private/tmp/...`) does not match, the real path does; `/` was not measured | nothing to add; for `/`, adds the socket as above, which is harmless if `/` already covers it |
| Claude Code | `permissions.defaultMode` `plan` in the settings, without `--permission-mode` | no: plan mode does not act on the role's work | refuses a new pane; an open pane is held |
| Claude Code | `--permission-mode plan` | unknown: refused to run the command in 1 of 2 runs | not held; noted: restart it without the flag |
| Grok | default, `--sandbox workspace`, `strict`, `read-only`, `devbox`; `--permission-mode plan` | yes (`read-only` did not stop a file write either) | nothing to add |
| a shell, other CLIs, anything behind a wrapper | - | unknown | not held; noted "may not reach Aya" |

Only a measured "can't reach Aya" holds messages and stops Start. An unknown
verdict never does: messages are typed into the pane, and the Teams window notes
"may not reach Aya: <why>" until the pane's agent calls `aya` (that call settles
it while that process runs: a re-mount of the pane and a relaunch of Aya keep it (`reached-aya.json`), a restart needs a new call). Only a call whose process runs under the pane's process
counts, the proof role commands need: `aya status` from another process with the pane's
`AYA_TERMINAL_ID` borrowed, or from a CLI too old to send its pid, settles nothing. Unknown: a shell, the unmeasured
CLIs (cursor-agent, copilot, droid, devin, kimi, kilo, pi, gemini; Aya types and submits (Enter) into them anyway),
`codex exec` and other non-interactive Codex subcommands, `opencode run`, an
OpenCode agent other than build and plan, and Codex's `external-sandbox`.
Holding them would block every working custom preset. Codex 0.159
takes `-p <name>` as `<name>.config.toml`, and refuses to start with a legacy
`profile` key or with `[profiles.<name>]` beside `-p <name>`: Aya notes such a
pane with that reason, and counts no `[profiles]` table's settings. An empty Claude Code settings file counts as no
settings (Claude's own tolerance of it was not measured).

What decides the mode, lowest first, as measured: Codex takes
`$CODEX_HOME/config.toml`, then the `-p <name>` profile
(`<name>.config.toml`), then `.codex/config.toml` from the repository root
down to the pane's cwd, then the command line. OpenCode takes its user config,
then `opencode.json` and `.opencode/opencode.json` from the root down, then
`--agent`. Claude Code takes the user's, the project's and the local
settings, then `--settings`. The program may come behind `NAME=value` and a plain `exec`
(`exec codex`, `X=1 exec claude`): the same verdict and the same flags as the bare
program. `cd <dir> &&` in front (one or more, each with a literal directory) runs the same program in
another directory: the same verdict and flags as the bare program, with the config files read from that
directory (`cd web && claude` reads `web/.claude/settings.json`), and `--no-daemon` added to Codex after
its program. Behind anything else (`cd x; codex`, `cd $DIR && codex`, `env`, `nice -n 5`, `npx`, `ssh host`, `sh -c '...'`, an alias, a script) Aya reads no
flags and adds none: the verdict is unknown, noted, never held. A `--settings <file>` path is expanded with the pane's own environment
(`~`, `$HOME`, a `NAME=value` in the command); a path that cannot be resolved or read
makes the verdict unknown (noted), never "no sandbox". A `--no-daemon`
probe that times out (the login shell is slow) adds the flag for that spawn and is
asked again next time; only a real answer is remembered.

A Codex pane Aya opens for a role runs with `-s danger-full-access -a never`, so `git` and `aya` never stop for a human, and says so ("Aya opened it with -s danger-full-access -a never ..." in `aya team open` and under the role).
A preset that sets its own sandbox or approval policy (`-s`, `-a`, `-c sandbox_mode=`, `-c approval_policy=`, `--full-auto`, the bypass) keeps it, gets only the network switch when its `workspace-write` needs one, and its row says it may stop for approvals.

`electron/launch-mode.ts` reads a pane's mode from the command the terminal
host actually started and those files. A pane `aya team open` or **Apply
panes** opens for a role gets the least that reaches Aya, again on every
restart; one that would need an escalation is refused with the reason, and
nothing opens. The terminal host records the verdict when it spawns the
pane, so editing a config file later does not change what a running pane is
told. A pane with no verdict (the host has no record of its launch, or is older than this Aya)
is, like an unknown one, not held: Start, sends and rounds type into it; only `aya team open`
and **Apply panes** say Aya cannot tell whether it reaches Aya ("restart it"), listed under
"May not reach Aya". An open pane that can't reach Aya keeps a role given to it, but `aya team open` says
"can't reach Aya: <why>; open a new pane for it, or restart this one with
<args>", the role's status in the Teams window says the same, and Start,
sends and rounds hold it like a busy pane. `aya presets` has a "reaches aya"
column.

Other dimensions, derived from 32 session bugs and the earlier follow-ups
(F1-F16, T1-T12). Each has unit tests over its state combinations and most
have an e2e with a stand-in agent. "Limit" is what is still not proven; no
dimension has been run end to end against every real CLI.

| Dimension | Values | Example bug | Status and limit |
|---|---|---|---|
| CLI launch mode | sandbox, approval policy, plan/build agent, shared daemon, resume flag | Codex workspace-write: `aya` gets EPERM on the socket (21) | Covered for sandbox, agent and daemon (the table above); approval policy shows as a hold, never auto-approved. Limit: real-Codex reachability rests on the stand-in |
| CLI identity | Claude, Codex, Grok, OpenCode, shell, ... | Codex eats Enter after 600+ characters (3) | Screen rules per CLI. Grok busy is read off its recorded 1.0.46 turn (the [stop] spinner row above the composer, Ctrl+c:cancel in the hint row), so a round is held while it works. Limit: Grok and OpenCode never run for real in a team; custom CLIs (kilo, pi, Cursor, ...) have no composer rule: no draft hold, and their start-up hold waits for a screen that has drawn and not changed for 1 s (at most 8 s after the spawn) |
| Pane screen state | free, starting up, approval, trust dialog, numbered choice, draft, pasted text, shell, exited, busy | message typed before the composer is drawn (2) | Covered, incl. a dismissed numbered dialog, a message that quotes approval wording, and an answer saying "waiting for approval" above a drawn composer (live run 10c), for Claude (also with up to three rows under its composer, as a statusLine draws), Codex, OpenCode and Grok in any mode: each composer is the recorded one, and a recorded Codex approval and OpenCode question replace the composer, so a drawn composer means no dialog. Limit: Grok outside always-approve and Claude's statusLine rows are not recorded; Grok's permission prompt is read by its wording in the grok 1.0.46 binary ("Yes, allow once", "Allow Execute?"), not from a capture; real-CLI timing of the start-up window is measured on Claude and Codex only |
| Pane lifecycle | no pane, not opened, spawning, running, exited, killed mid-spawn, respawned | Start sends into a pane that is not running (22) | Covered |
| Env inheritance / identity | launcher env, daemon env, AYA_* per pane, HOME in tests | panes inherit CLAUDE_CODE_*, so --continue finds nothing (7) | Session markers of all four CLIs are stripped. Limit: Grok and OpenCode values are measured by the author only; a build launched from a pane adopts the outer Aya's home |
| App readiness / instance | socket up before the renderer, no window, Dev vs prod, shared instance | open acked and dropped before the page loaded (12) | Covered for `aya open` and `aya team` (it waits out the boot gap). Limit: a cwd-only `aya team start` from a plain shell during boot is not retried |
| Pty host generation | compatible, stale, booting, orphaned | a rebuild reaps the host and kills every agent (9) | Covered for reap, hash and attach. Limit: a spawn still in preflight when the host idles out is invisible to it |
| Team state across restart | round counter, inbox from Aya vs a peer, paused/running | round restarts at 1 after a restart (6) | Covered, incl. an e2e relaunch. Limit: cadence across a relaunch with a real CLI is unverified |
| Session on resume | own session, sibling worktree's, latest in dir, none | OpenCode resumes a sibling worktree's session (10) | Claude, Codex, OpenCode. Limit: Grok resume never run for real; a sibling closed before either ran keeps `--continue` |
| Project topology | worktree, nested, symlink, cwd outside project | Codex pane "belongs to no open project" (20) | Covered for worktree, nested, symlink. Limit: a symlink retargeted while running keeps its old key |
| Shared config across CLIs | ~/.claude/settings.json, CODEX_HOME, daemon | Grok runs Claude's quoted hook path literally (15) | Guarded (the brief goes in at launch, never into a file another CLI reads). Limit: the real-CLI tests are opt-in and skipped in CI |
| What each agent knows | brief version, role-note channel, after /clear or /resume | agent never learned `aya team start` (27) | Four CLIs get a role note; the others get an honest "cannot tell this CLI its role". Limit: OpenCode and Grok delivery never seen by a real CLI |
| Team lifecycle and trust | pulled/unsaved, agent-saved, pane plays two roles | a pulled team file ran unsaved (25) | Covered |
| Timing and concurrency | parallel async updates, spawn vs kill, login-shell latency | two opens, the second removes the first project (13) | Covered by locks and ordering tests. Limit: the real-Claude approval race (prompt in the 150 ms before Enter) is covered with a stand-in only |
| OS / shell | macOS/Linux, sh vs dash, bash 3.2 | exit 2 on dash, 1 on macOS (31) | Covered where dash and bash 3.2 are installed; Linux runs in CI only |
| Team liveness | progressing, idle, blocked in its own CLI, rounds without change | plan-agent tester stalled 4 rounds unseen (18) | Implemented: the Teams window shows progressing, talking, waiting for you, stalled after 60 min without a change to the repo (the one stall rule; a stall survives a relaunch); a quiet team's lead is asked for a round. A role whose CLI shows it is out of credits or at its usage limit (recorded: codex-cli 0.159.3) is blocked with that reason, in the window and once per round in the log, not "waiting for you". Limit: real CLI unverified; Claude's and Grok's usage-limit screens are not recorded, so theirs read as a plain dialog |

Cells that produced bugs (must be tested together): launch mode x aya action (21, 18); daemon x first pane's lifecycle x project (20); launcher env x resume x restart (7); host reap x resume x worktrees (9, 10); inbox origin x restart (5); round counter x restart x pause/resume (6); socket readiness x instance env (11, 12).


Every CLI with a launch channel gets the brief and its role note together at launch (Codex in `developer_instructions`), so one digest of that text tells the Teams window when a pane started with an older brief or note; no brief is written into a file another CLI reads. A Claude or Codex pane with a team role always gets the brief, whatever its preset says (the preset is not changed); the other CLIs follow the preset.

## Why

A 22-round reviewer/implementer UX session hit:

1. After rotation or `/resume`, the reviewer lost its role and edited `src/`
   about 20 times.
2. Agents forgot the recipient's tab name, sent reports to themselves, and
   ran `aya pane list` 20 times.
3. The user had to nudge reports along at least 10 times, and the round
   cron died with the one session that held it.

## v1

- **Lead**: a team names one role in `## Lead` (one line, a role id). The
  lead gets the Start task and supervises: it checks that nobody waits too
  long on someone and that work is going on. The author picks it (the
  agent through `aya team new`, or the user in the Teams editor); Aya never
  guesses one. The rhythm belongs to the lead: the role named in `## Cadence`
  IS the lead, so a file with only a Cadence has that lead, a file with only a
  Lead has a lead and no timer rounds, and a file naming two different roles is
  refused on save ("cadence and lead name different roles; make them the same")
  and, when an old one loads, runs with the Cadence's role leading and a warning
  on its card. A new team with neither is refused on save, by `aya team save` and
  by the window's Save team. A saved file with neither still loads and runs; its
  card says "no lead role: set one". When nothing moves, Aya asks the lead for a
  round (see Liveness, "Quiet team"); that round says who waits on whom and since
  when. A lead that cannot unblock the work runs `aya status waiting "..."`, the
  card says "waiting for you" and Aya stops asking until something moves.

- **Define team** in the repo, in `.aya/teams/<name>.md`: roles,
  responsibilities, what each role must not do, who it sends to and what
  it sends there (`Sends to: implementer (findings to fix), tester`), a
  protocol, a lead, and an optional cadence. A per-project screen edits it; outside edits
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
  Only Claude, Grok, Codex and OpenCode get a role note at start, through the
  CLI's own channel; any other CLI says it cannot tell it its role. The note is given whether or not the preset tells the agent about aya: Claude
  `--append-system-prompt`, Grok `--rules`, Codex `-c developer_instructions`,
  OpenCode a per-pane instructions file named by `OPENCODE_CONFIG` (joined to
  your own OpenCode config, not replacing it; with your own `OPENCODE_CONFIG`,
  the same instructions go through `OPENCODE_CONFIG_CONTENT`). This covers a pane whose role
  is saved before it starts and a new pane opened by `aya team open` or Apply
  panes. A CLI that is already running keeps what it started with: give it a
  role later, move the role, or take it away, and the Teams window says so on
  the role ("started before it had this role", "started with the role note of
  ..."; a pane that lost its role is listed as still carrying the note), and
  restarting the pane gives it the current note. What a pane got is kept as a
  digest of the exact text (brief and note), so an Aya update that rewords
  either, or a brief toggled since, shows "started with an older brief". Reloading the window or
  reconnecting to a running pane changes nothing: what a pane was told is
  recorded only when a process starts. A resumed Codex session keeps its first
  note, so a changed role needs a new Codex session. A running pane with no
  record of its start (one from before Aya kept records) shows "started before
  Aya recorded what it was told", whichever CLI it runs. A
  CLI with no channel, a command that is not a single simple command (`cd x && claude`),
  or a setting of yours that the note would replace (Codex
  `developer_instructions`, both your own `OPENCODE_CONFIG` and
  `OPENCODE_CONFIG_CONTENT`) shows "cannot tell this CLI its role", as does a
  login shell whose environment cannot be read within 20 s (one probe per Aya
  session, shared by every pane and status check; a failed one is asked again).
  The first OpenCode pane of a session waits one login-shell rc time for that
  answer, which is then kept; while it waits the pane is blank, and typed bytes
  and `aya pane send` to it are dropped. Either way the first message it gets tells it to run
  `aya team whoami`, and, for a pane started before an Aya update, to run
  `aya capabilities`.
- **A borrowed id**: interactive Codex ran every pane's shell commands in
  one shared `codex app-server daemon`, with the env of the pane that
  started it, so `aya team whoami` in a later pane answered for that pane,
  or failed once it had closed (codex-cli 0.158.0, measured). Aya starts
  Codex with `--no-daemon`. The directory a command runs in cannot tell
  (codex-cli 0.159.2, measured: the second pane
  and a `codex` typed in a plain shell pane both run commands as the pane
  that started the daemon, and that TUI forks the daemon as its own child, so
  the daemon's commands sit under the starter pane while it runs), so `aya`
  sends its own pid and Aya asks the pty host for the pane's process.
  `aya team whoami|send|inbox|pause` (and `team open` with `this`) is refused when that pid does not run
  under the pane's process, or does but through a `codex app-server` process
  (the shared daemon, also one started by hand in the pane). A pane whose tab
  exists but has no process is refused too: a leftover daemon or a job
  outliving its pane cannot speak as it. A background job that outlives the
  tool call that started it (`nohup ... &` after the tool returned) is
  refused as well, and the message says so; Claude's `run_in_background` is
  fine. Older `aya` copies (no pid), an unreadable process table, a host that
  cannot name the pane's process and remote panes are not refused. This
  catches a wrong id, not a forged one: the same user can send any pid.
  The directory is never checked: `cd` into another open project (a package and
  its repo root) is not refused, and other commands (`aya status`, `aya pane ...`)
  are not checked at all.
  The `aya` the app installs (Settings, or the startup repair of a dead one) is a
  shim that runs the bundled CLI of the Aya.app it names, so updating the app
  gives every pane the copy that sends a pid; the startup repair rewrites only
  a shim whose app is gone, and Reinstall rewrites the rest. A plain copy of an
  old `aya` (not a shim) is never touched and is accepted with any id. In the
  packaged app the bundled CLI is only the end of a pane's PATH, so an installed
  copy first on it wins.
  Long-lived helpers a pane started earlier (an MCP server, tmux or
  screen, a language server) keep that pane's ancestry and env for
  whoever uses them, so a command they run for another pane still passes
  as the starter: the proof catches a wrong id, not such a helper.
  Only the argv structure of an ancestor counts (`codex`, or `node`/`npx`
  running it, then `app-server` as the first word that is no option, so
  `codex -c k=v app-server` matches), never text in a command line like a
  message given to `aya`; the caller's own argv is not judged, and a pane
  whose own process is `codex app-server` is refused too. Only a
  `codex app-server ...` argv is recognised: Grok's and OpenCode's
  tool subprocess chains (and OpenCode's `serve`/`attach`) are not measured.
  `team save`, `team open` and `team start` act on the project of the pane
  whose id they carry, so they are refused when the caller runs under a
  `codex app-server`: that daemon's id may be a pane of another project. A
  pane id set by hand in a process that is no pane's still names its project
  (the e2e suite calls `team start`/`open` that way). `status` is refused
  the same way: a question holds the named pane's rounds and its Enter ends
  it, so through a daemon it would be another project's lead's question.
  `notify`, `pane-list`, `pane-read`, `pane-send` and `team guide`
  still trust `AYA_TERMINAL_ID` (not proven).
  Aya reads the `ps` table (about 25 ms) once per 200 ms burst of proofs;
  a burst member re-reads its own caller's parent first, and reads the
  whole table again when that parent changed.
- **Send by role**: `aya team send <role> "text"` finds the pane by id
  and delivers at once, because the agent CLIs queue input themselves.
  It holds back only when Enter would do something else: an approval
  prompt, half-typed user text, or a shell pane. Each message has a
  sender header, time and commit: a peer's report, not the user's
  instruction, and dated so staleness shows. A message or Start task is at most
  8,000 characters: a longer one is refused with "the message is N characters,
  the most is 8000" and `aya team send` exits 1; put the detail in a file in the
  repo and send its path. The log is read from its last 2 MB; before it outgrows that (or 2,000
  messages) it is cut to about 1 MB, keeping first every message still owed to its role (a quiet
  role's report is not cut by the others' talk), then the newest 1,000 of the rest.
- **Cadence**: optional; Aya sends the round prompt to the lead every N minutes (the
  role named in `## Cadence` is the lead); a pause stops the team.
  Write/measure turn-taking stays in the protocol. The round carries a digest of now and what
  changed since the last round (`electron/team-digest.ts`), each part only when it has something:
  messages, new HEADs, held messages and skipped rounds since then; roles blocked 5 min or more on
  a screen the clock saw (`progress.json`) or a held message, with who can clear it (a dialog, a
  draft, a pane not running or missing: only the user); roles waiting on the lead (message number
  and wait) and waits between other roles of 30 min or more; sends `aya team send` refused (no such
  role, not in its sends-to, team paused, the send cap, a receiver without a pane), recorded in
  `refused.jsonl` (append-only, the newest 100-200 kept, text cut to 40 characters; a refusal
  before the caller's team is known has no team to record it in); and roles idle 20 min or more
  (no message sent or typed to them, and not busy now). Totals stay in `aya team stats`;
  `aya team stats <team> --now` prints the same digest from the files, with the
  status command's last recorded run (below) at its end.
- **Status command**: optional `## Status command`, one shell line (Teams editor:
  Status command). Aya runs it with `sh` in the project directory for a running
  local team (never paused, not started or remote), with no stdin, a pane-less
  env (no `AYA_TERMINAL_ID`), 20 s and 2 KB of output (stderr kept, escape
  sequences dropped), one run per team at a time, and hands the lead its output
  with every round, whether the rhythm, a silence or a stall made it due
  (`statusSection` in `electron/team-status-command.ts`). It is
  for state Aya cannot know, e.g. which models a model server has loaded.
  Each run is recorded in the team's `status.json`; `aya team stats <team>`
  (and `--json`, `--now`) only reads that and prints the last run with its time ("last
  run 22:41") under "Status (from the team's command)", or "not run yet"; it
  never runs the command itself.
  Not in `aya team whoami`: the roles get its output, not the command.
  Security: the command is the user's own and runs with the user's rights, like
  a git hook. Aya runs only the copy saved in Aya, never a team file that came
  with a pull or a clone; the card names a new or changed command before "Save
  this team" or "Use the repo version", and an agent's `aya team save` can
  neither add nor change it (it keeps the saved one), since it would run
  outside the agent's sandbox.
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
presets with the agent each runs, whether its CLI is installed, by the
same check a pane spawn makes ("command not found"), and whether a role's
pane of it reaches Aya. The guide's last step
has the agent propose a pane per role and wait for the user's yes, then run
`aya team open <team> <role>=<target> ...`. A target is `this` (the calling
pane), `new:<preset>` (a new session), `pane:<name-or-id>`, or the bare
preset id, pane id or pane name when only one of them matches; a name that
is both a preset id and a pane name, or two panes' name, is refused with the
explicit forms or the candidate ids. Roles not listed keep their panes.

Main checks every pick before anything changes: the team is saved in Aya,
each role exists and is listed once, each preset is installed and a role's
pane of it reaches Aya without an escalation, no pane goes
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
(the same pane check, nothing sent while a role is missing or busy). Start of a
team that is already running, or started a moment ago from another pane or the
window, is refused in one place for both: "team <name> is already running; nothing was sent"; the
guide has the agent ask whether to start and with what task, and run it only
on the user's word. A task then goes, after the delivery tests, as a message
from `user` (reserved like `aya`, and redelivered like a peer's message) to
`--to`, else the lead (the role with the cadence is the lead), else the first role;
the output and the Teams window's Start say who got it: the Task field's
placeholder names the recipient before Start ("Task for tester (the lead)"), and a
select next to it picks another role.
`user` is reserved when a team is saved, not when a saved one loads: a team
saved with a `user` role before keeps working, and starts, but takes no task,
so its log never mixes the role with the user. A team saved with `aya team save` from a pane is
marked as the agent's, so the window's "Assign team roles?" prompt does not
compete with the agent's proposal; a team that arrives with a pull still
gets the prompt. The mark goes once a role gets a pane or the team is saved
from the window, so a team whose panes all closed later is offered again.

The Teams window runs the same `openTeamPanes`: per role it offers the open
panes, each labelled with the role it already plays, and `New: <preset>`
for installed presets. Picks wait for **Apply panes**, which spells out a
move that leaves another role without a pane.

## When Aya does not type a message

A message waits in the receiver's inbox, and goes out by itself once the
pane is free (checked every 15 s), when the pane:

- is not running, or its agent has not drawn its composer yet (Claude
  took about 1 s, Codex 0.5 s, measured). Codex 0.159.3 draws its composer
  under its start-up logo about 0.35 s before its trust or update dialog, so
  while the logo is up its first composer counts only once the screen has
  not changed for 1 s (at most 8 s after the start). Antigravity (agy
  1.2.14) takes a message only on its idle composer (a `>` row between two
  rules, then `? for shortcuts`); its trust dialog, `/` palette and model
  picker are held as a choice, a draft as a draft, any other screen as busy.
  A CLI whose composer Aya does not know (kilo, pi, Cursor, a custom preset)
  counts as starting until it has drawn and its screen has not changed for
  1 s, at most 8 s after it started, once; one that stays blank longer
  than 8 s is still typed into too early;
- shows an approval prompt, Claude's folder-trust dialog, a numbered
  menu, OpenCode's update box (drawn over its composer, "Skip  Confirm"),
  or a line prompt ending in `[Y/n]`, `(y/N)` and the like, with or without
  a colon. When the prompt asks to run an `aya` command (Codex `-a untrusted`;
  `on-request` when Codex asks to leave its sandbox, as recorded with a model
  that asked; Claude without `Bash(aya:*)` allowed) the role's row and
  the Start summary say "waiting for you to approve an aya command": that
  role cannot report and nothing reaches it until you answer. Aya never
  answers for you;
- has text the user is typing, or runs a plain shell.

  An answer that only says "Do you want me to continue?" or "waiting for
  approval" holds nothing while the agent's composer is drawn at the bottom
  of the screen with nothing but its footer below it (Claude, Codex,
  OpenCode, and Grok in `always-approve`). Not recorded yet, so read by
  the wording alone: Grok's approval in its other modes. To add it, record
  the pane with `aya pane read` while the dialog is up, at two widths,
  together with the screen right after it is answered;
- was launched in a mode whose `aya` calls cannot reach Aya (the table at
  the top).

Messages go in as a bracketed paste: Codex took fast raw typing for a
paste and swallowed the Enter after 600+ characters (measured on 0.158).
A message is flattened to one line first: control characters (including a
paste terminator), private-use and unassigned code points, the braille blank
and every space except U+0020 (read as a plain space), and every format or
default-ignorable character (bidi overrides, zero-width, joiners, Unicode tag
characters, variation selectors) are dropped. A held
message is cleaned when it is stored and again when `aya team inbox` prints
it, so the inbox cannot carry controls into the pane either.

So `aya team send` cannot inject terminal controls or hidden text.
Homoglyphs (Cyrillic a for Latin a) are out of scope.

Costs: an emoji joined with ZWJ splits into its parts (a family shows as
its members), VS16 goes (a symbol shows text-style), Persian and Indic text
loses its ZWNJ/ZWJ; England, Scotland and Wales flags become a plain black
flag (their tag characters go); a no-break space or ideographic space becomes
a normal one. `aya pane send` is raw by design.

The hold is checked again right before that Enter, so a prompt drawn during the 150 ms
gap gets no Enter; one drawn after the 150 ms gap, past that last check, still would. A message whose Enter was
withheld stays typed in the composer: the log says "typed, Enter withheld", and later
messages to that role wait until you submit or clear it.
Accepted risk: an unnumbered picker without a rule (Codex, OpenCode or Grok) drawn in that gap reads as a draft, which the last check tolerates, so Enter goes into it.
Claude's pickers are covered by their "Enter to confirm · Esc to exit" footer.
Start checks every pane first and sends nothing while one is not ready.

A relaunched Aya keeps the roles, goes on from the last round number and
types a peer's held message once the panes are up; Aya's own old rounds and
delivery tests are dropped. An agent that outlived the app and calls
`aya team` while Aya restarts waits up to 15 s (`AYA_OPEN_WAIT_SECONDS`) for it.
Once the socket is up but the projects are not restored yet, `aya team` answers
from the saved team, or is refused with "Aya is still starting" and asked again
within the same wait; it never says the pane belongs to no project.
If Aya goes away after taking the request but before answering, the command
fails instead of reporting success: the message may or may not have been typed.

The round timer goes on across a relaunch: Aya keeps when the last round was
due and arms the rest of the cadence, so an Aya that restarts more often than
the cadence still runs rounds. A running team also keeps going when its repo
file is gone (a checkout of a branch without it): it runs from the copy saved
in Aya, and the Teams window, `aya team open` and `aya team start` still see it.
Its card says the file is gone and offers **Remove team**, which forgets the saved
copy, state, panes and log (the repo is not touched); `aya team new` can then
reuse the name from scratch. Remove is refused while the repo file exists, and a
round or message write still in flight when it runs is dropped. There is no
`aya team` command to remove a team.
Every running team has one clock that looks about once a minute (`ROUND_CHECK_MS` in
`electron/team-times.ts`): it records what moved (below) and, for a team with a lead, whether a
round is due on the cadence, the silence or a stall; one round at a time, and its number and
clocks are written in one step. A due round that is not typed (the lead is busy, has a draft, is
not running, asked the user, the team was paused meanwhile, or the team is stalled) stays due:
the next look that finds the pane free types it, and the team log gets one line per round and
reason ("round 5 skipped: is busy working"). A round due at relaunch is tried at each look
until the panes respawn.
Messages reach a role in the order they were sent: while one is still waiting in its inbox, a
newer one from a role or the user waits behind it ("earlier message #3 for it is still waiting;
this one follows it") and is typed by the next pass, one per pass; Aya's own rounds and tests do
not queue behind reports. `aya team inbox` takes its messages and marks them read in one step, so
the inbox and the redelivery never both hand over one message; a reply that cannot be written to
the command (it was killed, its pane closed) gives them back, owed and held as before. (A command
killed after its reply reached the socket but before it printed still loses them.) The window tells how a held message
got there: "read via inbox" (the receiver took it with the command), "written later" (Aya typed
it once the pane was free), "typed, Enter withheld" (a prompt appeared after the paste, also on a
redelivery; the draft note then names it). A message held for a role a Save removed or renamed
says "no longer a role of this team; this will not be delivered". Aya's own skipped rounds and
tests are not counted as unread messages. A report refused by the send cap (10 a minute) shows as
one line a minute in the log.

Held rounds are skipped, never queued. The round number and its clock are written together,
and a tick that finds a round typed by another arm since it last looked ends and goes
on from the stored number, so a Save or Resume that lands while a round is being typed
neither repeats a round nor stops the ones after it. A held peer message whose
text already reached the composer (a prompt appeared after the paste) is marked read and
not typed a second time.

"Delivered" means typed, not read, and delivery is at-most-once. A message is
marked before it is typed, so a crash or a failed Enter in between never types
it twice. The mark says whether the paste began: a crash while the message still
waited for the pane (another paste held it) leaves it owed, typed by the next launch;
a crash once its paste began loses it, and it counts as typed ("Aya went down while
typing it"). If the pane is reaped
after the message went in (a pty host rebuild kills its agents), the message is
not typed again into the respawned agent: it is gone with the agent's session.
A message whose Enter failed stays in the composer as a draft and is not retyped.

## Liveness

Aya notes what moves, per team, in `progress.json`. **Progress** is a change to the
repo: a new HEAD, or a changed working tree. The working tree is read as a fingerprint of
`git status --porcelain` and the diff of tracked files against HEAD, so an edit counts (also a
second edit of a file already changed, and a new untracked file). Both are read by the team's
clock at each look; the Teams window only reads what the clock recorded, so a commit or an
edit shows at its next look. HEAD and the tree are the
project's, so a change by anyone in the project counts for every team in it; a commit in a
git worktree that moves neither does not count; an unreadable HEAD or tree is "unknown",
never a change, and the first read of the tree is a baseline. HEAD going back to a commit the
team already had (a role checking an older commit out to measure it) is no change (live sudoku
run: 11 of 18 HEAD moves were such returns); the known HEADs survive Pause, Resume and relaunch.

**Talk** is a delivered peer message of more than one word (an "ok" ack is not). It holds off
the quiet-team round, but it is not progress: a team whose
roles exchange messages and change nothing says "talking - no change to the repo since 22:52
(14 messages); flagged after 60 min without one". A message held for a busy pane is not talk
while it is held; it counts when it is typed later. One typed with its Enter withheld (a
draft nobody submitted) does not count: nothing has read it. (Live sudoku run: about 90
messages about one commit over 12 minutes read as "progressing".)

- **Quiet team**: whether or not the team has a cadence, a lead is asked for a round
  when the team has had no message and no change to the repo for 30 min, then every 10 min
  while it stays quiet. The clock is its own field in the team's state (`silenceRoundAt`), counted
  from the later of the last message or change and the last such round, so it survives a
  relaunch; a relaunch, Start and Resume start it over (a pause stops it). The round
  is numbered with the cadence's rounds ("Round 4: no progress since 18:04 (31 min).
  Unanswered: implementer waits for tester since 18:05 (30 min) ... If you cannot,
  ask the user with: aya status waiting ..."; a role waits for another until something
  that one sent after it reaches it, directly or passed on by other roles, so a message the
  other role sent a third one about something else is no answer, nor one still held in its inbox
  or typed with its Enter withheld): one round at a time, a cadence
  round due at the same moment carries this text instead of a second round, and no such
  round comes within 10 min of another round. A message that goes in while this round waits for the
  lead's pane (a held report typed to it) ends the quiet: the round is not typed, its number not
  used, and the next one counts from that message. A busy lead waits (tried at each look until
  it is free) and is not counted as missed; a lead whose pane cannot take it is counted as the cadence's
  rounds are (Unreachable). A lead that ran `aya status waiting` is left alone until
  the next progress, by the cadence's rounds too, and each round skipped for it leaves one line
  in the team log ("round 5 skipped: lead asked the user: need the staging password"). Only the
  agent's own `aya status waiting` is a question: Aya's status hook reports no Notification
  (Claude's and Grok's fire on dialogs and idle composers alike), and no hook ends a
  question. The question is kept in `agent-waiting.json` under the Aya home with the pane's session
  id, so a restart puts it back on the pane; after a restart it holds rounds only while the pane
  runs that session (a resume of it): in a new session, or with either id unknown, the team log
  gets "question from before the restart: <text>" once and the rounds run, while the Teams window keeps the question,
  marked "asked you before the restart (HH:MM), not confirmed since; rounds go on" (a CLI with no session id, such as
  kilo, pi or a wrapper, always lands here); the user's Enter in that pane ends it (not an Enter that answers a CLI
  dialog on its screen), as does the agent's next status; its next message lifts the hold on rounds. A team with no lead gets no round, only the status. The limits
  (30 / 10 / 60 min) live in `electron/team-times.ts`; `AYA_E2E_TEAM_MINUTE_MS`
  scales them.
- **The lead ends the work**: a lead that has the answer ("no lower complexity is possible")
  runs `aya team pause "why"` from its own pane. It pauses the team as the Pause button does
  (no more rounds, sends or silence clock), the log says "<lead> (the lead) paused the team:
  <why>", and the user resumes it in the Teams window. Only the lead may call it, only on a
  running team; `aya team whoami` tells the lead so. A paused team keeps a task the lead never
  got: a Start that went down before typing its task types it on the next launch or Resume.
- **Who paused it resumes it**: `state.json` keeps `pausedBy`: "user" for the window's Pause,
  the lead's role for `aya team pause`. The window's Resume and Start, and `aya team start`
  from outside the team's panes (a shell pane with no role, a terminal outside Aya), are the
  user's and resume any pause. `aya team start` from a pane of one of the team's roles is that
  role's: refused on a running team ("the team is running; use aya team send to give a role
  work") and on a pause that is not its own ("the user paused this team; only the user can
  resume it"); the lead may resume its own `aya team pause`, and then the log has "<lead> (the
  lead) resumed the team it paused" and its task logged from the lead, not "user". A pane is a
  role's when the id it carries, or the pane its process runs under (the process tree, so
  unsetting AYA_TERMINAL_ID does not hide it), plays a role in that team. An id typed by hand in
  another pane's process tree is refused for `aya team start` and `aya team save` ("cannot be proven
  to come from this pane"): it would resume the lead's pause or replace that pane's team file. The user's Pause on a
  team the lead paused makes it the user's; a lead's pause never takes the user's over. A
  `state.json` paused by older code has no `pausedBy` and counts as the user's. (Live sudoku
  run: the user paused, then the always-approve Grok lead ran `aya team start` three times in
  three minutes and each one resumed the team, logged as "user -> implementer".) A user who
  types `aya team start` inside a role's pane is told the same: resume in the window.
- **A pause stops sends**: `aya team send` on a paused team is refused and logs nothing; a send
  that was already waiting for the receiver's pane (another message being typed there) when the
  Pause came types nothing and is kept for the inbox, typed after Resume; one paused between its
  paste and its Enter keeps the text in the composer without the Enter, as a round does. The same
  holds for what a Start, a Resume or a new pane's introduce is still typing: delivery tests not
  typed yet stay held, the task is kept for Resume, and no clock runs on the paused team.
- **Stalled**: 60 min with no change to the repo, whatever the rounds did and however much the
  roles talk (so a team with no cadence, a busy or unreachable lead, and roles that only talk
  stall too); rounds nobody answers are no stall of their own (they hold the next rounds, see
  Unanswered rounds). The window says "stalled: no
  change to the repo since 22:52 (14 messages) - rounds are paused until the repo changes". The
  stall makes a round due, and that ordinary numbered round tells the lead, once per stall, with
  who waits on whom ("Round 13: stalled: no change to the repo since 22:52 (14 messages).
  Unanswered: implementer waits for tester since 22:40 (12 min). Messages are not progress:
  decide the next change to the repo and who makes it, or end the work with aya team pause ...");
  it waits for a busy lead and is skipped for a lead that asked the user. Later rounds are skipped
  while the stall lasts, one log line each ("round 14 skipped: stalled: no change to the repo since
  22:52"). Only a change to the repo ends a stall, seen at the clock's next look. Start or Resume
  start both clocks over, and so does answering a screen a role had been blocked on for over 2
  minutes (a screen up for seconds does not). A team stalled at the clock's last look before Aya
  was closed is still stalled after the relaunch, with the same time (audit G1); for any other
  team the 60 min restart from the launch, as the time Aya was closed is not the team's. A
  `progress.json` written by older code has no repo fields: the 60 min then run from its last
  progress, which is never earlier than the last change, so nothing reads as stalled early.
- **Unanswered rounds**: after 3 rounds in a row typed to the lead without an answer, the next
  rounds (on the cadence or the silence) wait for one instead of piling up in its queue. An answer
  is any message from the lead (an "ok" too, and one still waiting in a busy peer's inbox: the
  lead read its rounds) or a change to the repo (a commit the team has not had, or a changed
  working tree), seen at the clock's next look; a round the pane did not take (busy, a draft) is
  not unanswered. The team log gets one line per hold ("rounds held: tester did not answer rounds
  1..3") and the window says "rounds wait for tester to answer (3 unanswered)". The count is kept
  in `progress.json`, so a relaunch keeps the hold; Start and Resume end it, and the lead's next
  answer lets the due round through at the next look. Stalled runs on its own: the one round of a
  stall still goes to a held lead.
- **Busy**: a round is not typed into an agent that is mid-turn (Claude, Codex and
  OpenCode draw "esc to interrupt" then; Claude's spinner row, "✻ Compacting conversation...",
  counts too, as a narrow pane cuts the footer off; Grok's marker is not captured, so its
  rounds are still typed). A round the pane could not take (busy, a draft, a prompt) stays
  due and is tried at each look; the log gets one "round N skipped: is busy working" line, a
  busy lead is not counted as missed, and the agent gets one round at the first look after it
  finishes, not one per look it was busy. Peer messages are still typed at once.
- **Blocked**: a role seen on its own CLI's approval or numbered-choice screen for
  over 2 minutes. The Teams window says "stalled since 18:34 - tester is waiting
  for you in its CLI" and marks the role; answering the screen clears it at once.
  The screens are read by the team's clock at each look, so this needs no cadence or
  lead; the window hides a block at once when the pane no longer shows the screen. The
  window says what watches a team: "progressing - the lead gets a round every 3 min" with a
  cadence, "the lead is asked for a round after 30 min without a message or a change to the
  repo" without one, then "flagged after 60 min without a change to the repo". A role
  counts as answered after two free reads in a row (one glitch does not wake a
  stalled team), and a pane closed for over 2 minutes is "not running", no
  longer "waiting for you".
- **Unreachable**: the role the rounds go to has no pane, or a pane that took none of the last 3 scheduled
  rounds (its agent exited, it dropped to a shell, it is still starting, a draft sits in its
  composer). Nothing is typed then, so nothing goes silent and the team would read as
  progressing; the window says "no round typed to implementer since 18:34: its pane is not
  running" and stops saying it as soon as the pane takes a message again. A lead whose pane was
  closed is unreachable too ("...: it has no pane") until it is given a pane. A busy agent is not
  this (its rounds wait by design), a screen waiting for you is Blocked, and the retries of one
  round due at relaunch count once.
- Known limit: this is shown only in the Teams window. With it closed, a blocked
  or stalled team waits unseen; there is no notification yet.
- OpenCode's plan agent asks its approval with OpenCode's question dialog; it is
  recognised by that dialog's footer ("enter submit  esc dismiss"), captured from
  opencode 1.18.30 (`tests/fixtures/opencode-plan-question.screen.txt`). Its
  permission dialog (a build agent asking to read outside the project) is
  recognised by its buttons ("Allow once  Allow always  Reject"), recorded at 80
  and 134 columns (`tests/fixtures/opencode-permission-*.screen.txt`); both
  replace the composer. A permission asked for a shell command is not recorded. The
  `plan_exit` dialog of a build that has that tool is not captured.

Known and accepted (found by the iterated Sol 6.1 review of the sudoku scenario):

- **A crash between the paste and the round's number (N3.2)**: the round is typed, Aya goes down
  before it writes the number, and the next launch types "Round N" again. A repeated poke is
  harmless; a write-ahead number would leave a gap in the numbering when the paste then fails.
- **A Save of the protocol or responsibilities does not tell running agents (N3.3)**: they read
  `aya team whoami` once. A fix needs a new mechanism: on a Save that changes what whoami prints,
  type "run aya team whoami again" to each role with a pane (a message from aya, dropped when held)
  and show "older brief" on the role until its next `whoami` (a per-role whoami time in the state).
- **A changed Config directory resumes a fresh session (N3.5)**: designed ("Gone needs
  certainty", `electron/claude-session.ts`), and not in the scenario.
- **Claude's usage-limit screen (N4.1) and a multi-select "Submit" row (N4.4) have no rule**: the
  exact screens are not captured, and a rule written from memory could hold real prompts. Record
  them with a real Claude (`aya pane read` at the moment, full width and 40 columns), add them to
  `tests/fixtures/`, then add the rule beside `claude-trust-confirmation`. A usage limit still ends
  in "stalled" by the clock. The spinner glyphs other than the captured ✻ and ✽ (✢ ✳ ✶) are not
  captured either (N4.2); a narrow pane and `/compact` are to be recorded the same way.

Tests: `tests/team-liveness.test.mjs` (cadence x progress x blocked x message x commit x
action table), `tests/team-silence.test.mjs` (quiet-team clock x lead pane x clock x action,
and stalled by time) and `e2e/team-liveness.spec.ts`, `e2e/team-silence.spec.ts`, which fire real
ticks (`AYA_E2E_TEAM_MINUTE_MS`, `AYA_E2E_TEAM_BLOCKED_MS` shorten the periods; no test waits
longer than 3 minutes for a rhythm or a silence limit).

## Debug on

One switch shows why a team does what it does: `aya debug on` (or `AYA_DEBUG=1` in Aya's environment) makes
Aya write every decision of every running team as one JSON line in the team's `debug.jsonl`, next to its
`log.jsonl` in `$AYA_HOME/teams/<project>/<team>/`. `aya debug off` stops it, `aya debug status` says which;
the switch is `$AYA_HOME/debug.json`, read at launch and on its change, so no restart is needed. Off is the
default and costs one boolean read per decision: nothing is formatted or written.

`aya team debug <team>` prints the last 50 entries as `HH:MM:SS event field=value ...`, `-f` follows new ones
(also after a rotation); a team name found in two projects needs `AYA_PROJECT_SLUG`. The file is rotated to
`debug.1.jsonl` past 5 MB. A message's text and a command's output are cut to 80 characters, other strings to
300; no env or tokens are written.

| event | written when | fields |
|---|---|---|
| `start` | Start or `aya team start` answered | `by`, `started`, `held` (role, reason), `refused`, `task` |
| `hold` | a message was not typed, or its Enter was withheld (a Pause mid-typing too) | `to`, `from`, `id`, `reason`, `typed` |
| `turn` | an Enter went: whether a turn was seen to start | `to`, `from`, `id`, `seen`, `why` (not seen, a dialog) |
| `owed` | the queue of a role: a message logged as owed, read or typed (`done`, up to an id), given back | `role`, `change`, `id`/`upTo`, `from`, `text` |
| `reserve` | `typing.json`: `queued` -> `pasting` -> `dropped`; `folded` when a crash left one | `role`, `id`, `state`, `pasting` |
| `pause` / `unpause` | the Pause token moves (a send or round in flight stops) | `by`, `token` |
| `round-check` | each look of the clock of a team with a lead | `rhythm`, `silence`, `stall` (due), `stallTold` |
| `round` | a due round: typed, skipped (why), held by the brake | `round`, `reason` (rhythm/silence/stall), `typed`, `skipped`, `held`, `unanswered` |
| `liveness` | the status changes (progressing, talking, stalled, unreachable, blocked, paused) | `status`, `why` |
| `redelivery` | a pass finds a message owed to a role | `role`, `id`, `hold` |
| `socket` | the socket answers an `aya team` command | `command`, `caller`, `role`, `ok`, `output` or `error` |
| `launch` | a pane's unknown launch verdict is settled by a call from its process | `pane`, `role`, `verdict` |

Not covered: a socket refusal before the caller's team is known (an unproven pane id) and `aya team save`
(the team is named inside the file). Tests: `tests/team-debug.test.mjs` (event x scenario, off writes
nothing, on and off without a restart, rotation), `tests/aya-cli-debug.test.mjs` (CLI under sh and dash),
`e2e/team-debug.spec.ts`.

`aya team stats <team>` (`--json` for the same as JSON) counts what Aya did for the team, from its files only,
so it works with Aya closed: run time (`log.jsonl`), messages per sender and receiver and per role, the last round
(`state.json`), held messages by their note (`delivery-notes.json`), messages still in an inbox and each role's read
mark (`read.json`), who waits on whom, HEADs seen (`progress.json`), and the status command's last run as a round
recorded it (`status.json`; stats never runs the command). Rounds typed and skipped and why, hold
decisions by reason, redelivery tries and pauses come from `debug.jsonl` (and `debug.1.jsonl`): without debug on,
those rows say they need it rather than count zero. Hold reasons are grouped by kind (`#N` for message ids). It
reads `electron/team-stats.ts` compiled beside the CLI (in the app, `app.asar.unpacked`).
Tests: `tests/team-stats.test.mjs`.

## Testing teams in Aya Dev

- Aya Dev rebuilds and restarts when `electron/` changes, and a change in
  a module the pty host runs restarts the panes too. A team working on
  Aya's own `electron/` restarts itself mid-round; give it another repo,
  or expect to reassign roles.
- Aya Dev agent panes get this branch's `aya` first on PATH, so `aya team`
  works even when an older Aya.app is installed. Its plain shell panes do not:
  they run the `aya` the shell's rc files put first, which may be the installed
  production copy (no pid, so a forged id passes there; measured by hand).
- An agent that exited is not respawned on relaunch when the pty host survived:
  the pane shows "session ended - press Shift+Enter to restart" (by design, a
  respawn would hide that the process died), and Restart terminal resumes its
  saved conversation. A fresh host starts the panes again with their resume.
- Not verified: whether `claude --continue` re-applies `--append-system-prompt`
  (a role note); a restart resumes by id with the note on the command again.
- Start Aya Dev from a plain terminal if you can; panes drop the markers
  of a Claude Code session they inherit, but nothing else.

## Accepted limits

Each was found by the PR #149 ship-gate, re-checked, and left as it is: closing it would change what Aya does, or costs more than it saves.

- **A `codex` typed by hand into a shell pane**: Aya does not see it, so its launch mode is unknown and not held, and it uses the shared daemon. Pinned in `tests/team-panes.test.mjs`.
- **Crash between the start of the paste and its Enter (L1)**: the message is lost and counts as typed (a crash while it waited for the pane no longer loses it, Grok final #6). Stated in "Delivered means typed" above; at-most-once is the price of never typing twice. A write-ahead paste confirmation read back from the screen would close it.
- **Oversized write during a spawn (L2)**: a chunk that does not fit the 64 KB pre-spawn queue is refused whole and reported not delivered (a `pending-write-dropped` line in the pty log), so no cut paste is left in the pane. Teams never write then (a spawning pane is held); it bites a raw `aya send` of over 64 KB to a pane still starting, which has to be sent again.
- **Message cap counts UTF-16 units (L4)**: `TEAM_MESSAGE_MAX_CHARS` is 8,000 characters as the error says, so a message of 3-byte characters is up to 24 KB, of emoji up to 16 KB. The log stays bounded by its 2,000 entries. A byte cap would close it, and cut what a CJK user can send to a third.
- **Preset reach is not shown in the Teams window (L7)**: `PresetChoice.reach` and `cantReach` are read by `aya team presets`, not by the window's picker, and the window computes them without the project's config. A blocked preset is refused with the reason when the panes open. Showing them in the picker is a UX change.
- **A block clears on the first free read (L9)**: the Teams window stops saying "waiting for you" after one free read (answering clears it at once, as above) although it takes two to wake a stall. A glitch read shows "progressing" until the next refresh, about 5 s. Keeping the row until the second read would close it, and would make answering feel slower.
- **A relaunch starts the silence and the repo clock over (L10)**: the time Aya was closed is not the team's, so the silence and the stall count from the launch; a team stalled at the clock's last look before the close stays stalled (G1), and a lead that had asked the user keeps its rounds held. Agents that outlive Aya answer into the message log, which counts. Pinned in `tests/team-liveness.test.mjs` ("a restart in between starts the repo's clock over", "stalled + restart").
- **A Pause leaves a skipped round in the log**: a round that was being prepared when the team paused is not typed; the log gets one line from aya, `round N skipped: the team is paused`.
- **The process-tree proof catches accidents, not a forger (R-D1)**: it trusts the pid the CLI sends; a missing or unknown pid is not refused; no pid start time, so a recycled pid passes; remote tabs are skipped. Pinned in `tests/caller-proof-forger.test.mjs`.
- **`exec -a name claude` needs a shell with that form**: a preset using it fails (`exec: -a: not found`) when the account's login shell is dash. Aya runs presets in `$SHELL`, then the account shell, then `/bin/bash`; write the preset without `-a`.
