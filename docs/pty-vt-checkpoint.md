# B3 VT checkpoint proof

I chose a compact, engine-pinned structural snapshot at parser ground state, with a bounded tail of later VT input and resize operations. I did not add a host cutover, owner attach, checkpoint escrow or product call site. This is the first representation proof requested before building B3's cutover.

The public buffer API can observe cells but cannot faithfully write back both buffers, saved cursors and parser-related state. I use a narrow private binding to the installed `@xterm/headless` 6.0.0 implementation instead of pretending that text or the lossy rule snapshot is sufficient. The binding is pinned to SHA-256 `17a90b650cf6b77cce2b98c4063884d43545e4ce177a54b76ccfc906f1aacaed` of its loaded CommonJS implementation. A different implementation refuses this format; a future engine change needs a reviewed binding or the confirmed fallback. Electron/Node identity may change while those engine bytes remain compatible.

## Representation

The snapshot contains JSON scalar/object state and base64 little-endian Uint32 cell planes. It contains no function, executable class name, pointer, serialized closure or V8 heap image. Import uses a fresh Terminal's known classes/services, with its event wiring, then installs the saved state. Hyperlink markers are recreated with fresh disposal listeners while retaining the cell link IDs and line ownership. Restoring VT never forwards the terminal's query responses to a PTY. These responses are observed only for subsequent live input after import.

| State | Snapshot or tail policy |
| --- | --- |
| Normal and alternate buffers, active choice, geometry, retained history | Both line sets, wrapped flags, viewport/base coordinates and active-buffer reference. The proof also tests 64 lines of retained scrollback; the actual host currently configures zero. |
| Every cell, width, combining text, colours and attributes | Full content/FG/BG Uint32 planes, combined strings, extended underline attributes and hyperlink IDs; includes true-colour FG/BG. |
| Cursor, saved cursor, style, blink and visibility | Both buffers' cursor/saved cursor, saved attributes and charset, core cursor state and DEC private cursor options. |
| Scroll region, origin, wrap, reverse wrap and insert | Buffer scroll bounds and core normal/private modes. |
| Character sets and tab stops | Current charset, G0-G3 tables/selection, saved charset and each buffer's tab map. |
| Mouse, bracketed paste, focus and application input modes | Active mouse protocol/encoding and mouse state, private bracketed-paste/focus/application cursor/keypad modes. |
| Title and icon | Current values and both stacks. |
| Palette and special colours | Indexed/foreground/background/cursor overrides tracked from xterm colour events from construction onward; restore/reset updates are tested. Canvas/theme application is outside this headless proof. |
| Parser, decoder and partial escape sequence | Snapshot only at parser ground with no asynchronous parse continuation or queued write. Retains preceding Unicode join state, ground parser parameters and UTF-16/UTF-8 decoder carry. Subsequent string/byte inputs plus resize operations form the tail; import replays it into the snapshot before exposing the pane. |
| OSC 9001 carry, generation and composerSeen | Opaque pane metadata round-trips independently of parser compaction, including a change to composerSeen while a sequence is incomplete. Hooking the actual pty-core OSC carry and generation guard into the checkpoint belongs to the cutover implementation. |
| Replay/search, spawn/input/exit state | Outside this VT-only proof. B3 still must checkpoint their full records and prove the input/output barriers before attaching a successor. |

The tail cap is 256 KiB of encoded input/resize operations. A long unterminated sequence can temporarily exceed it; export then refuses, while parsing continues. The next parser ground state produces a new compact snapshot and restores eligibility. This does not disqualify a long-lived pane based on its total output. The snapshot cap in this prototype is 64 MiB per pane; B3 still needs its aggregate, transport and restore-allocation limits and complete schema validation before product use.

A new external marker or registered parser/Unicode handler refuses a ground-state export; disposing the unsupported registration restores eligibility. Logger/link-handler callbacks are unsupported. This prototype owns its Terminal and permits no custom mutations of handler internals. The product path must enforce the same ownership. Binding mismatch or unsupported state must refuse the seamless path before processes can die, then use #219's question. No input is automatically replayed by this prototype.

Applied operation order matters: the prototype awaits each xterm write callback before recording/compacting, and records an intervening resize explicitly when a tail exists. The eventual host barrier must account for asynchronous writes and resize ordering; logging producer calls alone is insufficient. The final output byte boundary and stopping PTY reads are not implemented here.

## Equivalence and measurements

