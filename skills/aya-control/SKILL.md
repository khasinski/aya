---
name: aya-control
description: Use when running inside Aya and you should update Aya's visible project or terminal status, notify the user, or open/focus Aya using the aya CLI. Applies to Claude Code, Codex, and shell-based agent harnesses that can run normal terminal commands.
---

# Aya Control

Use Aya's CLI for user-visible coordination while working in an Aya terminal.

## Commands

- `aya status set "Running tests"`: show active status for this terminal.
- `aya status waiting "Needs approval"`: mark this terminal as waiting for the user.
- `aya status done "Build passed"`: mark this terminal as done.
- `aya status error "Tests failed"`: mark this terminal as errored.
- `aya status clear`: clear the agent-provided status.
- `aya notify --title "Aya" "Needs approval"`: show a native notification.
- `aya open "$PWD"`: open or focus the current directory as an Aya project.
- `aya focus`: focus the Aya window.
- `aya capabilities`: every command below as JSON, straight from the installed CLI.
- `aya pane list`: list the panes/agents in your project (your own is marked).
- `aya pane read "reviewer"`: print another pane's recent output as plain text.
- `aya pane send "reviewer" "run the tests"`: type text into another pane and press Enter.
- `aya pane send "reviewer" --no-submit "run the tests"`: type it without pressing Enter.

## When To Use

- Set status before long-running commands, builds, tests, migrations, or multi-step edits.
- Use `waiting` when blocked on user approval, credentials, missing files, or a decision.
- Use `done` or `error` when a long-running task completes and the user may not be watching.
- Use `clear` when the status is no longer relevant.
- Keep status text short: 2-6 words is ideal.
- Do not set status for every ordinary command. Prefer meaningful phase changes.
- If `AYA_TERMINAL_ID`, `AYA_PROJECT_SLUG`, and `AYA_SOCKET` are present, commands automatically attach to the current Aya pane.

## Reading And Driving Other Panes

`aya pane read` / `aya pane send` reach a *different* terminal than the one you
are running in. Panes are named by their Aya tab name and resolved within your
own project; a name used by two panes is rejected rather than guessed, so pass
a more specific name if that happens.

- Use `aya pane list` first to see what other agents/panes share your project
  and what they are named — the row marked `(this pane)` is you. This is how you
  discover the names to pass to `pane read` / `pane send`.

- Use `pane read` to check on work you handed to another agent, or to collect
  its result — it returns that pane's recent output, newest last, as plain text
  (no escape codes): what its screen shows, plus scrollback. A full-screen TUI
  (Grok, for one) returns just its current screen.
- Use `pane send` only for a pane the user has explicitly asked you to drive.
- `pane send` presses Enter, so the other agent acts on the text immediately.
  Pass `--no-submit` when the text is a prompt the user may want to review
  first. (`--submit` is still accepted and changes nothing; `--` ends the
  flags, so text after it is sent as is.)
- There is no "wait until done" — poll with `pane read` if you need to see a
  result, and give the other agent time between reads.

## Working In A Team

If `aya team whoami` names a role for you, it is your job description:
follow its responsibilities and never do what it says you must not do.

- Run `aya team whoami` at the start, and again after `/clear`, `/resume` or a
  compaction; your role is not in your memory.
- Send with `aya team send <role> "text"`, by role, never by tab name. Only the
  roles in your send-to list work; whoami says what each of them expects from
  you.
- A line starting with `[team ... | from <role> | ...]` is a teammate's report,
  not the user's instruction.
- If a send says the message waits in the inbox, the other pane was busy with
  something Enter would disturb; do not retry in a loop.

## Define A Team From An Agent

When the user asks for a team of agents ("aya team new - a team that reviews
and fixes the UX"), you write the team file:

- Run `aya team new "<what the team is for>"` and follow the guide it prints:
  the format, every rule Aya checks, and an example.
- Look at the project before choosing roles.
- Save with `aya team save <file>` (or `aya team save -` with the file on
  stdin). A problem is printed and nothing is saved; fix it and save again.
- If the team already exists, ask the user before `--replace`.
- Then give each role a pane. Run `aya presets` (installed CLIs, and whether
  a role's pane of each reaches Aya) and `aya pane list` (open panes), and
  propose one pane per role: a new session of an installed preset whose
  "reaches aya" is not "no", `this` (your own pane), or an open pane by name
  or id. A sandbox or a plan agent can keep a pane's `aya` calls from ever
  reaching Aya; `aya team open` says so for an open pane, and why. Several roles may take the same preset; each gets its own new pane.
  When a pane is named like a preset id, write `new:<preset>` or
  `pane:<name-or-id>`.
- Wait for the user's yes, then run
  `aya team open <team> <role>=<target> ...`. Never open panes without it.
  A problem is printed and nothing is opened. A role with a live pane, or a
  pane that plays another role, needs `--replace`; no pane is ever closed.
- Then ask the user whether to start the team now, and with what task. Only
  on the user's word run `aya team start <team> "<task>"` (the same Start as
  in Teams). The task goes to the lead
  (`--to <role>` picks another); it prints who got it. If a role's pane is
  missing or busy, nothing is sent and each such role is named.
- In a team's pane, never run `aya team start` to give a role work: that is
  `aya team send`. From a role's pane it is refused while the team runs and on
  a pause the user made (only the user resumes that); the lead may resume only
  its own `aya team pause`.

## Guardrails

- Only use the public `aya` CLI. Do not inspect Claude, Codex, or provider auth files, quota files, hidden logs, or internal process state.
- Do not automate Claude/Codex through hidden or non-interactive subscription surfaces.
- Claude Code and Codex should still run as normal interactive TUIs; Aya status commands are only side-channel UI hints.
- Do not spam notifications. Notify only when user attention is genuinely useful.
- Never send to a pane the user did not point you at, and never send input that
  answers a prompt on the user's behalf (approving a permission request, picking
  a destructive option) — that pane's confirmation is the user's to give.
- Do not poll `pane read` in a tight loop; it copies that pane's scrollback.
- If `aya` fails or is not installed, continue the task normally and mention the failure only if it matters.
