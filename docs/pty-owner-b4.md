# Automatic JS-host crash recovery

I build B4 on `owner-checkpoint-b3` at `7339fbb5`. The owner keeps PTY masters and parents the children; main keeps the owner key in memory. Recovery replaces only an unexpectedly dead JS reader. It does not announce a planned handover or manufacture a checkpoint, and never signals the owner or silently spawns a missing pane.

## Stage 1 - bounded supervisor (not wired yet)

I limit recovery to three attempts, delayed by 100, 500 and 1500 ms. A successful but short-lived host consumes the same budget; only 120 seconds of stability resets it. Each attempt has a 10-second ceiling. The caller may return `retry` only after proving its failed JS child gone and releasing its local connection. An uncertain cleanup, exception or timeout exhausts the supervisor immediately: a timeout does not authorize a competing host. Concurrent requests share one flight. App disposal aborts backoff and the active attempt, with no exhausted notification or new attempt after quit.

Eight focused contracts pass in Node and Electron: single-flight retry, repeated successful-but-crashing hosts, stable reset, uncertain/timed-out cleanup, quit during delay/attempt, timeout listeners that resolve retry/recovered, synchronous in-attempt cancellation and the pinned default policy. Reviewer F1/F2 are fixed in `72158a35`; stage 1 has scoped READY. This stage is an unused policy module; it does not yet change crash behavior.

## Remaining integration

Main must retain pane launch metadata, expected owner/process identity and outstanding request outcomes. Before starting another JS host it must prove the old instance gone and the recorded owner alive/compatible; no crash path may replace a dead or incompatible owner. A private inherited bootstrap must reconcile the authenticated owner's complete inventory by pane ID, generation and process identity, attach masters without SPAWN, and retain real exit outcomes until delivery acknowledgement. Unknown inventory stays disconnected.

The new mirror begins unknown. Hold must fail closed until a newly applied, reconstructable screen is known; busy remains fail open. The renderer must clear stale display, explain consumed-history loss, apply unread/new output once and restore input only for recovered panes. Interrupted input is uncertain and never retried. A late or hidden view receives the same recovery state. Owner death keeps B2's explicit confirmed recovery and cannot promise preservation of already-lost work.

Planned follow-up evidence includes real SIGKILL/gap exits/exit-ACK retry, agent hold/busy/redraw, input uncertainty and no duplicate Enter, resize/backpressure, budget exhaustion/quit, legacy/stale/incompatible owners, affected and whole e2e, lint/full units and 25-pane recovery time/CPU/memory. All tests stay offline. No push, merge or production changes are authorized.


## Stage 2 - crash-only core attach (not wired into the host/main yet)

I add a closed, preflighted inherited bootstrap (1 MiB, at most 25 unique panes) containing the expected owner identity and bounded launch/process/generation metadata. It contains no owner credential, environment, consumed output or invented checkpoint. The owner runtime must be pinned before opening: missing, dead, different, incompatible or unauthenticated owners are refused before its create-owner branch. A refused open leaves the registry intact. Core attach requires matching native ID/generation/PID/kernel-start identity and uses SCM_RIGHTS attach, never SPAWN or preparation. Unknown inventory remains disconnected. New replay/search and the VT mirror begin empty; an unknown-screen snapshot fails hold closed and busy open, with the shell hold preserved. Planned VT export refuses an unknown mirror.

Eight real-process/schema contracts pass in both Node and Electron. The old JS host is SIGKILLed with reads actually stopped, the child produces a known unread reply before the replacement starts, and the replacement proves same owner/child PID, exact once-only unread output, working input/resize and exit 23. A separate child exits completely during the no-JS gap and its native retained status reaches the first attached view; no spawn/preparation is permitted. On macOS a child can remain in terminal drain while its final output is unread, so that test has no pending final output; unread output is independently proved in the live cases. Wrong generation is rejected before native attach; wrong owner, missing registry and wrong key refuse without creating an owner or replacing metadata. Malformed/duplicate/over-count/over-byte envelopes fail preflight.

