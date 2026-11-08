# Waiting for pane state from scripts

`aya pane wait` lets a script pause until one or more existing panes reach a useful state. It uses Aya's applied terminal snapshots and exit events; it does not start a host or repeatedly poll terminal screens.

```sh
aya pane wait reviewer builder --until idle --timeout 120
aya pane wait pane:4dcd... --until waiting,exited --any
```

Targets are pane names or IDs, with `pane:<id>` available to make an ID explicit. `--project <slug>` scopes name and ID lookup the same way as `aya pane send`. Duplicate targets are counted once.

The default condition is `idle`, the default timeout is 30 seconds, and the maximum timeout is 24 hours. `idle,waiting` means a target may satisfy either condition. Without `--any`, all targets must reach one of the requested conditions; with `--any`, the command returns when the first does. An unreadable or unknown screen does not count as idle or waiting. A pane counts as exited only after Aya observes an explicit process-exit event; a pane that never started, or whose start failed, does not count as exited.

Exit status is 0 when the requested condition is met, 1 on timeout (the output names the targets still waiting), and 2 for a missing or ambiguous target. Ctrl+C cancels the wait cleanly. This is a CLI-only feature; the Aya app UI does not change.

## Send a prompt and wait for the answer

```sh
aya pane send reviewer --wait "review the diff"            # waits up to 300 seconds
aya pane send reviewer --wait --timeout 900 "run the suite"
aya pane read reviewer                                     # then collect the result
```

`--wait` types the text and presses Enter, then waits for the pane to start working and to settle: idle, waiting for input (an approval or a question), or exited. A pane that is still idle right after the send is not taken for finished. If no work is seen starting within 10 seconds, the command still returns, with a note that the answer may have come back instantly or the prompt was ignored. Exit status is 0 once the pane settled (the output says how) and 1 on timeout. `--timeout` is in seconds (1 to 86400) and needs `--wait`. Use `--` before text that is itself `--wait`.