The tests use all 16 recorded sessions under `tests/fixtures/own-screens`, take a mid-recording checkpoint, restore it, compare both buffers, then apply the rest of the recording and fresh queries/control sequences to both instances. The oracle compares full saved buffer/attribute/mode state and future parser responses, rather than only rendered strings. Synthetic continuations exercise alternate-screen round trips, retained scrollback, true colour, combining/wide glyphs, saved cursors, DEC charsets, scroll regions, input modes, hyperlinks, palette changes and split CSI/OSC/DCS/UTF-16/UTF-8. A resize inside a split sequence is replayed at its original position. A 500-redraw case verifies that consumed input grows while snapshot size stays bounded and the tail returns to zero.

Reproduction uses installed local dependencies only:

```sh
node --test tests/vt-checkpoint-proof.test.mjs
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --test tests/vt-checkpoint-proof.test.mjs
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/spikes/measure-vt-checkpoint.cjs test-results/vt-checkpoint-electron-measurement.json
node scripts/spikes/vt-checkpoint-cross-runtime.cjs produce test-results/vt-node26-checkpoint.json
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/spikes/vt-checkpoint-cross-runtime.cjs consume test-results/vt-node26-checkpoint.json
```

Reverse the last two runtimes to check the opposite direction. The cross-runtime fixture contains both buffers/history, palette metadata and an incomplete CSI; it compares the state after completing the CSI and returning to the normal buffer. I exercised Node 26.10.0 and Electron 43.5.0 / Node 24.19.0 in both directions on macOS arm64. This proves this JSON format/binding across those runtimes, not every future engine/runtime combination.

Measurement results are recorded below after the final local run. Raw per-read time series remain in ignored `test-results/vt-checkpoint-electron-measurement.json`; no PTY, product host or network is used. The dense workload is 25 terminals, each 240x80 with both buffers full of independently coloured cells, alternate active, and the host's zero scrollback. The reference full-journal size counts source input bytes, a lower bound that excludes journal framing. Restore timing covers VT import, not file I/O, owner attach, JS process startup or app pause. RSS is sampled after populating the terminals/checkpoints, not claimed as peak memory or checkpoint-only overhead.

On 2026-10-15, macOS arm64, Electron 43.5.0 / Node 24.19.0:

| 25 dense panes | Measurement |
| --- | --- |
| Snapshot DTO bytes | 15,741,240 |
| Complete transport JSON bytes | 15,743,555 |
| Complete transport gzip bytes | 3,235,419 |
| Reference consumed input bytes for those draws | 34,993,100 |
| Snapshot capture p50 / p95 per pane | 0.464 / 0.579 ms |
| VT import p50 / p95 per pane | 1.116 / 1.918 ms |
| Sequential import total, 25 panes | 30.664 ms |
| RSS before / after terminal and checkpoint population | 64,487,424 / 217,153,536 bytes |

These are one local trial, not production latency/memory bounds. Gzip is a size comparison only; import timing uses the uncompressed JSON DTO. It does not include decompression. The uncompressed full transcript reference is only the two dense draws; it would continue growing with later redraws while the compact snapshot retains both current buffers.

| Real recorded session | Recorded seconds | Reads | Consumed bytes | Maximum compact base bytes | Maximum encoded tail bytes | Final tail bytes |
| --- | --- | --- | --- | --- | --- | --- |
| grok-busy | 45 | 180 | 82,913 | 162,822 | 3,565 | 0 |
| grok-idle | 14 | 187 | 129,721 | 162,772 | 3,590 | 0 |
| opencode-idle | 14 | 36 | 28,386 | 162,820 | 5,130 | 0 |
| claude-offer | 211.2 | 135 | 23,945 | 83,134 | 0 | 0 |
| codex-skip | 10 | 75 | 8,724 | 166,162 | 1,225 | 0 |

The time series records tail/base bytes at each original PTY read boundary; this is accelerated replay of real recordings, not a new live agent session or a claim about every future redraw pattern. Parsing plus per-ground compaction took 49.6-271.3 ms per complete recording here. The 500-redraw regression consumes more than 2 MiB, keeps compact size within a 256-byte range and ends each redraw at zero tail; it is synthetic repeated output, not relabelled as a long real session.

The final equivalence suite passed 28/28 under plain Node 26.10.0 and 28/28 under Electron 43.5.0 / Node 24.19.0. Independent public cell/mode assertions check true-colour values, bold/dim/italic/inverse, wide/combined glyphs, alternate activation and nondefault input modes, so the test does not rely exclusively on the same projection as both implementation and oracle. Both cross-runtime directions passed with an incomplete sequence and retained history.

