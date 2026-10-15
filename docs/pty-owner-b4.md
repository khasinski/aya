# Automatic JS-host crash recovery

I build B4 on `owner-checkpoint-b3` at `7339fbb5`. The owner keeps PTY masters and parents the children; main keeps the owner key in memory. Recovery replaces only an unexpectedly dead JS reader. It does not announce a planned handover or manufacture a checkpoint, and never signals the owner or silently spawns a missing pane.

## Stage 1 - bounded supervisor (not wired yet)

I limit recovery to three attempts, delayed by 100, 500 and 1500 ms. A successful but short-lived host consumes the same budget; only 120 seconds of stability resets it. Each attempt has a 10-second ceiling. The caller may return `retry` only after proving its failed JS child gone and releasing its local connection. An uncertain cleanup, exception or timeout exhausts the supervisor immediately: a timeout does not authorize a competing host. Concurrent requests share one flight. App disposal aborts backoff and the active attempt, with no exhausted notification or new attempt after quit.

Five focused contracts pass in Node and Electron: single-flight retry, repeated successful-but-crashing hosts, stable reset, uncertain/timed-out cleanup, and quit during delay/attempt. This stage is an unused policy module; it does not yet change crash behavior.

## Remaining integration

Main must retain pane launch metadata, expected owner/process identity and outstanding request outcomes. Before starting another JS host it must prove the old instance gone and the recorded owner alive/compatible; no crash path may replace a dead or incompatible owner. A private inherited bootstrap must reconcile the authenticated owner's complete inventory by pane ID, generation and process identity, attach masters without SPAWN, and retain real exit outcomes until delivery acknowledgement. Unknown inventory stays disconnected.

The new mirror begins unknown. Hold must fail closed until a newly applied, reconstructable screen is known; busy remains fail open. The renderer must clear stale display, explain consumed-history loss, apply unread/new output once and restore input only for recovered panes. Interrupted input is uncertain and never retried. A late or hidden view receives the same recovery state. Owner death keeps B2's explicit confirmed recovery and cannot promise preservation of already-lost work.

Planned follow-up evidence includes real SIGKILL/gap exits/exit-ACK retry, agent hold/busy/redraw, input uncertainty and no duplicate Enter, resize/backpressure, budget exhaustion/quit, legacy/stale/incompatible owners, affected and whole e2e, lint/full units and 25-pane recovery time/CPU/memory. All tests stay offline. No push, merge or production changes are authorized.
