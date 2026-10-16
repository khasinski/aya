# PTY pane-cap design and measurements

## Design note (before implementation)

Set one product limit of **128 simultaneous PTY panes**. This covers Justyna's 56 currently open tabs with more than 2x room, while keeping measured per-process file-descriptor use below the Finder-launched app's configured soft limit. A 256-pane setting does not fit that budget without raising process limits: in the packaged app snapshot below it would require about 294 descriptors in Aya main and 268 in the owner, against a soft limit of 256. Raising the limit is outside this change.

### File descriptors and measured launch limits

On 2026-10-16, the Finder-launched packaged macOS arm64 app was Aya PID 84052 and its native owner PID 84054. `launchctl limit maxfiles` reported a soft limit of 256 and an unlimited hard limit for this login session. `lsof` counted 63 open descriptors in Aya main and 37 in the owner. It showed exactly 25 `/dev/ptmx` descriptors in each process: the host/main keeps its descriptor received from the owner for each pane, and the owner keeps its PTY master. Thus the measured non-pane baselines were 38 for main and 12 for the owner, or one additional descriptor per pane in each process.

At 128 panes, that observation projects to 166 descriptors in main and 140 in the owner, leaving 90 and 116 descriptors under the configured soft limit. At 256 it projects to 294 and 268, exceeding the soft limit by 38 and 12. These are measured descriptor counts plus linear per-pane projection; they are not an inspection of each process's kernel `RLIMIT_NOFILE` value. The macOS process-specific limit is not exposed to this unprivileged measurement; the numeric limit above is launchd's inherited setting. The JS host is in Aya main, not a separate child process, so its count is the main-process count.

### B3 checkpoint and renderer budgets

The shared aggregate limits remain 128 MiB for core checkpoint data and 96 MiB for renderer display data. At 128 eligible panes, the equal renderer allocation is at most 768 KiB per pane (before any smaller remaining-core allowance); capture keeps the newest lines and cuts oldest scrollback first, preserving the visible viewport where possible and reporting the cut. The core checkpoint has a 64 MiB per-pane ceiling and a 128 MiB aggregate ceiling. It does not divide the aggregate evenly: if a pane cannot fit in the bytes remaining when visited, that pane is marked ineligible and the existing consent flow applies. Enumeration is ended panes first, then live panes in core insertion order; it is not an oldest-history or least-recently-used selection.

The existing dense VT measurement recorded 15,743,555 bytes of complete core transport for 25 panes, about 629,742 bytes per pane. Linear scaling to 128 is about 76.9 MiB, within the core budget, but this is a single measured dense workload rather than a bound. The full-history renderer fixture recorded 46,534,171 bytes for 25 panes. At the 128-pane equal allocation of 768 KiB, that same per-pane history cannot fit: the capture algorithm cuts oldest history to the assigned budget while retaining current screen state. Based on the measured average, the assigned bytes are about 42% of the uncapped per-pane DTO; the exact number of lines retained depends on each pane's content and is reported by its `cutLines` result. The real owner trial had no renderer display capture (`displayRawBytes: 0`), so it verifies live/core budgets rather than renderer capture or paint. The 128-pane renderer allocation remains at most 768 KiB per pane, and each captured display retains newest lines, cuts oldest first, preserves the visible viewport where possible, and reports the number cut. The measured fixture averages 1,861,367 bytes per pane, so the assigned budget holds about 42% of that uncapped DTO; the exact retained line count depends on each pane's content and screen state.

### B4 recovery bootstrap

The crash bootstrap remains capped at 1 MiB and has explicit pane and observed-exit counts. The real 64-pane bootstrap was 42,956 bytes; the 128-pane bootstrap was 86,223 bytes. At 128, the successor was SIGKILLed, the same owner and all 128 child identities were recovered, and each pane completed an I/O round-trip and exited with code 23. B4 took 493 ms through recovery, applied replay fences, round-trips, and child exits; the attach-and-round-trip portion took 245 ms. At 64 panes those timings were 344 ms and 106 ms. This is a one-trial local result, not a latency guarantee. The cap change does not enlarge per-pane request fields, the owner protocol frame, checkpoint byte limits, or the renderer budget.

### Moving an existing installation

The currently running owner was built with the B1 limit of 25. The owner binary hash is part of its compatibility identity, so a new app containing the 128-pane owner will treat that running binary as incompatible; it cannot change the old process's compiled pane array in place. If an old owner is still present after an ordinary quit or B3 handover, Aya will use the existing identity-bound confirmation to stop it before starting the new owner. Stopping that owner ends its PTY children. The planned production swap will perform that one owner stop, after which the new owner can serve up to 128 panes. No persistent or silent owner replacement is introduced.

When the owner reaches the limit, the pane says: “Aya can run at most 128 terminals at once. Close a terminal you no longer need, then restart this tab.” It does not show the underlying spawn error or exit code as though the command itself failed. The real 128-pane N+1 request returned `pane-limit-reached`, showed this text, and emitted no synthetic exit 127.

### Real 64- and 128-pane trial

On 2026-10-16, a local macOS arm64 Node 26.10 trial used a fresh native owner and real PTYs, spawned all panes, performed B3 checkpoint/detach/restore, then SIGKILLed the successor JS host and performed B4 recovery. Both sizes preserved every owner/child PID across B3 and B4. At 64, all panes spawned and completed recovery. At 128, the N+1 request was refused as described above.

| Panes | Spawn | B3 detach/handover | Core checkpoint raw / encoded | B3 restore | Bootstrap | B4 through exits | B4 attach + I/O round-trip | JS host RSS at spawn / after B3 restore / after B4 recovery | Owner RSS | JS host / owner open FDs |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 64 | 418 ms | 1,976 ms | 2,362,134 / 142,532 B | 297 ms | 42,956 B | 344 ms | 106 ms | 89.0 / 147.5 / 107.1 MiB | 2.1 MiB | 179 / 75 |
| 128 | 861 ms | 3,280 ms | 4,724,881 / 285,409 B | 608 ms | 86,223 B | 493 ms | 245 ms | 117.7 / 184.0 / 154.3 MiB | 2.4 MiB | 243 / 139 |

At 128, the checkpoint was 4.5 MiB raw, all 128 panes were eligible, and the bootstrap was about 84 KiB. RSS covers only the JS host and native owner, not the child shells. The JS host descriptor count increased by exactly one per pane between the 64- and 128-pane samples; the owner also increased by one per pane. The stand-alone Node test host had a larger non-pane FD baseline than the Finder-launched Aya snapshot, so its 243 descriptors at 128 are reported separately rather than substituted for the packaged-app projection. It remained below the configured soft limit of 256, with 13 descriptors of headroom. The owner used 139 descriptors at 128, consistent with the measured 12-descriptor baseline plus one per pane.

The Finder-launched packaged app observation at 25 panes remains the app-specific basis: 63 descriptors in Aya main and 37 in the owner, or 38 and 12 non-pane descriptors. That projects to 166 and 140 at 128, leaving 90 and 116 descriptors under launchd's configured soft limit of 256. The hard limit was unlimited. The descriptor counts and inherited launchd setting were measured; process-specific kernel `RLIMIT_NOFILE` values were not directly inspected.

The trial was one local run and is not a cross-platform guarantee. It used real owner PTYs and JS core, but no Electron renderer, display capture, or paint. The raw report is written to ignored `test-results/pty-pane-cap-darwin-arm64.json`; regenerate after the Electron and owner builds with `node scripts/measure-pty-pane-cap.mjs`.
