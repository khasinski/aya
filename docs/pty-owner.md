# Native PTY owner - B1

I added the native owner, Node-API bridge, explicit client API and staged-package checks for #217 route B. **Aya startup and terminal spawning do not call this API.** B1 changes build/package contents, not the running terminal path. B2 will integrate spawning; planned JS-host replacement and automatic recovery remain later work.

The owner is a standalone executable with no Electron/Node, VT, rules, session, usage or git imports. It owns the masters and is the parent of each pane child from forkpty onward. The JS client receives CLOEXEC master duplicates over a private Unix socket. It alone reads/writes output/input; the owner has no output ring and never polls a master for input. Kernel queues preserve unread bytes and eventually backpressure the child. Already-consumed JS state is outside this protocol.

## Protocol and ownership

Every frame has a 16-byte big-endian header: magic `0x41594150`, u16 version `1`, u16 operation, u32 request ID, u32 payload byte count. IDs are nonzero; payloads are limited to 256 KiB. A string is u32 byte count plus bytes, without NUL. The supported JS encoder uses UTF-8. A vector is u32 element count followed by strings. Native limits are 25 pane records, 8 connections, 128-byte pane IDs, 256 argv entries and 1,024 environment entries; individual argument/environment strings are at most 65,536 bytes, within the total frame limit. Geometry is 2-1,000 columns and 1-1,000 rows.

| Operation | Payload / result |
| --- | --- |
| HELLO (1) | Exactly 32 secret bytes; result: build ID string, owner PID, random instance ID string. |
| SPAWN (2) | Pane ID, cols/rows, absolute cwd/command, argv including argv[0], complete environment as `KEY=value` strings. Returns a pane record and one master FD. No shell evaluation or CLI probing in the owner. |
| ATTACH (3) | Pane ID/generation; returns record and a new master duplicate if still retained. |
| RESIZE (4) | Pane ID/generation, cols/rows. |
| KILL (5) | Pane ID/generation, signal (HUP/TERM/KILL/INT). HUP/TERM escalate the group after 750 ms. |
| LIST (6) | Empty payload; count and pane records, including retained exits. |
| ACK_EXIT (7) | Pane ID/generation/event ID. Idempotently retires exit delivery and closes the owner's master; the client must release its duplicate after draining output. |
| SHUTDOWN (8) | Empty payload; acknowledges, then stops/reaps children and closes masters/socket. This is destructive, not a detach operation. |
| STATS (9) | Empty payload; u64 user/system CPU microseconds from getrusage, for local diagnostics. |

Replies are OK `0x8000` or ERROR `0x8001`, with the request ID. An error contains one bounded string. EXIT `0x8002` has request ID zero and one pane record. The record contains ID, generation, PID, cols, rows, exited, exit code (`0xffffffff` if unavailable), signal, event ID and acknowledged flag. Only SPAWN/ATTACH replies carry an FD, attached to the first header byte. Requests carrying ancillary data are rejected and received FDs closed. The bridge checks truncation, lengths/version/magic and ancillary descriptors, closes on incomplete receives, and uses an asynchronous bounded receive instead of blocking the JS event loop. The client serializes requests and records intervening exit events.

The socket's parent must be an owned private directory; socket/lock/token permissions exclude other users. Token files must be owned regular files containing exactly 32 bytes, with no symlink following. Token comparison does not stop at the first different byte. Kernel peer credentials must match the owner's UID and provide a real client PID. A retained flock prevents a second owner from replacing the socket while the first owns it. Authentication/incomplete-frame deadlines are five seconds; writes have a one-second deadline; exec acknowledgement waits up to three seconds, with failed/timed-out spawns killed and reaped. This initial native spawn acknowledgement serializes owner request processing during that bounded interval.

There is one authenticated JS-process lease. A disconnected process still owns it until that process instance is gone: socket EOF alone cannot prove that master duplicates were released. The lease records PID plus kernel start time (macOS proc_pidinfo; Linux /proc/PID/stat field 22), captured at accept and rechecked during authentication. A reused PID with a different start identity releases the old lease; an unreadable identity keeps it blocked. B3 must stop the old JS host before attaching its replacement. On Linux the bridge receives masters with MSG_CMSG_CLOEXEC, atomically excluding them from concurrent child exec; an unsupported kernel fails the receive rather than falling back to a race. macOS lacks that flag and uses the supported Node/Electron POSIX_SPAWN_CLOEXEC_DEFAULT spawn path plus explicit FD_CLOEXEC. The supported bridge marks descriptors CLOEXEC; transferring a master to a stream with `takeMaster` transfers close responsibility too. Merely releasing a client socket does not authorize another reader in the same living process.

Exit events are identified by owner instance, pane ID, generation and event. The owner keeps real waitpid status while no client is attached and replays an unacknowledged exit to the next authenticated client. The JS client deduplicates within its connection; receivers/checkpoints must carry their event receipts across their own restart if an acknowledgement was lost. Transport replay is deliberate until ACK, not a claim of exactly-once physical delivery across a receiver crash. ACK is idempotent, and acknowledged exits do not replay on reconnect. A replacement pane gets a new generation and stale ACK/kill/resize cannot affect it. The no-client-gap regression proves a child exits 23 during the gap, its successor receiver observes one exit, and a further connection receives none after ACK.

