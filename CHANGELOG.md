# Changelog

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
