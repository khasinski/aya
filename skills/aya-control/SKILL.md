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

## When To Use

- Set status before long-running commands, builds, tests, migrations, or multi-step edits.
- Use `waiting` when blocked on user approval, credentials, missing files, or a decision.
- Use `done` or `error` when a long-running task completes and the user may not be watching.
- Use `clear` when the status is no longer relevant.
- Keep status text short: 2-6 words is ideal.
- Do not set status for every ordinary command. Prefer meaningful phase changes.
- If `AYA_TERMINAL_ID`, `AYA_PROJECT_SLUG`, and `AYA_SOCKET` are present, commands automatically attach to the current Aya pane.

## Guardrails

- Only use the public `aya` CLI. Do not inspect Claude, Codex, or provider auth files, quota files, hidden logs, or internal process state.
- Do not automate Claude/Codex through hidden or non-interactive subscription surfaces.
- Claude Code and Codex should still run as normal interactive TUIs; Aya status commands are only side-channel UI hints.
- Do not spam notifications. Notify only when user attention is genuinely useful.
- If `aya` fails or is not installed, continue the task normally and mention the failure only if it matters.