The owner reserves a child's PID until any delayed process-group escalation completes, and never signals a group from an old reaped pane record. Shutdown flushes/closes masters before blocking reaping: macOS terminal output drain can otherwise hold an exiting child while a client retains unread output. Flushing is restricted to explicit destructive shutdown. It is not used in attach or normal output delivery.

The owner does not acknowledge or replay input writes: those go directly through the master's FD. Planned cutover must drain/prove write outcomes or add sequence/ack deduplication before moving a client. An uncertain write after JS death must not automatically retry Enter or pretend delivery. No checkpoint, VT restore, automatic JS restart, UI fallback dialog or legacy migration is implemented in B1. A planned live-owner replacement must ask before stopping processes; an unexpected owner crash can close the last master/HUP children before a dialog, and Cancel cannot restore already-lost work.

## Build and package checks

`npm run build:pty-owner` compiles C11 with warnings as errors and local Node-API headers (set `AYA_NODE_HEADERS` if needed). It never downloads headers. The bridge uses Node-API v8; the executable links only platform libraries, including libutil on Linux. `pty-owner-build.json` records source/compiler/flags build ID and pre-signing binary SHA-256 values. The handshake build ID is diagnostic, not a substitute for checking actual shipped binary content/signatures before a future ownership/compatibility decision. The instance ID changes per process; build identity does not depend on app version, Electron or Node. Bridge bytes are separate from owner bytes.

The macOS deployment target is pinned to 12.0, matching the bundled Electron 43 Info.plist; package checks verify the Mach-O minimum for both artifacts. I did not run an older macOS machine. The normal build emits both artifacts, packages the executable outside asar, and unpacks the bridge. The signing hook preserves the existing Electron per-file signing options while giving the owner hardened runtime plus audio-input entitlement, without JIT, unsigned executable memory or library-validation exceptions. The audio permission allows OS consent for terminal descendants; it does not itself grant microphone access. Smoke tests verify these signature flags/entitlements and launch the owner/bridge through the bundled Electron-as-Node, without loading Aya's main entrypoint.

The staged macOS package is signed ad-hoc with timestamps disabled, then checked with `codesign --verify --deep --strict` and a separate owner verification. No signing identity discovery, Apple credentials or notarization is used. A future authorized Developer ID distribution build can use the custom hook with electron-builder's selected identity/keychain and existing notarization configuration; the resulting app still needs notarization/stapling checks. **That distribution/notarization path has not been run.** I have not searched for or used CI Apple secrets.

Preparation and tests are separate:

```sh
npm ci
node scripts/prepare-owner-electron.cjs  # dependency download, before offline probes
npm run build
node --test tests/pty-owner.test.mjs
node scripts/measure-pty-owner.mjs
AYA_OWNER_ELECTRON_DIST="$PWD/test-results/owner-electron" npm run test:owner-package
```

The package test uses a local distribution, disables dependency rebuilding/publishing/notarization and writes only staging under `test-results/`, never `release/` or prod. The new CI workflow verifies runner architecture and runs contracts, reproducible builds, 1/25-pane measurements and package smoke on macOS arm64 and Linux x64. No CI run is claimed before the branch is authorized to push.

For local Linux x64 on this arm64 Mac, I prepared the pinned Docker image separately, then ran probes with `--network none --platform linux/amd64 --init`. The image preparation installs dependencies; the test execution is offline. This is emulated x64 execution, not a native x64 performance benchmark. Example native component run:

```sh
mkdir -p test-results/empty-build-context
docker build --platform linux/amd64 -f "$PWD/scripts/pty-owner-linux.Dockerfile" \
  -t aya-owner-b1-linux test-results/empty-build-context
docker run --rm --init --pull=never --network none --platform linux/amd64 \
  -v "$PWD:/work" -w /work \
  -e AYA_OWNER_BUILD_DIR=/work/test-results/linux-native \
  -e AYA_OWNER_ARTIFACT_DIR=/work/test-results/linux-native \
  aya-owner-b1-linux sh -c 'node scripts/build-pty-owner.cjs && node --test tests/pty-owner.test.mjs && node scripts/measure-pty-owner.mjs'
```

Use a dedicated Playwright output subdirectory (for example `--output=test-results/e2e-owner-b1`) so its cleanup does not delete other evidence/staged packages. Native fixture homes are private/disposable and all sockets are Unix-domain. No product owner is started by these checks.

## B1 evidence

Measured on 2026-10-15. macOS 26.6 arm64 / Apple clang 21 / Node 26.10 ran locally. Linux x64 / GCC 12.2 / Node 24.22 ran under Docker x64 emulation on the same arm64 Mac, with networking disabled. Each row is three roughly two-second idle windows with quiet live shells; CPU is the owner's getrusage delta only, RSS is one ps sample per window, excluding children, kernel buffers and JS clients. These are not throughput measurements or production bounds.

