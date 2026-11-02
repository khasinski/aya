# Snow Leopard follow-up — 2026-11-02

Further code review after `0c990dba` found five additional issues. These changes
bound background work and preview memory; they do not change persisted artifacts.

| Finding | Change | Regression coverage |
| --- | --- | --- |
| Slow polling could overlap subsequent timer/focus refreshes and publish after teardown. | One in-flight read per source for Git, usage and session polling. Failures are consumed, later ticks retry, and retirement aborts chained work and ignores late results. Usage providers remain independent. | Burst refresh, rejection/retry, retirement before start, late completion and cancellation before a chained read. |
| Simultaneous callers launched duplicate Git status processes; worktree status fanned out without a limit. | Share only in-flight status reads for a directory, copy results for callers, and limit a worktree scan to four concurrent status reads. Use direct executable invocation for worktree listing. | Twenty simultaneous callers launch one fake Git process; a subsequent read launches another. Twelve worktrees stay at a peak of four processes and preserve order. Real worktree tests also pass. |
| Session metadata cache used only `mtime`; JSON reads and scan concurrency were unbounded. | Identity includes device, inode, size, modification and change times. Limit each control file to 64 KiB, actual reads as well as preflight checks; scan at concurrency 16 and cap cached entries at 2048. | Unchanged files avoid opening, atomic replacement and same-mtime writes refresh, oversized files are skipped before opening, deleted entries disappear. |
| Widget documents had only a per-owner budget, and every insertion rescanned the entire cache. | Account bytes incrementally; retain the 32 MiB owner limit and add a global 128 MiB budget with least-recently-used eviction. Owner cleanup visits only its documents. | Global and owner eviction, access order, UTF-8 byte accounting, replacement and cleanup. GUI coverage verifies persisted widgets reload after eviction. |
| A widget timeout marked an unavailable preview as loaded. | Show a timeout error with Reload, wait for the actual ready message, and clear the timeout error if the document eventually becomes ready. | GUI test breaks the preview protocol, verifies the error/hidden iframe, restores the protocol and successfully reloads. |

## Verification

- TypeScript checks and renderer ESLint passed.
- Production build and test-source build passed before GUI tests.
- Full unit suite: 8564 tests, 8414 passed, zero failed, 149 skipped, one existing TODO.
- Selected GUI, Git/worktree and usage end-to-end tests: 25 passed, run locally
  with `CI` unset and `AYA_E2E_HEADLESS=1`.
- Local staged macOS arm64 package smoke passed, including packaged native
  owner/runtime checks. Signing was ad hoc; no release or notarization was run.
- Logs: `.gui-verification/snow2-*.log` (ignored local verification output).

Concurrency counts and byte budgets are verified directly. No claim is made
about whole-app CPU, resident memory or battery improvements without a workload
benchmark. Existing in-flight IPC calls cannot be forcibly cancelled; retired
consumers suppress their results and avoid starting subsequent chained work.
