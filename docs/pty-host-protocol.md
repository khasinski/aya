# PTY host wire protocol

The detached PTY host (`dist-electron/pty-host.js`) is Aya's session backend.
It runs standalone under plain node, outlives any frontend, and speaks
newline-delimited JSON over a unix socket. This document freezes that contract
so alternative frontends (Aya Web, the native Swift experiment) can build
against it. Source of truth: `electron/pty-host-protocol.ts`,
`electron/types.ts` (`SpawnRequest`, `PtyEvent`), `electron/pty-host.ts`.

## Transport

- Socket: `$AYA_HOME/pty-host.sock` (default `AYA_HOME` is `~/.aya`).
  Unix socket paths are capped at ~104 bytes on macOS - keep `AYA_HOME` short.
- Framing: one JSON object per `\n`-terminated line, UTF-8, both directions.
- Any number of clients may connect; every event is broadcast to all of them.
- The host exits on its own after ~30s with no clients AND no live PTYs.
- Starting a host: `node dist-electron/pty-host.js` with `AYA_HOME` set
  (never under `ELECTRON_RUN_AS_NODE` remnants; plain node is fine).

## Requests (client -> host)

Every request carries a client-chosen numeric `id`; the host answers with a
response carrying the same `id`. Responses and events are interleaved on the
same connection.

| type | fields | result |
|---|---|---|
| `spawn` | `req: SpawnRequest` | `null` (outcome arrives as events) |
| `write` | `ptyId`, `data` (string) | `null` |
| `resize` | `ptyId`, `cols`, `rows` | `null` |
| `kill` | `ptyId` | `null` |
| `buffer` | `ptyId` | full buffered output for the id (string) |
| `search` | `query` | array of per-pty buffer hits |
| `version` | - | `{ version, scriptHash, ptyCount, pid }` |
| `shutdown` | - | `null`; host kills children (SIGKILL ladder) and exits |

Response shape: `{ "id": N, "ok": true, "result": ... }` or
`{ "id": N, "ok": false, "error": "message" }`.

### SpawnRequest

```jsonc
{
  "ptyId": "stable-tab-id",
  "projectSlug": "optional",
  "presetId": "optional",
  "command": "claude",        // preset command VERBATIM; the host wraps it in
                              // `$SHELL -l -i -c 'cd CWD && exec COMMAND'`
  "cwd": "/abs/path",
  "cols": 80,
  "rows": 24,
  "attachOnly": true          // optional: attach to an existing session only.
                              // Live session -> attach + replay. No session ->
                              // a `no-session` event, NO process is started.
}
```

A plain `spawn` (no `attachOnly`) for an id the host already runs is
suppressed (single-instance per id) and the existing session replays instead.
`attachIfReused` exists on the renderer/main API but is resolved into
wire-level `attachOnly` before the socket - it never appears on the wire.

## Events (host -> clients, broadcast)

Wrapped as `{ "type": "event", "event": { ... } }`:

- `{ "type": "data", "ptyId", "chunk", "replay": true? }` - terminal output.
  `replay: true` marks scrollback replayed on attach (render, don't treat as
  fresh activity). Chunks are coalesced per tick on busy output.
- `{ "type": "exit", "ptyId", "exitCode" }`
- `{ "type": "spawn-failed", "ptyId", "reason", "detail" }` - the host also
  paints a human-readable banner into the data stream.
- `{ "type": "no-session", "ptyId" }` - answer to an `attachOnly` spawn for a
  dead/unknown id; the Electron frontend shows the tab as stopped/restartable.

## Related on-disk state (read-mostly for alternative frontends)

- `$AYA_HOME/projects/*.json` - `{ name, directory, tabs: [{id, presetId,
  name}], splitLayout? }`
- `$AYA_HOME/presets.json` - `{ presets: [{id, name, icon?, color?, command,
  agent?, ...}] }`
- `$AYA_HOME/projects-state.json` - open/recent/active bookkeeping (owned by
  the Electron frontend; treat as advisory)
- `$AYA_HOME/pty-events.log` - the host's JSONL lifecycle log (0.7.9+)

Writes use atomic temp-file + rename (`electron/atomic-write.ts`); a second
writer must do the same.
