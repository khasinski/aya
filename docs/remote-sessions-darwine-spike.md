# Remote Aya Spike: `ssh darwine`

Status: exploratory spike, 2026-06-17.

## What We Tested

Local machine can connect to the remote host with:

```bash
ssh darwine
```

Observed remote host:

- Host: `darwine`
- User: `hasik`
- OS: Linux x86_64, Ubuntu kernel `6.17.0-35-generic`
- Node: `/usr/bin/node`, `v20.19.4`
- npm: `/usr/bin/npm`, `9.2.0`
- Aya CLI: `/usr/local/bin/aya -> /home/hasik/Projects/aya/bin/aya`
- Aya home: `/home/hasik/.aya`
- Aya repo: `/home/hasik/Projects/aya`

The remote repo/CLI are older than current local `origin/main`; the remote CLI
does not have an `aya remote` command yet.

## Current Remote State

`~/.aya` on `darwine` contains normal project config:

- `projects/aya.json`
- `projects/hasik.json`
- `projects-state.json`
- `presets.json`
- `aya.sock`

The socket exists, but it is stale/unreachable:

```text
connect ECONNREFUSED /home/hasik/.aya/aya.sock
```

No Aya/Electron/pty-host process was visible for the user during the spike.

Implication: today we can test SSH transport and static project snapshotting,
but not live PTY streaming or control until a remote host API exists and the app
is running.

## Prototype Probe

We ran an ephemeral SSH command that did not install or modify anything on
`darwine`. It read `~/.aya` and emitted a JSON snapshot over stdout.

The shape worked:

```json
{
  "type": "hello",
  "protocol": 0,
  "host": {
    "id": "darwine",
    "name": "darwine",
    "platform": "linux",
    "user": "hasik"
  },
  "ayaHome": "/home/hasik/.aya",
  "app": {
    "controlSocket": "present-not-proven"
  },
  "snapshot": {
    "projects": [],
    "state": {},
    "presets": []
  }
}
```

The actual run returned two projects (`aya`, `hasik`) and the remote preset
list. This proves the SSH stdio path is viable for host identity and initial
workspace metadata.

## Design Decision

Use SSH stdio as the first transport:

```bash
ssh darwine aya remote --stdio
```

The local app owns the SSH process. The remote `aya remote --stdio` command is a
bridge, not the remote app itself:

```text
local Aya <-> ssh stdio <-> remote aya CLI <-> remote Aya host-local API <-> remote PTYs
```

For v1, do not read or mutate remote config files directly from the client.
The host app remains authoritative for:

- Project list and project state
- Terminal metadata
- PTY output buffers
- PTY writes/resizes/restarts
- Config persistence

The temporary config-reading probe is useful only as a bootstrap experiment.
Production remote should ask the running remote Aya host for a snapshot.

## Proposed Protocol

Use newline-delimited JSON over stdio. Every message has `type`, `id` when it is
a request/response, and `protocol`.

Handshake:

```json
{ "type": "hello", "protocol": 1, "client": { "version": "0.5.0" } }
```

Remote response:

```json
{
  "type": "hello",
  "protocol": 1,
  "host": {
    "id": "darwine",
    "name": "darwine",
    "platform": "linux",
    "user": "hasik"
  },
  "permissions": {
    "mode": "read-only"
  }
}
```

Initial snapshot:

```json
{
  "type": "snapshot",
  "projects": [],
  "terminals": [],
  "buffers": []
}
```

PTY output event:

```json
{
  "type": "pty:data",
  "terminalId": "remote-terminal-id",
  "chunkBase64": "..."
}
```

Control command:

```json
{
  "id": "req-1",
  "type": "pty:write",
  "terminalId": "remote-terminal-id",
  "dataBase64": "..."
}
```

Response:

```json
{ "id": "req-1", "type": "ok" }
```

Binary PTY bytes should be base64 encoded in JSON messages at first. It is not
the most efficient transport, but it is simple, inspectable, and robust over
stdio. We can optimize later if needed.

## Local Aya Integration Shape

Add a remote host model beside local projects:

```ts
interface RemoteHost {
  id: string;
  label: string;
  sshTarget: string;
  status: "connecting" | "connected" | "disconnected" | "error";
  permissions: "read-only" | "control";
}
```

Remote projects should keep their host identity in every UI path:

- Project tab/row gets an orange remote accent.
- Pane header shows host label when space allows.
- Terminal input is disabled when disconnected or read-only.
- Local and remote terminals must not be mixed in one split layout for v1.

## Implementation Phases

1. `aya remote --stdio` CLI skeleton.
   - Add command to `bin/aya`.
   - It connects to a new host-local remote socket.
   - If the app is not running, return a structured `app_unavailable` error.

2. Remote host-local API in the Electron main process.
   - Separate from the existing control socket.
   - Supports `hello`, `snapshot`, and event streaming.
   - Initially read-only.

3. Local SSH client service.
   - Spawns `ssh <target> aya remote --stdio`.
   - Parses NDJSON.
   - Maintains connection status and reconnect/error state.

4. Read-only UI.
   - Render remote projects and terminal buffers.
   - No writes yet.

5. Single-client control.
   - PTY write/resize/restart commands.
   - Host-visible "remote client controlling" state.

## Test Plan With `darwine`

First testable milestone:

```bash
ssh darwine aya remote --stdio
```

Expected when remote Aya is not running:

```json
{
  "type": "error",
  "code": "app_unavailable",
  "message": "Aya is not running on darwine"
}
```

Expected when remote Aya is running and remote is enabled:

1. Local client sends `hello`.
2. Remote responds with host metadata.
3. Remote sends `snapshot`.
4. Local renders remote projects read-only.
5. Disconnecting SSH leaves remote PTYs alive.

Second milestone:

1. Start a shell tab in Aya on `darwine`.
2. Connect from local Aya.
3. Verify buffered output appears locally.
4. Type locally only after control mode is enabled.
5. Verify the command runs on `darwine`, not locally.

## Open Questions

- Pairing: is SSH authentication enough for v1, or do we still require an
  explicit "Enable remote" toggle plus one-time confirmation on the host?
- Should the remote bridge allow read-only snapshots when the host UI is not
  open, or must the GUI app always be running?
- Should snippets be disabled for remote control until there is a paste/execute
  confirmation model?
- Should URL opening happen on the client, on the host, or ask every time?

## Recommendation

Build the read-only SSH stdio bridge first. Do not start with LAN sockets,
multiple clients, or full write control.

The `darwine` test shows SSH aliases and remote config discovery are already
usable. The missing primitive is a real remote host-local API in Aya that can
provide live snapshots and PTY events without direct config-file scraping.