This stage still has no production crash restart. Exit acknowledgement retry/deduplication, fresh-screen row coverage/redraw nudge, main discovery/backoff wiring and renderer reset/notice remain integration work. The accepted screen policy is a resize nudge plus parser-dispatched RIS/ED2 or every visible row written, followed by a short quiet settle; after 10 seconds an unknown screen stays held with an explicit notice/reason. Fragmentary output is never enough.


## Stage 3 - applied redraw coverage (not wired into main/UI yet)

I nudge live reattached PTYs to one column narrower and back before starting reads, preserving final geometry and sending SIGWINCH without input. A transient engine-pinned mirror tracker observes parsed printable spans/erase-line operations per visible row, parser-dispatched ED2 or RIS, and then 250 ms of quiet applied output. Scroll, resize and alternate-buffer transitions invalidate incomplete coverage. Empty writes used to drain snapshots do not reset the quiet clock. No raw substring can authorize a known screen. Until proof, hold reports `screen unknown after the terminal host restarted`, busy fails open, composer acknowledgements are refused and planned VT checkpoint capture refuses. Shell panes keep their shell hold. After 10 seconds the unknown callback/log fires but monitoring continues, so a later redraw can still recover.

Real PTY tests answer the resize nudge by replaying the recorded Claude idle and Codex skip-permissions idle sessions. After actual old-JS SIGKILL, the same children redraw, become known and return a null idle hold; input/resize and exit 23 still work. Eight screen contracts cover recorded Ink-style row redraws, fragments, control-looking string payloads, parsed RIS/ED2 with quiet time, geometry/alternate-buffer invalidation, scroll and frequent empty snapshot drains. The added `true,false` liveness case also pins the dead-retained owner refusal before registry mutation. Combined core/screen/parity/import-graph tests pass 37/37 in Node and Electron. The graph explicitly includes only the new VT screen tracker, not agent rules.

Main/UI production wiring and exit-delivery acknowledgements remain next. A discovered key-continuity case is pending lead choice: a main that only reuses an old host after an unannounced app relaunch has no owner key; B3 display-only unchanged-host handovers also currently omit it. This stage does not loosen the no-announcement credential rule.


### Stage 3 F4/F5 precision

I tightened the proof from touched rows to every visible cell, as the lead clarified. Printed cells are recorded at the pinned engine's cell setter; partial EL/ED and ECH cover only their actual cursor-bounded ranges. Scrolled-in blank lines are known, moved cell provenance stays conservative, and unsupported insert/delete moves discard prior coverage. Transient wrappers are bounded to current viewport lines and restored on completion/disposal; `replaceCells` is unchanged. A one-character touch or partial erase in every row cannot remove an unseen approval.

I also count received nonempty writes until their actual parser callbacks complete. Receipt immediately cancels prior quiet; completion starts quiet only with no outstanding work, and the final timer rechecks the receive epoch and pending count. Empty snapshot drains neither create work nor postpone quiet. New tests block a real asynchronous parser handler after established coverage and require unknown until it applies, alongside partial print/EL/ED negatives and ECH/full-erase positives. The 14 screen tests pass in Node and Electron. The real redraw test now checks the original native geometry before its later explicit resize, pinning the nudge-back separately. Exit-ACK integration is separate work and remains unreviewed.


## Stage 4 - native exit delivery acknowledgement

I defer native exit ACK in real socket hosts until main has recorded the generation/event receipt. Main deduplicates spontaneous native outcomes, retries a lost ACK up to three times, and keeps ended attach delivery separate so a newly attached view still receives its real exit. A received exit is retained in main memory before any ACK is sent. An interrupted write rejects as uncertain and is never resent; renderer input already presents that rejection. Explicit kill/fresh restart retires only its matching ended receipt. Core tests inject ACK success followed by a lost reply, then require idempotent retry and stale-generation refusal.

A pending exit receipt also travels with B3's bounded ended checkpoint and consent-commit outcome. This preserves unACKed native state through repeated planned replacements without attaching an ended master, changing the native wire or respawning a naturally ended pane. Existing natural-exit/trapped-stop/dropped-view/replacement-twice cases remain green. Main/app recovery itself is still unwired. The focused exit/core/ended/B3 compatibility set passes 34/34 in Node and Electron; full suites and final GUI recovery remain pending.

