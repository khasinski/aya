## v0.5.0

The 0.5.0 stable release. Workflow polish across the top bar and usage
chips, a few security/robustness fixes, two new light terminal themes,
better Linux desktop integration, plus an early design spec for
cross-machine remote sessions.

### Features

- **Multi-account usage chips.** Both the Claude and Codex usage chips now
  support more than one account per agent. The number in the top bar is the
  average weekly percent used across detected accounts; the popover breaks
  each account out by id and label with its own 5h + weekly windows. New
  Settings toggle picks between a named pill (showing "Claude" + percent) and
  a compact progress ring.
- **macOS fullscreen.** The custom top bar (project tabs + brand + right-side
  controls) now collapses entirely in fullscreen so terminals get the full
  window height. Three tiny floating traffic lights in the top-left keep
  close / minimize / exit-fullscreen reachable without revealing the system
  bar.
- **Two new light terminal themes.** Solarized Light (canonical Ethan
  Schoonover mapping) and GitHub Light (the Primer palette github.com uses)
  ship as defaults alongside the existing dark themes.
- **Constant Settings height.** The Settings window no longer jumps in size
  when switching tabs; tall tabs scroll inside instead.
- **`aya` CLI shim survives Aya.app moves and renames.** Reinstall a shim
  once and the helper keeps working after you drag Aya around in /Applications.
- **PTY size re-assert on visibility.** Rich TUIs (claude, codex, grok) now
  get a SIGWINCH nudge when their pane becomes active or visible so they
  redraw their fullscreen layout instead of stuck on a stale frame.
- **Linux desktop integration.** The packaged app sets `desktopName` so Linux
  window managers link the running window to its `.desktop` entry (correct
  icon and app name in the dock/taskbar).
- **Create missing project directories from the open modal.** Pointing Aya at
  a path that doesn't exist yet now offers to create the directory instead of
  failing.
- **Rename terminal from the sidebar.** A "Rename terminal" entry in the
  sidebar context menu lets you label panes directly.

### Fixes

- **shell-quote CVE-2024** (`> 1.8.3`) pinned to ^1.8.4 via npm overrides.
  Transitive only — concurrently dev-dep, not shipped to users.
- **Tab close button.** Pinned to the tab's right edge with a hover gradient
  fade, so long titles or many narrow tabs can never push it outside the
  click area.
- **Project-tab green underline.** No longer covered by the hover gradient, so
  the active-project indicator stays visible on hover.
- **Restart-IPC JSON.parse guard.** A malformed control message no longer
  crashes the renderer; the restart IPC also reports the actual rejection
  reason instead of a misleading "ok".
- **Stale PTY host detection.** After an app update the new launcher detects
  a lingering pre-update host process and restarts it cleanly instead of
  talking to a host that disagrees about its own version.
- **Login-shell PATH recovery.** GUI-launched Aya now resolves the user's
  login-shell PATH, so `claude`, `codex`, and friends are found even when
  macOS launches the app with a minimal environment.
- **YOLO preset duplicates.** The YOLO preset buttons hide when the command
  already exists, so you can't create a duplicate preset id.

### Internal / quality

- **+30 unit and integration tests** across high-risk modules that were
  previously untested: `git.ts` (porcelain + diff against tmp repos),
  `control-server.ts` (framing, 64 KB limit, malformed-JSON tolerance,
  one-shot per connection), `pty-host` end-to-end through `PtyHostClient`
  on a real child process + socket.
- **Magic-values audit.** Shared constants (brand colors, timeouts, socket
  modes) consolidated to one source of truth across the renderer + main.
- **Hot-reload of `projects/*.json`.** Editing a project's JSON externally
  picks up the new state without killing any of its terminals.
- **Harness account resolver.** New self-contained module that parses
  preset commands (or one shell-level wrapper) to find which account a
  `claude2`/`codex2` shim ultimately launches. Scaffolding for the next
  multi-account pass; not yet wired.
- **Remote sessions design spec.** `docs/remote-sessions.md` lays out the
  protocol shape, SSH-bridge connection model, security requirements, and
  phased roadmap for sharing local Aya projects across machines.

### Compatibility notes

- macOS Sonoma 14+ (Apple Silicon). The DMG and zip are Developer ID signed
  and Apple-notarized; the inner `.app` is fully stapled.
- Linux x64 builds (AppImage + deb) are unsigned local packages. AppImage
  needs FUSE on older Ubuntu; install the deb if it complains.
- Existing `~/.aya/` configs migrate transparently. No data-format changes
  this release; the new multi-account `usage.json` shape is additive — the
  original single-account shape still works.
