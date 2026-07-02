# Changelog

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
