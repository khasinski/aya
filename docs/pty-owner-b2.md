# Owner-backed panes - B2

I implement the [accepted B2 plan](pty-host-handoff.md#b2---spawn-and-reap-new-panes-through-the-owner). I replaced the JS host's node-pty spawning with an owner-backed IPty adapter. Main still prepares command, argv, environment, cwd and resume selection and evaluates agent screen rules. The JS host still owns VT, replay/search, OSC parsing and the existing preparation flight. The native owner forks, owns the master, resizes, signals process groups and reaps children. No rules, sessions or VT implementation moved into native code.

This branch depends on #224's slim host/content identity, B1's owner/bridge/packaging, and the restart-question fixes. It does not implement planned handoff/checkpointing (B3) or automatic crash recovery (B4).

## Ownership and failure behavior

The private `AYA_HOME/pty-owner/record.json` records the owner's PID/start identity, executable/content hash, random process instance, current JS reader identity and bounded pane inventory. It contains no authentication key, command, environment or descriptors. Main retains a random key in memory and passes it to the JS host through an inherited private descriptor; the JS host starts the owner with another inherited pipe. The native socket lease and file lock exclude duplicate owners/readers. A liveness read failure refuses takeover.

The IPty adapter consumes a CLOEXEC master duplicate as a paused TTY stream, installs the core sink before resuming reads and decodes split UTF-8. Input and resize operations share one ordered queue. Write acknowledgement follows actual PTY acceptance, including partial writes; a failed write reports that some bytes may have arrived and is never automatically retried. Kill interrupts blocked input and targets the recorded native generation. New spawns for a retiring pane ID wait for its previous exit acknowledgement.

Real exit status comes from the native parent's waitpid, independently of the TTY read stream. The adapter drains output before emitting exit and acknowledging the native record, with node-pty's existing 200 ms post-exit ceiling. Native cleanup kills same-group descendants before releasing the leader's PID/PGID. An explicit destructive shutdown waits for the owner to exit and removes only its matching registry instance. Empty owners retire after pending spawns and exits settle; a lost spawn acknowledgement retains uncertain inventory and blocks retries instead of assuming no child exists.

The native receive bridge separates the idle first-byte deadline from the bounded remainder-of-frame deadline. A frame starting just before an idle poll expires therefore cannot be misclassified as an idle timeout midway through its header. Idle receive timeouts leave the connection usable. Malformed error frames reject outstanding requests before closing the connection; they cannot remove a request's timer and leave its promise unresolved. JS idle shutdown is disabled while an owner is incompatible or has disconnected inventory, including an uncertain spawn with no known PID. The absence of an acknowledged pane record does not authorize killing its native process.

An old, pre-owner host follows #219's question-and-restart before migration. Its children are never reparented. A live incompatible owner also requires confirmation before its processes stop. Cancel leaves the original processes and inventory intact. The host content identity includes the actual owner and bridge bytes as well as the existing JS/runtime dependencies; version-only updates continue to reuse the host. B2 still uses a confirmed destructive restart for changed JS-host core or runtime; preserving those panes during an update belongs to B3.

If the JS host dies, surviving panes remain visibly disconnected, with their owner inventory retained. They are neither marked stopped nor silently respawned. A replacement JS host can inventory a compatible owner using the retained in-memory key, but B2 deliberately does not adopt masters or reconstruct a screen. Without a compatible authenticated owner, pane kill refuses and explicit terminal-host recovery must ask about all work that will stop. A refused Restart terminal, Close terminal or Close project shows a window alert naming the affected panes and reasons and keeps their visible records. Restart refuses before requesting another spawn. Input, paste and snippets are disabled while disconnected; the terminal explains that input is disabled. Hold remains unknown until a real applied screen exists; busy retains its existing fail-open behavior. Input with an uncertain outcome is not replayed.

An owner death also preserves its inventory, even after the last JS reader exits. It cannot silently turn into an empty replacement owner. Diagnostics recovery lists pane names/PIDs and asks first; Cancel keeps the inventory and blocks spawn. After confirmation, the bridge verifies the recorded PID plus kernel start time and signals a group only through its still-matching recorded session leader. A mismatched or unreadable identity is never signalled. Entries that cannot be confirmed stopped remain visible with reasons in Diagnostics and block replacement. The recovery uses the existing owner parent for normal shutdown and a checked signal for proven orphan groups; it adds no automatic native crash-reaper or reparenting.

The owner has no output ring: unread bytes remain in the kernel queue, and a child eventually blocks if no JS reader drains them. Already-read screen/history can be lost after a crash. An unexpected native-owner crash may close the last master and HUP children before a question is possible; Cancel cannot restore already-lost work. The #204 uncaught-error guard remains on the JS host, and the watched replaceCells crash is unchanged.

## Validation and measurement

The adapter/core contracts exercise ordered I/O and resize, UTF-8/output-before-exit, actual exit status/signal, duplicate spawn/readers, uncertain spawn acknowledgement retention and generation-safe retirement. Existing preparation tests retain cancellation, timeout, disconnect and queued-write coverage. The pinned JS import graph and native include-boundary test prevent rules/sessions/VT from entering the native core. Migration e2e uses real child processes and verifies both Cancel and confirmed recovery for legacy and incompatible owners.

After the B2 review fixes, full `npm test` passed with 6,798 pass, 0 fail, 147 skipped and the existing registry TODO. Recovery contracts include a real HUP-ignoring child after owner SIGKILL, Cancel, blocked duplicate spawn, a deliberately mismatched kernel start identity, and confirmed cleanup followed by a new generation. A real host death between native spawn and its first JS response must emit disconnected rather than stopped. Electron regressions exercise real incompatible-owner restart/close-pane/close-project refusals, disabled disconnected input/paste, explicit legacy migration consent and confirmed dead-owner recovery. The 25-adapter resource regression verifies both native master and JS reader FD counts return to their baselines after kill; acknowledged native generation records may remain without open masters. The final whole e2e result is still pending.

The comparison runner uses the same Electron runtime and the same offline workload against built #224 and B2 checkouts:

```sh
node scripts/measure-pty-backends.cjs /path/to/built-224-checkout
```

Each backend runs 25 idle panes and 25 active panes separately in disposable homes. An active child writes 4 KiB plus a monotonic timestamp every 20 ms; the sample includes rolling-buffer warmup. Input latency is 100 command/reply round trips, including the child and PTY, rather than a write-call duration. Output latency runs from the child's monotonic timestamp to the main client's data callback. Three RSS samples cover the JS host, the native owner when present, and a headless main-side client. Child RSS, renderer memory and kernel PTY buffers are excluded. Raw observations remain in ignored `test-results/pty-backend-comparison.json`; local samples are not production bounds.

Measured at initial B2 commit `da91782e` on 2026-10-15, macOS 26.6 arm64, Electron 43.5 / Node 24.19. The #224 baseline is `7517f8b5`; B2 uses main `f8eab3d0` with the adapter. These are separate sequential trials after the e2e processes exited, using the same executable/workload; small differences do not establish a performance improvement.

| Backend / 25 panes | JS host RSS (KiB), three samples | Native owner RSS (KiB) | Headless main client RSS (KiB) | All panes ready (ms) |
| --- | --- | --- | --- | --- |
| #224 idle | 85,344 | 0 | 74,496 | 634.5 |
| B2 idle | 84,832 | 2,256 | 74,400-74,432 | 545.0 |
| #224 active | 176,320-178,432 | 0 | 92,944-93,184 | 907.0 |
| B2 active | 173,696-175,856 | 2,240 | 93,616-93,872 | 760.2 |

| Backend / 25 panes | Input RTT p50 / p95 (ms), 100 replies | Output p50 / p95 (ms) | Timestamped output samples |
| --- | --- | --- | --- |
| #224 idle | 0.285 / 1.070 | No periodic output | 0 |
| B2 idle | 0.255 / 0.941 | No periodic output | 0 |
| #224 active | 0.243 / 0.847 | 0.223 / 6.643 | 8,945 |
| B2 active | 0.259 / 0.757 | 0.249 / 5.461 | 8,466 |

The offline Ubuntu 24.04/GCC fortified x64 probe passed 32/32 owner, receipt, adapter, native-boundary, idle-frame, malformed-error, uncertain-idle, dead-owner recovery and first-spawn-loss contracts. Linux x64 runs here use emulation on this arm64 Mac. A separate Debian x64 offline build supplied the staged Linux artifacts; its packaged Electron ran the actual JS host and adapter, with the native parent verified and the real exit 23 delivered. The staged macOS arm64 package passed the same adapter path, plus B1's shell 23 / JS child 24 smoke, nested ad-hoc hardened-runtime signing and `codesign --verify --deep --strict`. These package checks use Electron-as-Node and pty-host.js; installer execution, Aya's packaged GUI, Developer ID signing and notarization remain untested.
