# Usage dashboard

Open **Usage** from the status bar. Cmd/Ctrl+U also opens it when focus is outside a terminal or text input. Escape returns to the workspace without closing its running sessions.

**Tokens** reads local Codex, Claude Code and Grok session logs. Choose 24 hours, 7, 30 or 90 days; filter by provider, configured history/account directory and model. Hover or keyboard-focus a chart bar to inspect its counts. Click a model in the breakdown to filter it.

Input means uncached input. Cache read and cache creation are counted separately; reasoning is part of output, never added a second time. Codex cumulative counters are converted into deltas; repeated snapshots, copied Codex fork prefixes, streamed Claude records and shared history directories are deduplicated. Missing records do not count as proof of zero account usage. Remote-machine and Antigravity token history are not included in this version.

The scanner returns only token accounting, model names, configured account labels and time buckets. It never returns prompts, tool output or credentials. Parsing is asynchronous and mtime-cached, bounded to 6,000 files and 512 MiB of newly read logs per scan. Partial scans are labeled. Refresh rescans changed files and bypasses the brief dashboard response cache.

**Limits** reuses Aya's existing provider snapshots for Claude Code, Codex, Antigravity and Grok. It shows reported windows, reset times, and the age of each reading. Opening Limits or selecting Refresh rechecks the existing sources; Aya does not derive subscription percentages from token counts. Claude limits still require the optional usage hook. API-key accounts and providers without a snapshot show unknown limits rather than a fabricated allowance.

All history comes from the local machine and directories configured in presets. These counts may differ from subscription billing or usage on other devices. Estimated monetary costs are deliberately outside this view.