Before product use I still must add a complete adversarial DTO schema/allocation validator and aggregate cap, cover all unsupported handler-registration and ownership cases, integrate actual opaque pane state, and prove write/read barriers and renderer palette/history application. There is no claim that this VT prototype alone makes B3 complete or makes a host replacement safe.

Evidence review follow-up: F1's resize-after-overflow retention is fixed by discarding/stopping resize-tail retention once the cap is crossed; a 20,000-resize regression confirms bounded retained storage and recovery on the next ground state. That case also checks changed geometry and preserves xterm's distinction between current buffer dimensions and its original constructor option values. F2's same-version Unicode replacement is rejected by comparing provider object identities captured when this prototype creates the Terminal; registering a different implementation under public version `6` cannot pass a keys-only check. The suite now passes 30/30 in both local runtimes.

The F2 follow-up also checks ownership for every export while the parser is incomplete, independently of ground-state compaction. A same-version Unicode replacement, new marker or parser registration cannot hide behind an older valid base and a retained tail. Disposing a marker/handler restores eligibility without waiting for the pane to exit. Pending writes, asynchronous parsing and unknown active handlers also refuse export. These boundary regressions bring the proof to 33/33 in both local runtimes.

F3's executed-then-disposed handler case now marks retained operations ineligible whenever unsupported ownership was present while they ran. Public parser/Unicode registration and disposal also advance an ownership epoch, catching changes during an operation. Disposing a custom handler cannot make an older tail safe to replay. A supported ground snapshot captures the actual resulting cells and restores eligibility. The regression executes a custom SGR handler, disposes it during an incomplete CSI, verifies refusal, then verifies faithful recovery at ground. The proof passes 34/34 under Node and 34/34 under Electron.

## Product integration before cutover

I ported the pinned binding into `electron/vt-checkpoint-binding.ts` and confined its private xterm access to that module. `vt-checkpoint-schema.ts` validates a closed DTO before any payload field reaches a fresh terminal. It rejects unknown fields/options, prototype keys, invalid geometry/coordinates, modes, cell-plane storage/references, decoder/parameter storage and hyperlink marker bounds. Snapshot input is at most 64 MiB; retained cell allocation is at most three million cells per pane. The host currently uses default headless options except geometry/scrollback, and unsupported options refuse this binding. The encoded tail is at most 256 KiB. Opaque JSON also has depth, node, string-byte and total-byte limits.

`VtCheckpointTerminal` records writes in their parse callbacks and immediate resizes when they apply. Compaction runs after the current parse batch drains, so it cannot capture a later queued write and then replay that write twice. Parse drain is bounded; an asynchronous custom handler cannot hang a checkpoint forever. The actual VT mirror now uses this tracker and can export/import its generation, composer acknowledgement, shell/agent identity, last dialog/waiting edge and timing metadata. This does not yet move core OSC carry, spawn/replay/search records, PTY decoder carry or exit acknowledgements; those belong to the still-unimplemented cutover envelope.

`pty-checkpoint-store.ts` writes a separate part per pane plus a closed manifest under a private 0700 directory. Every file is 0600, newly created with O_EXCL/O_NOFOLLOW, and read with regular-file, owner, permission, link-count, size and SHA-256 checks. A receipt binds the random 256-bit nonce and manifest checksum/length. The manifest expires after 120 seconds. There are at most 25 parts, 64 MiB per part and 128 MiB in aggregate; the reader allocates and yields one checked part at a time through 64 KiB reads. It never joins all panes into one socket message. Acknowledgement unlinks the parts and manifest. This channel contains terminal state, never the owner's credential. It is a local same-account trust mechanism, not a defence against a process already executing as the user.

The product schema/mirror/store subset passed 78/78 in Node and 78/78 in Electron; the broader VT/hold/replay/hash/store run passed 373/373. Product-codec cross-runtime reproduction uses `tests/helpers/vt-checkpoint-cross-runtime.cjs produce|consume <file>` with the two runtimes, separate from the original prototype script. Native host fixtures and renderer test outputs must first be built with `npm run build:pty-owner` and `npm run build:test-src` when running the broad subset alone. Full npm/e2e and actual handover memory/pause measurements remain pending until cutover exists.

The encoded-tail limit also counts JSON array/comma framing. A many-small-resizes regression checks the retained representation stays within 256 KiB and recovers at ground. The two production-codec cross-runtime directions passed with the same split CSI, palette and retained-history fixture.

