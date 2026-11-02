# Snow Leopard audit: implementation and verification

Scope: performance and correctness changes from `snow_leopard_audit.md`, without adding product features. No release is implied by this work.

## Terminal path (1.1–1.4)

- VT checkpoints retain a bounded operation journal and compact at 64 KiB, on tainted/overflow recovery, or on explicit export. Small writes no longer capture all scrollback. Strict export checks and split escape-sequence replay remain intact.
- Hot ownership checks reuse the handler-shape check until the registration epoch changes. Export still checks the full shape, provider identities, active handlers and markers.
- Engine hashing is deferred until first binding use. Reviewed default options and handler shape are data pinned to the supported engine, avoiding a temporary terminal during module import. Import validation still precedes allocating a restored terminal.
- Snapshot waiters are explained only when present. Status scans use existing rows and return their verdict instead of rebuilding and evaluating a second synthetic snapshot.
- Focus retries focus only; one pending PTY size bounce is shared, cancelled on resize/unmount, and does not overwrite a newer real resize.
- Plain-output guards avoid unnecessary SGR/focus/OSC processing; empty output deltas avoid joining scrollback; PTY coalescers count incremental bytes; screen-rule region text is cached per scan.

## Disk and processes (2.1–2.5)

- All native windows and the running Aya Web server subscribe to one config watcher. A manual edit is broadcast to every subscriber. Polling checks inode/size/mtime/ctime before reading content. Stopping one subscriber leaves others active.
- Atomic writes fingerprint only watched configuration, not large conversation assets or logs. Fingerprints are bounded.
- Project/config-state caches check metadata, return isolated copies and notice atomic external replacement. Deleted projects are evicted.
- Periodic user-rule scans inspect metadata asynchronously; stable candidates are not reopened, hashed or compiled. Explicit notifications and install-time stable reads retain fail-closed behavior. Missing rule directories are not repeatedly watched.
- The single-instance lock precedes runtime/watch/worker construction. Codex SQLite reads run in a worker with deadlines and idle teardown. Concurrent process-family lookups share the same `ps` request. Repeated session IDs do not broadcast again; new sinks receive cached IDs.
- Agent questions and team debug logs write asynchronously in order. Control status replies await durable question persistence; quit waits for queued writes. Debug-switch metadata remains synchronous to preserve the existing immediate `debug off` guarantee.
- Web login uses asynchronous scrypt with at most four concurrent checks and rejects credentials changed during a check. Rare configuration-generation APIs retain their existing synchronous interface.
- PTY cwd stat is asynchronous after claiming the spawn flight; early input and cancellation remain ordered. PTY logging creates its directory once.
- Working-tree fingerprints use bounded porcelain-v2 output, HEAD and batched changed-file metadata instead of an unbounded binary diff stream. An oversized candidate list returns unknown rather than falsely asserting no change.
- Usage scans stat 32 files at a time and retain at most 256 cached files / 200,000 cached events. An individual parser also retains at most 200,000 recent events and flags truncation. Codex discovery has a bounded one-second cache, and an empty/incomplete rollout is never cached permanently as missing its cwd.
- `/btw` waits on actual turn completion while busy, refreshes its source only when the turn epoch changes, and uses bounded backoff for the readiness race that has no notification.

## Renderer and persistence (3.1–3.5)

- Split dragging updates the visual tree immediately and debounces disk writes; a subsequent non-resize operation cancels the obsolete write. Unmount flushes the latest pending layout.
- Unchanged focus/view values keep state identity. Conversation layout effects have dependencies, completed Markdown messages are memoized, and streaming snapshots use trailing debounce with a five-second maximum interval.
- History requests carry the current view, so delaying autosave cannot hide the current conversation or draft from `/resume`.
- Syntax highlighting is cached by diff lines and loaded in a separate chunk. Settings, search, teams and Usage modals load on demand.
- PaneGrid and ConversationView are memoized; common App callbacks, review/resume lists and the status-rail element keep stable identities.
- Session persistence tracks each project's own signature; one session change no longer rewrites every project.

## Correctness and retained state (4.1–4.9)

- Team-log reads loop over short reads and decode only bytes actually read, preserving the next message ID.
- One-shot SSH uses the hardened shared runner, a process-group deadline and an enforced byte cap.
- Antigravity tolerates ESRCH when interrupting an already-ended process.
- Git state is released by directory/worktree path while retaining directories used by another open project.
- Explicit successful PTY kill releases recovery, snapshot, rule, input and session caches. Natural exit retains the tombstones/receipts needed to distinguish an ended session from a missing one during recovery; blindly removing these would break the existing recovery contract.
- Closing an artifact preview removes its owner's destroyed listener. Closed tabs release all spawn markers; activity entries expire; summary timers/metadata are cleaned up.
- WebGL loss retries are deferred with a bounded retry budget instead of recursive attachment during addon construction.
- Project-state read/merge/write and window release share one transaction queue.

