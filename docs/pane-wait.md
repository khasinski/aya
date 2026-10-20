# Waiting for pane state from scripts

`aya pane wait` lets a script pause until one or more existing panes reach a useful state. It uses Aya's applied terminal snapshots and exit events; it does not start a host or repeatedly poll terminal screens.

```sh
aya pane wait reviewer builder --until idle --timeout 120
aya pane wait pane:4dcd... --until waiting,exited --any
```

Targets are pane names or IDs, with `pane:<id>` available to make an ID explicit. `--project <slug>` scopes name and ID lookup the same way as `aya pane send`. Duplicate targets are counted once.

The default condition is `idle`, the default timeout is 30 seconds, and the maximum timeout is 24 hours. `idle,waiting` means a target may satisfy either condition. Without `--any`, all targets must reach one of the requested conditions; with `--any`, the command returns when the first does. An unreadable or unknown screen does not count as idle or waiting. A pane counts as exited only after Aya observes an explicit process-exit event; a pane that never started, or whose start failed, does not count as exited.

Exit status is 0 when the requested condition is met, 1 on timeout (the output names the targets still waiting), and 2 for a missing or ambiguous target. Ctrl+C cancels the wait cleanly. This is a CLI-only feature; the Aya app UI does not change.
