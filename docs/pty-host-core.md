# PTY host compatibility (#217)

The detached host owns PTY spawn/kill, input queues, replay/search buffers, the VT mirror,
the Unix socket protocol and its process registry. Main prepares commands, env and launch
records, probes CLIs, selects resume sessions, watches session changes, and evaluates agent
screen rules. The exact built value-import graph is pinned in
`tests/pty-host-build-hash.test.mjs`: 14 modules, down from 36 on `1b09083c`.

The host reserves a spawn flight before asking the requesting main process for prepared
data. Input stays queued until a child exists. Kill and host restart cancel that flight;
disconnect cancels the wait; a 30-second timeout reports a failed terminal and settles
input waiters. Late prepared data cannot start a cancelled child.

The mirror sends snapshots at most once per 250 ms per writing pane. A requested snapshot
waits for pending xterm writes to apply. It includes rendered rows, cell dim/inverse flags,
agent/shell metadata and timestamps. Main uses the same hold/busy policy as before.
Replay restores the current dialog to a newly mounted renderer even if main has already
seen that edge. The host retains the original spawn request for session watchers across
preset edits and discards it on kill, exit or shutdown.
Composer-seen state is opaque, monotonic host metadata, updated only for the snapshot's
generation so it cannot cross a respawn. A missing or malformed snapshot holds team
messages (`PANE_HOLD_UNKNOWN`); busy still fails open. Snapshots are transient socket
data, never written to a file.

## Content identity

App version remains diagnostic. Compatibility compares one SHA-256 over:

- the entry `pty-host.js` and all built relative modules it requires;
- `node-pty` runtime JS, package metadata, available native candidates for this platform,
  and their spawn helpers (including worker/runtime files);
- `@xterm/headless` runtime JS and package metadata;
- `process.versions.node` and `process.versions.electron`.

Dependency runtime directories are covered conservatively; docs, source maps, tests and
build intermediates are excluded. Native candidates use node-pty's Release/Debug/prebuild
layout. The hash includes stable relative names and bytes, never installation paths.
Runtime versions are also shown in the handshake. The host snapshots its identity at
startup rather than rereading replaced files.

A legacy host without a usable hash is stale. Unreadable expected bytes are indeterminate:
keep the host, show the red dot and a Diagnostics warning, and perform no automatic
restart or stop of a live orphan host. The reaper retains its process-identity checks.

Changes to rules, spawn preparation, main, renderer or app version do not change the
host identity. The real-graph regression tests this boundary; changes to a VT mirror or
dependency binary do change it. Ordinary quit and the restart questions from #219 remain.

## Measurements (2026-10-15)

Repeat the source walk with `node scripts/measure-host-history.cjs` after
`npm run build:electron`. This transpiles tagged TypeScript to CommonJS and follows
value imports, including the entry. It reproduces the earlier graph counts:

| Transition | Changed original modules | Changed projected core predecessors | Runtime/dependency changes | Host conservatively kept |
| --- | --- | --- | --- | --- |
| v0.7.9 -> v0.8.0 | 5/12 | 4 | Electron, node-pty, headless | no |
| v0.8.0 -> v0.9.0 | 5/13 | 4 | none | no |
| v0.9.0 -> v0.10.0 | 2/13 | 2 | none | no |
| v0.10.0 -> v0.11.0 | 2/15 | 1 | none | no |
| v0.11.0 -> v0.12.0 | 19/24 | 11 | Electron | no |
| v0.12.0 -> origin/main 1b09083c | 31/36 | 12 | none | no |

The conservative projection maps new modules to their predecessor files:
`pty-core -> pty`, `vt-mirror -> vt-state`, `pty-host-paths -> paths`,
`pty-core-constants -> constants`, `atomic-temp -> atomic-write`. Other retained
module names map to themselves. Whole predecessor files are compared, so excluded
code that used to share a file can overcount restarts. Lockfile runtime versions and
integrity are compared; historical embedded Node/native build bytes are unavailable.
This is a conservative lower bound, not a replay of past native binaries.
It shows **0/6 kept**; no saved historical release is claimed where retained core changed.
The separate invariance regression shows zero restarts for changes outside the current
PTY core.

Repeat the socket measurement with
`ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/measure-host-snapshots.cjs`
(on macOS). It uses an isolated home, 30 real PTYs, dense 80x24 screens and 100 parallel
batches. Local macOS arm64, Electron 43.5.0 / Node 24.19.0:

| Measurement | Result |
| --- | --- |
| Snapshot bytes per pane (median / max) | 22,544 / 22,544 |
| Snapshot bytes across 30 panes | 676,320 |
| Applied snapshot round trip across 30 panes (median / p95) | 7.88 / 9.53 ms |
| Hold + busy evaluation across 30 panes (median / p95) | 1.46 / 2.70 ms |

These are local verification measurements, not a cross-machine latency guarantee.
At the maximum event rate this dense case sends about 2.7 MB/s for all 30 panes; quiet
panes send no periodic snapshots.

The version-only relaunch e2e keeps the host PID and both shell PIDs with this change.
On `origin/main 1b09083c`, the same test fails: the log records an identical script hash,
`host-shutdown(client-request)` and a new host PID after only the version changed.
