# Herdr

Date: 2026-10-31

Decision note. Herdr (`herdr.dev`, `herdrdev/herdr`, `herdrdev/herdr-app`,
`herdrdev/herdr-core`, Apache 2.0, Rust) is the closest sibling to Aya in the
category: a desktop and terminal runtime for long-lived coding-agent sessions on
the user's own subscriptions. Sources checked that day:
[herdr.dev](https://herdr.dev),
[herdrdev/herdr](https://github.com/herdrdev/herdr),
[herdrdev/herdr-app](https://github.com/herdrdev/herdr-app),
[herdrdev/herdr-core](https://github.com/herdrdev/herdr-core).

## What Herdr is

Herdr started as a Rust TUI multiplexer (`ratatui` + `ghostty-vt`) and split
into a background runtime (`herdr-core`, CLI `hc`) and clients that attach to
it over a local OpenRPC socket (`hc schema`): the native desktop client
(`herdr-app`), the TUI (`herdr`), and web/mobile companions (`Ovis`, `Collie`).
Closing a client window or dropping an SSH connection leaves the PTYs running in
`herdr-core`.

Around that runtime sit four ideas:

1. **Program Status Protocol (`OSC 7501`) plus screen fallback.** Every pane is
   classified as `working`, `blocked` (*needs you*), `done` (finished and not
   yet seen by the user), or `idle` (finished and seen, or at a prompt). When a
   tool or agent emits `ESC ] 7501 ; state=... ST`, Herdr takes the state
   directly; otherwise it falls back to per-agent screen rules.
2. **CLI control plane (`hc`).** Agents and scripts inspect panes with `hc ls`,
   spawn a background helper pane with `hc run --bg <agent> "<task>"`, and send
   input to another pane with `hc send <pane_id>`.
3. **"Made for your agents. Remade by them."** The desktop client's chrome is
   defined by plain files in `~/.config/herdr-app/`: `AGENTS.md`,
   `layouts/*.json` (including a kanban `board.json` with *Needs you / Working /
   Done / Idle* columns), and `mods/`. An agent inside Herdr can read
   `AGENTS.md` and rewrite the window layout or apply a community `RECIPE.md`
   from GitHub (`herdr-layout`, `herdr-mod`).
4. **Multi-machine SSH.** Local workspaces and saved SSH boxes appear in one
   window with independent reconnects (`herdr --remote ssh://...`).

## Where Aya is stronger

Aya's unit is a project directory, not a multiplexer workspace. Switching a
project tab swaps the whole checkout, its terminals, its git status bar, and
its worktree groups (`cd` into a worktree and the terminal follows).

Aya tells you what a pane is doing, not only its traffic light. On-device
one-line summaries (Apple Intelligence, Ollama, or a compatible endpoint) sit
under the project tab and the terminal row. Account-wide usage chips (Claude,
Codex, Antigravity, Grok) sit in the top bar.

Review lives in the status bar, not an external plugin. Changed files and the
full diff open in place, and line comments on the diff compose into one prompt
sent back to the agent pane.

Agent-to-agent work has structure when you want it. Beyond `aya pane list`,
`aya pane read`, and `aya pane send`, Aya's Teams (`aya team`) give roles a
saved contract (`Sends to`, `Must not`, cadence, delivery checks, and an inbox
when a pane is busy).

The window does not shift under your hands. An agent cannot rewrite Aya's
layout JSON or keybindings while you work.

## Where Aya is weaker

| | Herdr | Aya |
|---|---|---|
| Unit | Workspace / tab / pane (or kanban board layout) | Project = directory + live terminals + worktree groups |
| Status wire protocol | Open `OSC 7501` (`state=working\|blocked\|done\|error\|idle\|clear`) + screen rules | `OSC 9001` (`aya.status=...`), Claude/Codex hooks, and VT screen rules |
| Spawning one helper pane from CLI | `hc run --bg <agent> "<task>"` | `aya pane new preset [--name name] [--project slug]` + `aya pane send` / `aya pane wait` |
| Client surfaces | Native desktop (Rust), TUI (`herdr`), web/mobile (`Ovis`) | Electron desktop (macOS, Linux) + experimental Aya Web |
| Remote | Multi-machine SSH in one window + `herdr --remote` | Early SSH remote sessions (`aya remote --stdio`) |
| UI extensibility | Agent-editable `layouts/*.json`, `mods/`, `RECIPE.md` | Fixed layouts (Classic BSP / Projects-left) + JSON config hot-reload |

## What to take

1. **`OSC 7501` (Program Status Protocol) in the PTY stream.**
   Aya already strips and parses `OSC 9001` (`aya.status` and `aya.session`) in
   `electron/osc-extractor.ts` before bytes reach `xterm.js` and the VT mirror.
   Supporting `OSC 7501` (`\x1b]7501;<text>\x07`, level-prefixed `waiting : ...` /
   `done : ...` / `error : ...`, and empty `\x1b]7501;\x07` to clear) in the same
   extractor lets any tool or agent speaking the open protocol drive Aya's status
   dots, attention rail, and activity feed with zero configuration.

2. **In-band `clear` transitions (`done` unseen vs `idle` seen).**
   Aya already clears a terminal's status overlay when the user clicks the status
   dot (`clearedTerminalStatus` in `src/pty-event-reducer.ts`) or when `aya status
   clear` arrives on the control socket. Extending `osc-status` with
   `level: "clear"` (triggered by `OSC 7501` empty payload / `clear` and
   `OSC 9001` `aya.status=clear`) closes the loop in-band: an agent or build
   tool that returns to its prompt can drop its own overlay without spawning a
   CLI subprocess.

3. **Single-pane lifecycle from CLI (`aya pane new`, `aya pane wait`, `aya pane state`, `aya pane close`).**
   Herdr's `hc run --bg <agent> "<task>"` shows that an agent often wants one
   helper pane (a test runner, a second agent to review a diff) without
   authoring a multi-role team file. With `aya pane new preset [--name name]`,
   `aya pane send`, `aya pane wait`, `aya pane read`, and `aya pane close`, an
   agent can open a single background pane in its project, send it a task, wait
   for it to finish, read its output, and close it cleanly.

## What to leave

Agent-editable window chrome (`AGENTS.md` mutating `layouts/*.json` and `mods/`),
the kanban board window layout, the `RECIPE.md` mod marketplace, and a separate
TUI client. Aya is a desktop workspace with predictable chrome; agents work in
the repo and coordinate through panes and teams, not by editing the application
window.