| Environment | Panes | Owner RSS (KiB) | Owner CPU per ~2s (microseconds) | One-core CPU | Owner FDs: baseline -> active -> cleaned |
| --- | --- | --- | --- | --- | --- |
| macOS arm64 | 1 | 1,760 | 23-41 | 0.00115%-0.00205% | 8 -> 9 -> 8 |
| macOS arm64 | 25 | 2,032-2,048 | 55-64 | 0.00275%-0.00320% | 8 -> 33 -> 8 |
| Linux x64, emulated | 1 | 5,200-5,204 | 60-109 | 0.00300%-0.00542% | 11 -> 12 -> 11 |
| Linux x64, emulated | 25 | 5,452 | 74-168 | 0.00369%-0.00839% | 11 -> 36 -> 11 |

All six samples per OS returned both owner and client FD counts to their own baselines (client 21 on macOS, 31 on Linux). The 26th live pane was refused without an extra FD. Two separate local compilations on each OS reproduced both executable and bridge bytes exactly; these are pre-package/pre-signing SHA-256 values:

| Artifact | macOS arm64 | Linux x64 |
| --- | --- | --- |
| Owner | 7fdc1f7eea65053c78ad8c6d5947fb2ad66498242ede8dd30a243611b1769b5a | 29ed3aa72844b787ab1b85ee4493886ec3b77b325c80913346130de99f802666 |
| Bridge | d2a5bbccd70760fbabdab38db6ffd4fe1fdd851e45af10498e826c3eef7575f6 | 4cfcac0a5397139cc37b2960dedd05e632a24f41e276353c96193feab38565cc |

Native contracts passed 10/10 on macOS (one Linux-only check skipped) and 11/11 on Linux x64. Both regressions were mutation-checked: ignoring the saved start identity fails the recycled-PID assertion, and removing MSG_CMSG_CLOEXEC fails the immediate post-recvmsg descriptor check. The process-instance regression exercises HELLO with a deterministically recycled PID and verifies fail-closed unknown identity; the Linux receive wrapper checks CLOEXEC immediately after recvmsg returns, before any later fcntl can hide the fault window. They cover SIGKILL/readability/content/PPID, no-client-gap real exit retention and ACK/reconnect deduplication, stale generations, bad authentication/headers/oversized lengths, fragmented messages/unknown operations, duplicate ownership, exec failures, signal escalation and explicit shutdown with an unread duplicate. Full macOS npm test passed: 6,738 pass, 0 fail, 147 skipped, one pre-existing registry TODO. Existing restart-busy-panes, restart-background-work and diagnostics-host-health e2e passed 4/4 with AYA_E2E_PTY_SHUTDOWN=0 and one worker.

Raw measurement JSON, package identities, entitlements and logs stay under ignored test-results/. The initial shared-output cleanup mistake was corrected by using a dedicated e2e output directory before recording these preserved results. Actual staged-package smoke passed on both platforms under Electron 43.5 / Node 24.19: shell exit 23 plus a JS child evaluating a hot loop and exiting 24. Linux execution used the offline x64 container, and packaged native hashes match the local Linux build. macOS passed nested ad-hoc signing, deep/strict verification, owner entitlements/runtime checks and both 12.0 deployment metadata checks. No remote CI or notarization result is implied.

The Linux staged package was assembled locally with the prepared Linux Electron distribution and Linux native artifacts, then executed in the offline container (component smoke, not the full GUI). Cross-staging uses AYA_OWNER_PACKAGE_ARTIFACT_DIR rather than overwriting macOS build outputs. This does not claim an AppImage/DEB installer or an older glibc runtime test; the CI matrix uses the existing Ubuntu 24.04 baseline.

Two independent macOS staging/signing passes produced identical signed native bytes (ad-hoc, no timestamp): owner SHA-256 `5b1628a29e79a0c89f4f4f48992290aeb8a9a21b7175855b990cf68dd7339f14`, bridge `2aef7ce6a9246a9d532542fd32f85f3097377e634971f752b0fc6b460ea10884`. This measures repeatability with this local compiler/signing setup, not future Developer ID timestamp stability.

The cross-staged Linux package can be reproduced after the offline native build above (preparing the Electron archive is a separate online step):

```sh
AYA_OWNER_PACKAGE_PLATFORM=linux node scripts/prepare-owner-electron.cjs
AYA_OWNER_PACKAGE_PLATFORM=linux \
  AYA_OWNER_ELECTRON_DIST="$PWD/test-results/owner-electron" \
  AYA_OWNER_PACKAGE_ARTIFACT_DIR="$PWD/test-results/linux-native" \
  node scripts/package-owner-smoke.cjs
docker run --rm --init --pull=never --network none --platform linux/amd64 \
  -v "$PWD:/work" -w /work aya-owner-b1-linux node -e \
  'require("./scripts/package-owner-smoke.cjs").runStaged("test-results/owner-package-linux", "linux")'
```
