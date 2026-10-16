# PTY pane-cap proposal

## Design note (before implementation)

Set one product limit of **128 simultaneous PTY panes**. This covers Justyna's 56 currently open tabs with more than 2x room, while keeping measured per-process file-descriptor use below the Finder-launched app's configured soft limit. A 256-pane setting does not fit that budget without raising process limits: in the packaged app snapshot below it would require about 294 descriptors in Aya main and 268 in the owner, against a soft limit of 256. Raising the limit is outside this change.

### File descriptors and measured launch limits

On 2026-10-16, the Finder-launched packaged macOS arm64 app was Aya PID 84052 and its native owner PID 84054. `launchctl limit maxfiles` reported a soft limit of 256 and an unlimited hard limit for this login session. `lsof` counted 63 open descriptors in Aya main and 37 in the owner. It showed exactly 25 `/dev/ptmx` descriptors in each process: the host/main keeps its descriptor received from the owner for each pane, and the owner keeps its PTY master. Thus the measured non-pane baselines were 38 for main and 12 for the owner, or one additional descriptor per pane in each process.

At 128 panes, that observation projects to 166 descriptors in main and 140 in the owner, leaving 90 and 116 descriptors under the configured soft limit. At 256 it projects to 294 and 268, exceeding the soft limit by 38 and 12. These are measured descriptor counts plus linear per-pane projection; they are not an inspection of each process's kernel `RLIMIT_NOFILE` value. The macOS process-specific limit is not exposed to this unprivileged measurement; the numeric limit above is launchd's inherited setting. The JS host is in Aya main, not a separate child process, so its count is the main-process count.

### B3 checkpoint and renderer budgets

The shared aggregate limits remain 128 MiB for core checkpoint data and 96 MiB for renderer display data. At 128 eligible panes, the equal renderer allocation is at most 768 KiB per pane (before any smaller remaining-core allowance); capture keeps the newest lines and cuts oldest scrollback first, preserving the visible viewport where possible and reporting the cut. The core checkpoint has a 64 MiB per-pane ceiling and a 128 MiB aggregate ceiling. It does not divide the aggregate evenly: if a pane cannot fit in the bytes remaining when visited, that pane is marked ineligible and the existing consent flow applies. Enumeration is ended panes first, then live panes in core insertion order; it is not an oldest-history or least-recently-used selection.

The existing dense VT measurement recorded 15,743,555 bytes of complete core transport for 25 panes, about 629,742 bytes per pane. Linear scaling to 128 is about 76.9 MiB, within the core budget, but this is a single measured dense workload rather than a bound. The full-history renderer fixture recorded 46,534,171 bytes for 25 panes. At the 128-pane equal allocation of 768 KiB, that same per-pane history cannot fit: the capture algorithm cuts oldest history to the assigned budget while retaining current screen state. Based on the measured average, the assigned bytes are about 42% of the uncapped per-pane DTO; the exact number of lines retained depends on each pane's content and is reported by its `cutLines` result. The 64-pane and 128-pane real trials will record exact cut counts and retained history before this limit ships.

### B4 recovery bootstrap

The crash bootstrap remains capped at 1 MiB and has explicit pane and observed-exit counts. At 128 panes, its target is below 1 MiB; the 64-pane and 128-pane real trials will record exact serialized bytes and recovery time from restart request through restored inventory and applied-screen readiness. No recovery-time claim is made before those trials. The cap change does not enlarge per-pane request fields, the owner protocol frame, checkpoint byte limits, or the renderer budget.

### Moving an existing installation

The currently running owner was built with the B1 limit of 25. The owner binary hash is part of its compatibility identity, so a new app containing the 128-pane owner will treat that running binary as incompatible; it cannot change the old process's compiled pane array in place. If an old owner is still present after an ordinary quit or B3 handover, Aya will use the existing identity-bound confirmation to stop it before starting the new owner. Stopping that owner ends its PTY children. The planned production swap will perform that one owner stop, after which the new owner can serve up to 128 panes. No persistent or silent owner replacement is introduced.

When the owner reaches the limit, the pane will say: “Aya can run at most 128 terminals at once. Close a terminal you no longer need, then try again.” It will not show the underlying spawn error or exit code as though the command itself failed.

The 64-pane and 128-pane trials will measure spawn success, B3 handover, B4 crash recovery, main/owner RSS and descriptor counts. These are acceptance measurements, not claims inferred from the projections above.