The lead chose key-continuity option A: automatic recovery only for hosts whose owner key the current main already holds, from its own start or a real B3 replacement. Reused hosts with an unknown key retain B2's disconnected behavior after death, with a dedicated truthful pane/diagnostic reason. There is no probing, owner replacement, key request or new transfer window. Continuity across unannounced app restarts belongs to the later socket-authentication work.

## Stage 5 - opt-in socket-client recovery backend

I rebased B4 onto main `1314f7bf`, including B3's Linux test setup fixes. The rebased stages pass 73/73 focused tests in each runtime. The real socket-disconnect exit test separately proves native ACK success before socket loss, reconnect retry before attach, one spontaneous outcome and later attach delivery; removing the reconnect loop fails it.

The client now has an opt-in recovery backend; production main and renderer wiring remain disabled at this stage. It retains its own owner key, current owner identity, prepared launch metadata and uncertain request outcomes. Every attempt proves the old JS process gone, the recorded owner compatible/alive and the lease released before starting a tracked replacement. A private inherited bootstrap reconciles exact IDs/generations/process identities and already-observed exits; it never prepares or spawns missing children. Owner identities accompany spawn responses so an empty owner's idle replacement cannot leave a stale recovery target. Unknown-key reused hosts take no recovery probes or credential requests and explain why their panes stay disconnected.

Nine real-host backend tests pass in Node and Electron: SIGKILL with proven unread output, same owner/child and working I/O/resize, repeated-crash budget, unknown-key refusal without probes, quit in backoff, real exit during the gap, failed successor budget, incompatible owner refusal, lost-write-ACK uncertainty with exact no-retry input, and an owner replaced after idle. The combined backend/stage set passes 83/83 in each runtime; the final manifest-validation follow-up passes all nine backend cases again. Main/UI integration, whole suites, lint, packaging and 25-pane measurements remain pending.

### Stage 5 review fixes

Reviewer F7-F9 are fixed in `5a8e6327`. I recheck cancellation after waiting for the prior child, update host PID and kernel start identity together from both spawn metadata and responses, and require the complete recovery manifest except matching already-observed native outcomes. The 15 real-host contracts pass in Node and Electron, including exact partial/empty/duplicate two-pane refusals and legitimate observed-exit omission. Independent reviewer guard-removal mutations fail each new boundary regression.

## Stage 6 - main, renderer and visible recovery

I enable the backend in main. Recovery installs bounded replay-only display records for later mounts; an existing view retires its pre-crash attach continuation, clears stale terminal state and applies its generation/token replay fence before input is enabled. A queued RIS also follows old buffered parser work, preventing it from repainting consumed history after reset. An earlier view can ACK its applied fence while later panes are still gated, using only the already-validated successor socket. ACK does not open ordinary writes or start another connection during cutover.

Every recovered pane explains that previously consumed screen/history was lost, while unread output and its process survived. A missing redraw after 10 seconds adds the explicit unknown-screen notice; generation-scoped known events remove that warning only after the applied per-cell/quiet proof. The team hold reason is the same. Shell hold behavior remains unchanged. Unknown-key reuse and exhausted recovery keep disconnected input disabled and preserve a visible reason in the pane and Diagnostics. Fresh explicit restart clears transient recovery metadata. No uncertain paste is retried.

The first integration build passed 15 GUI cases (shutdown=0, workers=1): same shell/owner PIDs with new input and real terminal resize, repeated-crash budget, late mount, recorded Claude/Codex redraws at their recorded120x40 geometry, busy and approval redraws, fragment timeout followed by user-triggered complete redraw, actual xterm paste with lost host ACK and one delivered line, exit23 during the no-JS gap/after recovery, and four unknown-key reused-host refusal/input cases. The final small queued-RIS/early-ACK follow-up is undergoing its focused rerun. Full units, lint, affected/whole e2e, packaging and25-pane metrics are aggregate gates, not claimed complete here. Native owner bytes and protocol are unchanged from B3. No push, merge or production action is authorized.

