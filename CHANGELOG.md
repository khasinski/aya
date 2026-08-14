# Changelog

## v0.7.10-beta - 2026-08-11

Aya learns what its panes are actually doing, and lets agents work with each
other instead of only reporting to you.

### Features

- **Panes split like a real tiling terminal.** Splitting now divides only the
  selected pane instead of inserting a whole row or column, so the rest of the
  layout keeps its size. Layouts can nest arbitrarily, each divider drags
  independently, and pane navigation follows what you see rather than grid
  arithmetic. Existing layouts are migrated automatically.
- **Create and remove git worktrees.** The worktree section can now add a
  worktree on a new branch and remove one (keeping the branch); git's own error
  text is shown when it refuses, and discarding uncommitted work always asks
  first. Previously Aya could only list worktrees.
- **Approval detection knows its agent.** Screen rules are now per-agent, with
  suppressors for screens that merely look like prompts — scrolling back
  through Claude's transcript no longer marks a pane as waiting.
- **Agents can read and drive each other's panes.** `aya pane read "reviewer"`
  returns another pane's recent output and `aya pane send "reviewer" "…"` types
  into it (`--submit` presses Enter), so one agent can hand work to another and
  collect the result. Panes are addressed by tab name within your project; an
  ambiguous name is rejected rather than guessed. Documented for agents in
  `skills/aya-control/SKILL.md`.
- **"Waiting" is now read off the real screen.** The pty host keeps a headless
  VT mirror of each pane, so an approval prompt is detected from what the pane
  actually shows — and, unlike the old byte-stream heuristic, the waiting state
  clears again once the agent repaints over it. An agent's own reported status
  still wins over both.
- **Status rail.** An always-visible strip lists every terminal that is waiting
  or failed across all open projects, so a blocked pane in a project you aren't
  looking at is visible without opening anything. Click to jump to it; collapse
  it to just the counts.
- **Nine more agent CLIs** ship as presets: Cursor Agent, GitHub Copilot, Grok,
  Droid, Devin, Kimi, Hermes, Qoder, and Antigravity.
- **Auto-resume for OpenCode, Kilo Code and Pi.** Restoring one of these tabs
  now continues its conversation (`--continue`) instead of starting over —
  previously only Claude and Codex resumed.
- **Session-precise resume.** An agent that reports its session id over OSC 9001
  gets that exact conversation resumed on restore, instead of whatever the CLI
  considers most recent. Resume is no longer hardcoded to Claude and Codex.
- **Terminal sounds are configurable.** Pick your own audio files for the
  waiting and finished chimes, and turn them off per preset.

### Fixes

- **The weakest signal can no longer overrule an agent's own status.** A regex
  over raw output could overwrite a status the agent reported for itself. It is
  now only allowed to raise the "waiting" bell — never to clear or downgrade
  what the agent said — so a genuinely blocked pane still alerts while a
  reported state stays authoritative.
- **A terminal's worktree binding no longer resets to the project directory.**
  The IPC validator rebuilt each saved tab field-by-field and silently dropped
  its `cwd`, so a tab running in a git worktree came back in the main checkout
  after a restart.
- **Closing tabs quickly no longer swallows a press.** Cmd+W resolved "the
  active tab" from the last render, so a second press that arrived before the
  first close had been applied targeted the tab it had just closed and did
  nothing — closing two tabs took three presses.
- **Typing into a pane while its agent is still starting no longer loses the
  keystrokes.** Input that arrived before the process was registered was
  discarded with no echo and no error; it is now held and delivered once the
  pane is live, the way a real terminal buffers type-ahead. Affected the CLIs
  that run a command-exists check first — Claude, Codex and the other agent
  presets — rather than plain shells.

## v0.7.9 - 2026-08-02

Aya 0.7.9 makes agent sessions survive restarts the way they always should
have: an in-session restart resumes the conversation, and a dead tab comes
back restartable instead of silently starting a fresh session. A new PTY
lifecycle log makes session-death bugs diagnosable after the fact.

### Fixes

- **Restarting an agent tab resumes its session.** Right-click Restart,
  Shift+Enter after an exit, and the recovery banner all respawn with the
  resume argument (`--continue` / `resume --last`), so the conversation
  continues instead of starting over. A deliberately fresh session is still
  one gesture away: close the tab and open a new one.
- **Dead tabs attach instead of silently respawning.** The attach flag was
  dropped at an IPC validation boundary, so every re-mount of a dead PTY
  quietly started a fresh process (the "console comes back empty" symptom).
  Re-mounts now attach and replay; a tab whose session died while the app
  was away comes up stopped and restartable, with resume on Shift+Enter.
- **Typed input no longer vanishes right after a terminal starts.** A
  connect-ordering inversion in the PTY client could deliver the first
  keystrokes before the spawn request, where the host dropped them.
- **Codex usage chip survives the new single-window rate_limits schema**,
  an out-of-range resets_at no longer kills the usage poll, and the popover
  no longer claims "weekly" for a 5h-only average.
- Right-click Restart on an already-exited tab respawns again (the pending-
  kill guard was swallowing it).

### Diagnostics

