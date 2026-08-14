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
- `aya pane read "reviewer"`: print another pane's recent output.
- `aya pane send "reviewer" "run the tests"`: type text into another pane.
- `aya pane send "reviewer" --submit "run the tests"`: type it and press Enter.

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

- Use `pane read` to check on work you handed to another agent, or to collect
  its result — it returns that pane's recent output, newest last.
- Use `pane send` only for a pane the user has explicitly asked you to drive.
- Prefer `pane send` WITHOUT `--submit` when the text is a prompt the user may
  want to review; `--submit` presses Enter and the other agent acts on it
  immediately.
- There is no "wait until done" — poll with `pane read` if you need to see a
  result, and give the other agent time between reads.

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