## Shared code and idle work (5.1–5.3)

- Unit formatting and split-node validation are shared between main and renderer.
- Status pulse animates opacity instead of box-shadow. Terminal input reads a cached debug flag, refreshed on focus/storage changes.
- Font CSS includes WOFF2 only. Clean Electron compilation removes stale JS/declarations/build metadata before rebuilding; declarations/build metadata are excluded from packages.
- Ad-hoc atomic JSONL/quit writes use exclusive random temporary files and clean up failures.
- Visibility polling actually removes its interval while hidden and restores it on visibility. Usage/activity/summary timers use it. An empty machine list stops periodic probes, unchanged dock counts do not send IPC, inactive teams skip redelivery scans, and relaunch notes use a metadata cache.

## Audit corrections and rejected shortcuts

The audit is a set of hypotheses, not a specification to weaken existing guarantees:

- `shell-path.ts` already uses asynchronous `execFile`; there is no `hydrateProcessPath` implementation to replace in this revision.
- All multi-agent GUI stderr buffers already have a 4,000-character bound.
- `usage-codex.ts` already uses the shared bounded JSONL reader; usage history already prefilters accounting lines before JSON parsing.
- The split-layout view already memoizes normalization. The existing highlighter imports `lib/common`, not all 192 languages; it is now additionally loaded on demand.
- Browser/headless VT bindings are not identical: engines, base64/Buffer APIs, renderer options, cell compression and ownership differ. Their validated DTO remains common; combining these runtimes wholesale would remove reviewed boundaries.
- `local-summary-errors` exposes different UI and backend responsibilities; `update-spawn` exposes different renderer/backend error APIs. They are not identical copies. Likewise main split-tree intentionally does not implement renderer geometry/algebra; the genuinely common validator is now shared.
- Clearing the VT base at every ground boundary without retaining a replayable base cannot export the next partial CSI/OSC sequence. Bounded journaling preserves that state while removing per-chunk captures.
- Stopping session discovery permanently after the first ID would miss a CLI's `/new`. Polling remains, but expensive SQLite work is off the main thread and duplicate IPC is removed with attach-time replay.

## Evidence

Verification logs are local under `.gui-verification/`; Playwright output is under `test-results/` and `playwright-report/`.

- A deterministic regression proves 500 small PTY chunks trigger zero scrollback captures and can still export/import a split CSI continuation.
- A deterministic short-read regression preserves message 41 and appends message 42.
- Config watcher regressions cover both-window delivery, surviving subscriber teardown and zero content rereads during unchanged polling.
- 249 focused VT/search/debug/timer tests passed before the last config-cache addition.
- 24 Electron scenarios passed: conversation GUI, BSP split, pane focus, multiple windows, settings paths and WebGL loss.
- Build comparison against 0.15.4: App JS 437.39 → 327.37 kB; always-loaded vendor JS 321.85 → 167.48 kB. Syntax highlighting is a separate 154.31 kB chunk. These are chunk measurements, not a claim about total CPU, RAM or all initial assets.
- The new renderer build contains zero `.woff` files, while retaining `.woff2` assets.

Final checks:

- Typecheck, renderer hook lint, clean renderer/Electron builds and test-source compilation passed.
- After the final usage-log bound, 149 focused tests passed (usage history, config-cache isolation, SSH output/limits and session discovery).
- The final 24 Electron scenarios passed again, including conversation resume before a debounced save and window transfers.
- Disposable macOS arm64 package smoke passed native PTY I/O/resize/exit, nested ad-hoc signing, packaged screen rules and display codec.
- The packaged Electron runtime opened a real temporary SQLite fixture through the new worker loaded from `app.asar` and returned the expected session ID.
- Inspection of that ASAR found the VT baseline module and no Electron `.d.ts` or `.tsbuildinfo` files.
- `/btw` passed against the installed, authenticated Codex client.
- Full suite on the final sources: 8,551 tests, 8,401 passed, zero failed, 149 skipped and one existing TODO. The command exited successfully.

No CPU/RSS/battery percentage is inferred from these checks. Measurements above describe assets, allocations and avoided I/O, with functional regression coverage. No release or distribution notarization was performed for this audit; the package smoke uses disposable staging and ad-hoc signing.
