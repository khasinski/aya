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
