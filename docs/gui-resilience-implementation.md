# GUI resilience and large-session implementation — 2026-11-02

Implements [the seven-part plan](gui-resilience-plan.md).

## Goals

Setting a new Codex goal now explicitly sends `status: active`, instead of
inheriting a completed backend goal's status. Complete → active creates a new
“Goal set” history entry, including when the objective is repeated. Pause and
resume continue to operate on the current objective. Session regressions cover
Codex and the managed agents; the GUI test completes one goal and sets another.

## Agent transport

All four agent adapters use a shared protocol writer. It accepts one writable
operation at a time and waits for both completion and drain before advancing.
Limits are 16 MiB per frame, 32 MiB queued and 128 frames. Each queued frame has a
10-second transport deadline, including time waiting to be written. A stalled or
broken transport retires the connection so old commands cannot be delivered
after a timeout. A full queue or oversized message is rejected explicitly.
Response timeouts remain distinct from transport failures and warn that the
agent may still be working; no command is automatically retried.

## Renderer recovery

Main offers Reload or Close after a renderer crash/OOM/abnormal exit. Only one
recovery prompt is active per window; there is no automatic reload loop. GUI
agents remain in main during recovery, and terminal owners remain separate.
Reloading from the React error screen also preserves the GUI connection.

An acknowledged event sequence connects each saved view to a bounded recovery
journal: up to 2 MiB / 2048 unacknowledged events. Current goal, progress and
approval state are retained separately. Pending requests are limited to 128 and
4 MiB; excess is an explicit connection error, never a silently forgotten
approval. A new connection resets its sequence epoch. Text overflow is reported
in the recovered interface instead of pretending all output was retained.

Saved messages, drafts, action tails, artifacts and queued messages return with
the panel. Pending text is flushed before snapshots acknowledge it. Continuous
streaming or typing cannot postpone autosave beyond five seconds. Action output
is bounded to 100,000 characters per action and the latest 50 actions.

If an agent disconnects while the renderer is unavailable, the recovered UI
stays disconnected and offers Reconnect. It does not show a false Ready state or
silently start another process. The crash test verifies streamed output, an
approval across a second crash, and explicit reconnect after a third crash with
a dead backend, using process-start counts to detect accidental respawns.

## Deferred artifacts

The GUI initially loads persisted artifact identities, titles, types and
revisions. Selecting a version reads only its content, verifies the existing
checksum and metadata, and displays an explicit retryable error on corruption.
Saving metadata preserves its existing references; legacy inline snapshots
still migrate through the established storage path. A damaged unselected asset
does not prevent opening the rest of the conversation.

Preview, source, save, external preview and image menus resolve a requested
revision within the panel. Current versions without a revision-history array
still work. Image-menu lookup retains bounded scoped identities/fingerprints,
not another library of image payloads. Content search loads artifacts only on
an explicit query, one at a time, cancels obsolete searches and returns IDs.
Enter waits for deferred search results; title search remains immediate.

## History and modal interaction

Off-screen historical articles use `content-visibility: auto` with remembered
intrinsic sizes. The newest three articles render normally. Text stays in the
DOM, preserving Chromium find, cross-message selection and accessibility. This
reduces layout/paint work, not the number of React objects or DOM nodes; it is
not a claim that arbitrary histories use constant memory.

Settings and nested consent, worktree dialogs, new/missing project, project
import, Teams, Attention Center, Search, Usage and the conversation picker share
one focus policy. Only the topmost modal consumes Escape; Tab and programmatic
focus stay inside it, including while controls are disabled. Dismissal restores
its opener. Selection/launch actions deliberately yield to their destination.
Terminal activation and delayed fits respect restored chrome focus. The worktree
race tests simulate an external project selection because project shortcuts are
intentionally blocked while a modal is open.

## Repeatable GUI workload

Run `npm run benchmark:gui`. The command builds production/test sources, unsets
`CI`, enables headless Electron and runs the isolated workload:

- 2500 historical messages;
- 32 persisted widgets of 256 KiB each;
- four running shell terminals alongside the GUI;
- open conversation and selected-artifact timing, renderer heap and Electron
  process memory/CPU, and key-command → next-frame samples;
- correctness checks for off-screen rendering, Chromium find and selection.

Default output: `.gui-verification/gui-workload.json.log`; override with
`AYA_GUI_BENCHMARK_OUTPUT`. Input measurements include Playwright transport and
key dispatch overhead. Electron reports process memory in KiB; shared pages can
overlap and external PTY owner memory is not included. Hardware-dependent values
are recorded without a machine-specific speed threshold.

Verification logs: `.gui-verification/resilience-*.log` (local only).

## Final verification

- Renderer/main TypeScript checks, ESLint, production build and test-source
  build passed.
- Broad GUI suite: 49 passed. After the final React-boundary and image-identity
  changes, all 16 GUI/history/recovery regressions passed, including the new
  render-failure case (50 distinct GUI cases across these runs).
- `npm run benchmark:gui` passed end to end. The measurement CDP session is
  explicitly detached before teardown. Final local sample: opening 1916 ms,
  selected artifact 291 ms, key-command-to-frame median 25 ms / p95 48 ms; 2492
  of 2500 historical articles had their off-screen contents skipped. These are
  recorded workload measurements, not a whole-app speedup claim.
- The last full unit sweep ran 8589 tests: 8435 passed, 149 skipped, one existing
  TODO, four timing-fixture failures. Those failures depended on fixed short
  waits for polling, localhost HTTP or asynchronous updater cleanup. The
  fixtures now wait for completion; successful HTTP probes have a reasonable
  budget while the intentional timeout case retains its short deadline.
  Antigravity coverage also accepts its documented provisional initialization
  before checking the real initialization event. The final serial regression
  run covers all corrected fixtures and the agent/storage/transport/recovery
  changes: **161 passed, zero failed**. Production timeouts were not relaxed.
- The staged macOS arm64 package passed owner/runtime smoke checks and loads
  the new GUI transport, recovery, storage and shared search modules from ASAR.
  Signing was local/ad-hoc; no release or notarization was performed.