- **PTY lifecycle log**: the PTY host now writes a durable JSONL trail of
  spawn/kill/exit/host events (with exit codes) to `~/.aya/pty-events.log`,
  size-capped with rotation - built to pin down the periodic mass console
  reloads (#83).

### Security

- Dependency patches: brace-expansion (two high advisories), node-tar
  (moderate), postcss, fast-uri. `npm audit` reports 0 vulnerabilities.

## v0.7.8 - 2026-07-20

Aya 0.7.8 adds experimental browser access to your terminals, a history search
that survives TUI redraws, and a noticeably lighter renderer under heavy agent
output.

### Experimental

- **Aya Web: use Aya from a browser.** Aya can serve its UI over a local
  HTTP + WebSocket bridge, with user/password login, session cookies, and
  rate limiting. Terminals attach to the same live PTY sessions as the
  desktop window. Off by default, configured from Settings.
- **History mode in the find bar.** Claude Code and Codex keep full session
  transcripts on disk; with the new setting enabled, Cmd+F in an agent tab
  gains a Terminal | History toggle that searches those transcripts for the
  tab's project. Hits survive TUI redraws and app restarts. No indexing or
  background work involved.

### Performance

- PTY output is coalesced in the PTY host and across IPC hops, so busy agent
  output costs far fewer events end to end.
- TerminalView skips re-renders and no-op PTY updates it previously paid for
  on every chunk, and tab switches no longer rebuild derived collections.

### UI

- Project tabs in the top bar use two lines: project name over its path.

### Fixes

- Remote (SSH): adding a project that already exists on an older remote Aya
  no longer fails the connection.

## v0.7.7 - 2026-07-03

Aya 0.7.7 introduces multiple windows with Chrome-style project-tab tear-out.

### Multi-window

- **Drag a project tab out of the window** and release it on empty desktop to
  tear it out into a new window at the cursor - or release it over another Aya
  window to attach the project there. In-strip drags still reorder. Works in
  both layouts (top tabs and the experimental left rail).
- **Right-click a project tab** for "Move to New Window" / "Move to Window: …"
  as a no-drag alternative, and File > New Window (Cmd/Ctrl+Shift+N) opens an
  empty window.
- **Running terminals survive every move.** Terminals live in Aya's detached
  PTY host, so a moved project re-attaches to its live sessions - agents keep
  their context mid-conversation.
- **Chrome semantics throughout:** a window that loses its last project closes
  itself; closing a window sends its projects to Recent while their terminals
  keep running (reopen the project anywhere to re-attach); quitting and
  relaunching collapses back to a single window.
- Remote (SSH) projects can't be moved between windows yet.

### Fixes

- The terminal area no longer stays white after returning to a long-
  backgrounded window (WebGL context loss is now recovered).

## v0.7.6 - 2026-07-02

Aya 0.7.6 fixes a slow terminal-death bug ("posix_spawnp failed."), makes the
app dramatically lighter at idle and under agent load, and introduces
experimental git-worktree support.

### Fixes

- **Terminals no longer die with "posix_spawnp failed." after long uptime.**
  node-pty leaked one /dev/ptmx file descriptor on every terminal spawn on
  macOS; Aya's background PTY host lives for weeks, so the leak accumulated
  until every new terminal failed to start. Upgraded to a node-pty build with
  the leak fixed (verified: 0 leaked descriptors across spawn cycles). If you
  hit this on an older version: Settings > Diagnostics > PTY host > Restart.
- **A stuck PTY kill escalates to SIGKILL** so a trapped child can't survive as
  an orphan and double-spawn later.
- **Keyboard tab-switching works inside split panes**, and the New-terminal
  launcher menu stays on screen in the experimental layout.

### Performance

A full two-pass sweep over the renderer and the main process:

- PTY output is analyzed once per chunk (was: up to 9 regex passes), and each
  chunk now wakes only its own terminal pane instead of every mounted pane.
- The top bar, sidebar, status bar and the experimental layout skip re-renders
  entirely when nothing they show changed; poll results that are equal to the
  previous tick no longer re-render the app at all.
- The usage, session and presets polls re-read only files whose mtime changed
  (was: full ~/.codex/sessions tree walk + parsing up to 20 JSONL files every
  30s, plus re-parsing every session/preset file on every tick).
- Terminal search reuses a cached cleaned buffer per terminal (was: stripping
  ~1MB of ANSI per live terminal on every keystroke), launching a terminal no
  longer runs a redundant login-shell probe for a binary already seen, and the
  status-bar git poll runs one process per tick instead of four.

### Experimental

- **Git worktrees** (Settings > General > "Enable worktrees support"): Aya
  detects a project's worktrees, groups terminals by worktree in the sidebar
  (headers show the worktree name; main/stale tags), and clicking a header
  targets it - new terminals launch in that worktree and restore there after a
  restart.

### Dependencies

- Electron 42.5.2, Vite 8.1.3, Playwright 1.61.1, plus minor type/plugin bumps.

## v0.7.5 - 2026-06-30

Aya 0.7.5 hardens the terminal/agent lifecycle and fixes opening existing remote
projects.

### Fixes

- **Agent sessions resume instead of starting fresh.** A restored Claude/Codex
  tab now respawns with "continue latest session" (`--continue` / `resume
  --last`) instead of a bare picker, and the auto-resume default the Settings UI
  shows matches what the runtime actually applies - so a restored agent tab no
  longer silently loses its conversation. An explicit opt-out is preserved.
- **A re-mounted tab whose process died shows a stopped state.** When a tab
  re-mounts after its PTY exited (tab re-activation, warm-pool churn) Aya no
  longer silently starts a brand-new (contextless) process; it surfaces a
  stopped/restartable state (Shift+Enter to restart).
- **No more orphaned PTYs from a fast unmount+remount.** Concurrent spawns for
  the same terminal id are guarded so only one process starts.
- **Opening an existing remote project works.** Re-opening a remote project that
  already exists on the host no longer fails with "Project already exists"; the
  open is now idempotent (new projects are still created).

### Performance

- The terminal-output hot path and the idle-activity tick no longer re-render
  the whole window, and the git/session/usage polls pause while the window is
  hidden.

### Security

- Resolved the CodeQL findings: ids now use a cryptographically secure RNG, and
  the atomic-write temp path is no longer predictable.

## v0.7.4 - 2026-06-25

Aya 0.7.4 adds an alternative window layout, richer status-bar and terminal
links, and trims unused code.

### Features

- **Alternative window layout (experimental).** A new Settings option moves
  project tabs into a left rail and puts terminal tabs along the top. The two
  layouts are fully separate; the classic project-tabs-on-top layout stays the
  default.
- **GitHub link in the status bar.** Optionally show a link to the current
  branch's pull request next to the branch name, falling back to the branch
  page on GitHub when there is no PR. Requires the `gh` CLI and is off by
  default.
- **Jump to a file in the diff.** Clicking a file in the status-bar changed-files
  list now opens the diff scrolled to that file's section.
- **More terminal link targets.** Terminal hyperlinks now open editor/IDE URLs
  (`vscode`, `vscode-insiders`, `cursor`, `zed`, `jetbrains`) in addition to
  web and file links.
- **Filter recent projects.** The recent-projects menu can be filtered by name
  or path.
- **Usage chip account labels.** Usage chips can surface the account label
  alongside the harness name.

### Maintenance

- Removed unused code: the never-wired `harness-account` module (and its test),
  the dead `readUsage` helper, and the `bashArgv` alias.

## v0.7.1 - 2026-06-19

Aya 0.7.1 polishes the new multi-account preset workflow introduced in 0.7.0.

### Fixes

- **Agent account preset launch commands.** Claude/Codex config-directory
  prefixes now launch correctly through zsh, default account commands stay as
  plain `claude` / `codex`, and Codex restored tabs use `resume` instead of
  `--resume`.
- **Preset settings layout.** Multiple presets now use compact secondary tabs
  with a single selected editor, reducing the long stacked-form layout.

## v0.7.0 - 2026-06-19

Aya 0.7.0 focuses on making local agent launches match the user's real terminal
environment and on improving multi-agent project workflows.

### Features

- **Agent account presets.** Presets can now carry agent metadata, config
  directory choices, unsafe-mode toggles, and auto-resume behavior.
- **Warm project terminals.** Aya keeps recently active project terminals warm so
  switching between projects preserves responsive terminal state without mounting
  every tab in every project.
- **Updated website.** The docs homepage has been refreshed for the current
  product surface and release assets.

### Fixes

- **Preset launches now use the interactive login shell.** Aya starts PTYs via
  the user's login + interactive shell so commands installed from `.zshrc` /
  `.bashrc`, such as `grok`, are visible when opening a new terminal.
- **Preset validation preserves new fields.** User preset metadata such as
  `autoResume`, `configDir`, and `unsafeMode` survives normalization and IPC
  validation.

## v0.6.0 - 2026-06-17

Aya 0.6.0 focuses on desktop chrome polish and a smoother project-opening flow.

### Features

- **macOS fullscreen chrome.** Aya now keeps its project tab bar usable as the window header in macOS fullscreen, avoiding the wasted system titlebar space.
- **Linux custom window chrome.** Linux builds use Aya's own top bar as the draggable titlebar so project tabs occupy the space a native frame would otherwise take.
- **Snippets in the status bar.** The snippets control moved next to the activity/status area, keeping the primary project tab strip focused on navigation.
- **Remote stdio bridge groundwork.** Added the first bridge skeleton for future remote session work.

### Fixes

- **Git status checks no longer take optional repository locks.** Aya now runs status-style git commands with optional locks disabled so background checks do not leave `.git/index.lock` behind.
- **New-project modal no longer jumps while typing.** The "Folder will be created." hint was removed and directory checks are debounced for 500 ms.
- **macOS traffic light polish.** Custom traffic lights now use stable SVG hover icons instead of CSS pseudo-element shapes.
- **Project tab controls line up.** The new-tab plus icon and project close button align with the rest of the tab chrome and activity indicator.

### Compatibility

- macOS Apple Silicon builds are Developer ID signed and Apple-notarized.
- Linux x64 builds are available as AppImage and deb packages.
