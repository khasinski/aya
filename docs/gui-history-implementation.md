# GUI history and long-session improvements — 2026-11-02

Implemented the steps in [the plan](gui-history-plan.md).

## Behaviour

- Expanded tool activity has a separate, keyboard-focusable scroll region capped
  at `min(50dvh, 420px)`. Its collapse heading stays outside that region. Long
  command output scrolls with the list instead of stretching the conversation.
- The renderer sends at most one autosave IPC at a time and follows it with the
  newest requested state. The storage writer likewise retains only the active
  and latest pending snapshot; replaced callers settle after the replacement
  finishes. Atomic snapshot publication follows all referenced asset writes.
- History search runs over all saved metadata before pagination. The picker
  requests 100 rows at a time and offers Load more. Late replies cannot reopen
  a dismissed picker or replace a newer search. Native Codex results are merged
  before slicing; native discovery retains the existing 100-thread limit.
- The metadata index is in memory, rebuilt on the first listing or changed
  directory metadata. Changed files are checked at concurrency eight; unchanged
  listings need no metadata-file opens. Parsed file cache: 4096 entries; full
  index retained only up to 10,000 rows. Larger libraries remain searchable but
  do not retain the complete index between requests.
- Snapshot and artifact reads enforce a 32 MiB limit before allocation and
  during reading, including files that grow. Metadata has a 4096-byte limit.
  Artifact hydration/storage is limited to four concurrent operations. Asset
  checksums and account/workspace boundaries remain enforced.
- Cleanup checks references from every panel and archived snapshot, including
  retained artifact revisions. Only unreferenced assets at least seven days old
  can be removed. A malformed, unreadable or future-version snapshot aborts the
  collection. It waits for active readers/writers and blocks new storage access
  until complete. Cleanup is scheduled after saving, initially after one minute
  and subsequently at most once per day of continued saving. Referenced
  artifacts have no automatic expiry.
- Assistant text deltas are combined once per animation frame, with a 100 ms
  fallback for hidden windows. Lifecycle events, page hide and teardown flush
  pending text. Final snapshots capture text even before React commits a frame.

## Measurement

`node scripts/benchmark-conversation-deltas.mjs` (after `npm run build:test-src`)
uses 10,000 historical messages, 4096 incoming chunks and groups of 16. The
reducer benchmark changes from 8192 history traversals to 256. Three local
samples measured 226–414 ms before and 21–29 ms after. This measures data-update
work, not DOM rendering, total application CPU, resident memory or battery use.

## Regression coverage

- A 100-save burst writes the active and final snapshots only; failures do not
  discard a newer queued save.
- History searches beyond the first 100 entries, pages without duplicates and
  refreshes after an archive update. Unchanged listings perform no file opens.
- Oversized files are rejected before reading; growth during a read is bounded.
- Cleanup preserves referenced archived revisions and young orphans, aborts on
  invalid snapshots, and waits for both active writes and old-version readers.
- Frame batching preserves exact text and historical object identities.
- GUI coverage opens 40 actions with large command output in a resized window,
  scrolls with the keyboard, collapses from the visible heading, verifies all
  1000 streamed chunks survive reload, and searches/pages older history.
- The existing multi-window config-watcher test now waits for initialization
  before making its first edit; its previous race could treat that edit as the
  initial baseline instead of a change.

Verification logs are under `.gui-verification/history-*.log` (local only).
The prepared commit is also typechecked separately from pre-existing edits.

Final verification: renderer and main TypeScript checks, ESLint, production and
test-source builds passed. Full unit suite: 8574 tests, 8424 passed, zero failed,
149 skipped and one existing TODO. All 13 selected GUI end-to-end tests passed
locally with `CI` unset and `AYA_E2E_HEADLESS=1`. The staged macOS arm64 package
passed native owner/runtime smoke checks with ad-hoc signing; no release or
notarization was performed.
