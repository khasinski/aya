# GUI history and long-session follow-up

1. Keep the tool-activity heading outside a viewport-bounded, keyboard-accessible
   scrolling list; verify scrolling and collapse in a small GUI window.
2. Coalesce pending conversation saves: finish the active atomic write, then
   write only the latest waiting snapshot. Waiters resolve after their state or
   its replacement is durable; final close must still wait for the latest save.
3. Read stored JSON with byte limits enforced during I/O, not after allocation.
   Cache the history metadata index, refresh changed entries with bounded
   concurrency, and search/page before returning results to the renderer.
4. Reclaim only old, unreferenced artifact assets. Coordinate collection with
   writers, include all panel and archived snapshots, and abort on unreadable or
   invalid snapshots. Preserve all referenced revisions indefinitely.
5. Batch text deltas once per animation frame. Flush before lifecycle/final
   messages and teardown so no final text or persisted draft is lost. Keep
   memoized historical message rows and measure a repeatable long-history case.
6. Run focused regressions, typecheck/lint, production/test builds, full unit
   tests and headless GUI e2e. Commit only this task's changes; preserve the
   pre-existing working-tree edits.