Review F4 is fixed by opening escrow inputs with O_NONBLOCK before fstat/type validation. Separate FIFO manifest and pane regressions use disposable subprocesses with a two-second kill deadline and require prompt refusal while retaining the escrow. Review F5 is fixed by a constant-space raw-byte token/depth preflight before JSON.parse; UTF-8 decoding is strict and happens after preflight. Snapshot and manifest raw parse boundaries use this helper, which will also parse the future per-pane envelope. A 2,100,001-element payload and excess-depth input are rejected with a JSON.parse spy proving zero materializations.

The cap regressions now include a valid-size 3,001,000-cell DTO and a terminal-constructor spy proving rejection before line allocation; a reader manifest over 128 MiB requires the specific aggregate refusal even with its first part absent; and a fake part-file sink checks writer acceptance at exactly 128 MiB and refusal before a third 64 MiB part, without giant disk allocations. Removing each of nonblocking open, raw preflight, cell cap, reader aggregate cap and writer aggregate cap makes its dedicated regression fail. Compiled mutation files were restored. The revised schema/store subset passes 57/57 in Node and 57/57 in Electron.

## Handover primitives (not a complete cutover)

I added the approved short one-use credential window. Only a prior announcement with a fresh 256-bit nonce and at most a 120-second deadline opens it. The first matching request records the connected Unix peer's kernel PID and measured kernel start identity; a wrong nonce ends the window, expiry refuses, and a successful transfer cannot repeat. The 0600 relaunch ticket contains only nonce, deadline and old-host process identity, is read once and deleted, and is bounded/nonblocking/nofollow. The owner key crosses only the in-memory local socket response and the inherited child pipe; it is absent from checkpoint/ticket/registry, argv, environment and lifecycle logs. Real-host tests compare its digest with the inherited key, exercise refusal and check the log.

The bridge's peer-identity helper uses macOS LOCAL_PEERPID/getpeereid or Linux SO_PEERCRED plus the existing start-identity probe. This identifies a process instance, not an Aya executable. Aya's existing local model trusts the same account; pty-host.sock is unauthenticated (a separate proposal), and a same-account process can read the nonce during its short on-disk window. This is not a defence against code already running as the user. There is no announcement/key recovery after an unannounced crash; B4 remains separate. The native owner's protocol and executable are unchanged: my macOS owner SHA-256 still matches B2, `253835d686f614426330a5b249e2a1702c235910da379bd559ec31b614071815`. Only the Node-API bridge gains the credential probe.

The adapter now has a bounded input drain and an output freeze. Every outstanding write must complete successfully, or freeze aborts and resumes the pane without retrying input. It stops libuv reads, prevents read() from restarting them, drains already-buffered bytes through the original listener, and records the raw byte count and up to three pending UTF-8 prefix bytes. Detach closes only the JS duplicate/control connection, never the owner's master or its children. A replacement adapter reconstructs the decoder from that raw prefix and attaches the same owner/generation/process; no spawn occurs. The exit path waits for a data consumer before draining a pending exit, so an exited-during-gap pane cannot lose its final output to an unattached listener.

Offline native reader-process regressions prove preexisting POLLIN output remains unread after freeze, a split emoji continues once after replacement, owner/child PIDs stay the same, resize still works and exit23 reaches the successor. A separate child exits while no JS reader is attached, then the successor receives its real23 once. The abort case resumes the same old reader, and a 1 MiB blocked input times out freeze while another pane answers, then finishes after its reader is explicitly released. Readiness uses bounded state/file barriers, not fixed startup sleeps. Node adapter/window/store/hash checks passed44/44; Electron reader/window/store checks passed28/28. The host/main cutover coordinator, renderer-state capture and full-envelope restoration are still pending.

Explicit abort cleanup can discard its own checked expired escrow after the old host resumes; it retains unknown or tampered state. The eventual coordinator must prevent another attempt until that cleanup succeeds and handle crash leftovers without accumulating attempts. A TTL alone does not delete files.

The lead approved actual-renderer capture for full display/history, rather than a second display mirror in the host. The host mirror retains zero scrollback, while the renderer retains10,000 lines and applies its own ESC3J/link/erase transformations, so host replay cannot prove full renderer history. Missing/unmounted/deadline-expired renderer state will keep its process/PID without a stop question and be explicitly logged as "history from replay". Capture will cap per-pane/aggregate bytes by cutting oldest scrollback, record cuts, preserve retained scroll position and measure25 dense full-history panes before this path is called complete. This is the approved next integration, not a claim already implemented here.