### Stage 6 F10-F13 follow-up

The lead chose an explicit non-destructive retry after exhaustion. The notice offers `Try again`, which spends exactly one supervised attempt with the same key/owner/process reconciliation and quit cancellation. It does not enable SPAWN or create an owner. A refusal returns the notice with the attempt's reason. Pane Restart is disabled with that reason, while ordinary disconnected unknown-key panes retain their separate explanation and B2 refusal policy. Main keeps recovery generation/history notice/current screen status and rehydrates new views on attach, so reload cannot conceal a still-unknown screen. Stale generation hydration is rejected.

Nineteen real GUI cases pass on the follow-up integration build. Added cases prove a counted successful manual attempt, one failed manual attempt with its reason, disabled Restart, a fragment pane's unknown notice after renderer reload, a held team message delivered exactly once after full redraw, quit during pending recovery without a successor, incompatible-owner refusal, and actual keyboard/Enter/paste producing zero writes while the recovery replay fence is held. After the applied callback, one paste produces exactly one child line. The fixture owns its already-closed quit-test app, avoiding a second Playwright close. Full-unit integration failures in IPC type parity and explicit host replacement readiness are corrected; the known registry TODO remains out of scope. Final full validation and metrics are still pending.

### F14 - manual policy lifetime

I give the manual supervisor the normal three-attempt policy with two slots initially spent. The manual invocation therefore has one remaining slot; a short-lived success cannot grant another automatic attempt. After120 seconds of stable operation, the ordinary reset restores all three slots. Policy and real-host tests pin both boundaries. I also preserve the exhausted/retry notice if timeout happens after the recovered inventory is published but before its replay RPC completes: the later socket-close event cannot overwrite it with a generic, non-retryable disconnect. A deterministic timer hook exercises that exact boundary without depending on runner speed.

## Native-exit boundary and 25-pane measurement

The additional real-process boundary test captures a live recovery version reply, lets that same child exit23 in the kernel before releasing the reply, holds native acknowledgement, and then requires the recovered-view fence followed by exactly one real exit23 with no failed attempt. It passes in Node and Electron. Core intentionally keeps pre-first-attach outcomes, so the suspected premature-exit loss was rejected; no product change was needed.

The first RSS trial was superseded: reviewer F15 found that it learned the successor PID only after readiness and therefore missed startup/replay. I refreshed the measurement with the PID captured immediately from the child returned by `startHost`. The raw artifact records timestamps, requested PID sets and measured RSS for every sample under `test-results/b4-recovery-measurement.json`.

The refreshed trial on product `278ad805` used macOS arm64, Electron 43.5.0/Node 24.19.0 and 25 real owner-backed PTYs at 120x40. Each local Node stand-in produced 512 payload bytes every 100 ms during active phases. All 25 child PIDs and the owner PID survived; the old JS process was independently confirmed gone before the successor started. Recovery through all replay fences took 311.77 ms, then all 25 input/output probes completed in 130.96 ms. Round-trip p50/p95 was 6.54/6.64 ms before and 5.71/6.43 ms after.

Across approximately 2.2-second windows, old/new JS CPU was 1.15%/1.68% idle and 10.32%/6.48% active; owner CPU was 0.015-0.016%. These are one local instrumented trial, not a steady-state speedup claim. Sampled RSS peaks were 92.16 MiB for the client/main driver, 110.73 MiB old JS, 109.52 MiB new JS and 2.20 MiB owner. The largest sampled combined driver+live-host+owner RSS was 203.88 MiB; individual peaks are not additive. There were 94 asynchronous 100 ms RSS samples, including two with the successor PID before readiness, and 200 ms CPU samples. No sample contained both JS hosts; the independent identity check before spawning establishes exclusion even between samples.

This exercises actual PTYs, host replacement and native ownership, without renderer/DOM state, agent-model work or their memory. The accepted crash policy loses consumed display/history; the measurement does not claim lossless consumed output. Real unread-output preservation is separately pinned by the SIGKILL/readStop barrier tests.

