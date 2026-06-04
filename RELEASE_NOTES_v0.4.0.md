## v0.4.0

### Features
- **Usage chips** - show account-wide Claude usage from a local hook-written
  file, plus Codex usage read from local rollout logs.
- **Usage hook installer** - one-click install/uninstall in Settings; tokens
  stay outside Aya.
- **Config hot reload** - snippets, presets, and themes update when edited
  externally.

### Fixes
- Usage chip buttons no longer steal terminal focus.
- Usage chip colors now match the active provider brand.
- CI E2E dependency setup is more resilient to transient apt mirror issues.

### Internal / quality
- Added filesystem and unit coverage for usage parsing, hook install/uninstall,
  and config watcher behavior.
- Extracted usage-chip magic numbers into named constants.
- Simplified config-watcher comments.