Aggregate gates remain pending at this documentation point. The earlier non-green full-unit baseline is retained as evidence; it is not the final result.

## Final review follow-up - C1-C5 and F15/F16

I distinguish exit acknowledgement results: `retired` succeeds, including an exact id/generation/event duplicate cached for at most 25 pane IDs and scoped to the owner instance; `unavailable` stays pending without retrying on the same socket; `stale` is dropped and logged. Recovery bootstrap uses the same retirement path so its native ACK is remembered before main retries. Real recovery and lost-reply reconnect tests require native inventory retirement, while stale generation and another owner instance cannot alias the receipt.

Exited recovery panes now name their actual exit code instead of claiming that their process is running. Disabled Restart items show `- host recovering` visibly as well as the complete reason in their tooltip. A timer-instrumented test proves each default 100/500/1500 ms backoff occurs before its attempt. The kernel-exit boundary test now requires the matching generation/token replay fence strictly between recovery and exit 23.

The measurement writes its result and raw samples under `test-results/`, with the successor PID recorded at process creation. On `278ad805`, full `npm test` passed: 7,110 passed, zero failed, 147 skipped and one existing registry TODO. Lint passed. The focused 54 contracts passed in Electron as well; the reviewer independently passed all 54 in Node and Electron and three changed GUI cases. The staged macOS arm64 owner/bridge/package smoke passed with unchanged native owner build ID `118a56699f60f2004e88344c4431abaa255a9a3c4bdd096a23c98d6b13f1b593`, real packaged adapter parentage, I/O, resize and exit 23. Ad-hoc nested signing verification ran; Developer ID/notarization and real Linux x64 CI were not run locally. The affected and whole GUI suites are still running on these product bytes. No push, merge or production action was performed.

### Planned-handover compatibility assertion

The first affected GUI run was 57 passed/one failed: B3's unmounted-ended-pane test expected the native exit record to disappear before any view had received its outcome. B4 deliberately retains that native record until main observes it. I updated only the intermediate assertion to require the retained exited record; the next checkpoint still carries it, and the real late-mounted view must show exact once-only suffix/exit 23 and retire native inventory. The exact compatibility case passes. Product bytes are unchanged; affected and whole GUI reruns remain pending.

## Dead-owner status integration regression

The first whole GUI run stopped as a non-green baseline at `owner-death-recovery`: B4's blocked `hostStatus` erased the retained owner inventory, so Diagnostics asked a generic question without the survivor PID. Unchanged main `1314f7bf` passed the same test three times on this Mac (14.9 seconds). I now return only the matching known-key owner's bounded private registry inventory when transport is blocked, without starting/probing any owner or JS host. A changed owner or unknown key cannot use that fallback. The unit regression fails against the literal `278ad805` client implementation.

The focused status/health/backend set passes 60/60 in Node and Electron. The real dead-owner Cancel/confirmed-recovery case passes three times (13.4 seconds), preserving the named PID on Cancel and stopping it only after consent before any new spawn. Its direct post-Cancel spawn now explicitly requires B4's refusal, while retaining the original inventory/process and final verified-stop/new-spawn checks. Final aggregate gates will be rerun on this product change.

### Renderer refusal follow-up (F17/F18)

I handle expected disconnected/recovering attachment refusals as the existing friendly disconnected notice with input disabled, without printing an IPC error. Both initial attachment and the explicit restart effect catch their Promise, retire restoring state and never retry. A retired initial continuation or a newer recovery generation ignores stale failures. Unexpected attachment errors retain diagnostic detail.

Actual GUI cases cover Cancel followed by renderer reload (one attach, friendly notice, same survivor/inventory, no internal error/page error/unhandled rejection) and a cleanly exited pane restarted after another pane loses its owner (one refused request, no native spawn, same survivor). Both pass; the latter must use exit 0 because only clean exits are Shift+Enter restartable. Consent-target binding F19 is the next separate stage before final aggregate gates.
