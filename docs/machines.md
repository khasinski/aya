# Machines (design)

Status: proposal, not implemented. One pool of the user's own machines
running Ollama, for any pane, team or not.

## Why

An 8-hour measurement run by a team lead lost time three ways:

1. The run moved to the laptop and each call was about 6x slower. Nothing
   showed which machine had which model hot.
2. A reviewer model shared the GPU with a timed run. Nothing showed that
   the GPU was busy, or with what.
3. Models were unloaded by hand (`keep_alive 0`) while someone else used
   them. A queue in front of a busy GPU also froze agent turns for up to
   70 minutes.

The first need is to see the pool. Controlling it comes after.

## Rules

1. App-level. Not part of teams and not tied to roles. Aya provides the
   pieces; each user or team protocol decides who reserves.
2. Ollama only, for now. A machine is local, or reached through an alias in
   `~/.ssh/config`. Nothing is installed on the host.
3. The core is one read-only command, `aya machines`. It gives the state of
   every machine. Everything else is a later step on top of it.
4. Setup is one sentence. Aya fills in the structure, probes it and shows
   it. Nothing is saved until the user confirms.
5. Aya never queues requests. A request that cannot run now is refused,
   with a message that says why and what to use instead.
6. A client that talks to Ollama directly cannot be stopped, only seen.
7. Models are identified by digest, not by name.

## The core: `aya machines`

```
$ aya machines
athena  up    ssh:athena  GPU 97% 21.0/24.0 GB  CPU 3.2/32  mem 41/128 GB
  qwen3:32b (ab12cd3) hot until 23:12 (14 min)
  reserved: run5 exclusive until ~23:45 (pid 4242, pane "collector")
laptop  up    local       GPU n/a  CPU 2.1/10  mem 20/32 GB
  no model loaded
mini    down  ssh:mini    ssh: connect timeout after 5 s (checked 23:01)
```

`aya machines --json` returns the same data in a fixed shape. Agents parse
the JSON; people read the text.

```json
{"machines": [{
  "id": "athena", "reach": {"ssh": "athena"}, "reachable": true,
  "checkedAt": "2026-10-03T21:01:05Z", "stale": false, "error": null,
  "ollama": {"up": true, "version": "0.12.3", "url": "http://127.0.0.1:11501",
    "loaded": [{"name": "qwen3:32b", "digest": "sha256:ab12cd3...",
      "vramBytes": 21000000000, "expiresAt": "2026-10-03T21:12:00Z"}]},
  "load": {"gpus": [{"name": "RTX 4090", "utilPct": 97,
      "memUsedMiB": 21500, "memTotalMiB": 24564}],
    "cpus": 32, "load1": 3.2, "memUsedBytes": 44e9, "memTotalBytes": 137e9},
  "note": "2x... (probe at registration, editable)",
  "leases": [], "reservation": null}]}
```

`leases` and `reservation` exist from the start and stay empty until steps
3 and 4, so the shape never changes. If `expires_at` is past year 2100,
the model shows as `pinned` (keep_alive -1).

Other commands:

- `aya machines add "sentence"`: draft, probe, show, confirm (see Setup).
- `aya machines remove <id>`: refused while a lease or reservation is
  active, unless `--force`. A forced removal is logged.
- `aya machines --brief`: one line per machine, for a team lead's round
  (step 6).

Like every `aya` command, these go through the control socket
(`electron/control.ts`). They are listed in `electron/capabilities.ts`, and
`tests/aya-capabilities.test.mjs` keeps `aya help` matching. If Aya is not
running, the commands fail the way other commands do ("start Aya first").

## Setup in one sentence

`aya machines add "athena is my 4090 box over ssh, ollama on the default
port; this mac is the laptop"`, or the same sentence typed into the
Machines view.

1. Draft. If the user has configured Aya Intelligence (Settings ->
   Intelligence), it turns the sentence into the registry shape. It is
   given the `Host` aliases from `~/.ssh/config` and allowed only those
   aliases or `local`. Without a provider, a plain word matcher does the
   same: alias names, plus "this mac/local/laptop" for local.
2. Probe every drafted machine (see Probes).
3. Show the filled structure next to the probe result, for example
   "athena: ssh ok, 2x RTX 4090 48 GB, CUDA 12.4, Ollama 0.12.3, 7 models".
4. Save on confirm. In a terminal (TTY), the command asks y/N. From an
   agent pane (no TTY), it prints a draft id and the line
   `aya machines add --confirm <id>`, which the agent runs only after the
   user says yes. This is the same handshake as `aya team open`.

The probe result is saved as `note`. The user can edit it. As in Claude
Science's Remote compute, it describes the machine and is not re-checked.

## Data model and where state lives

Everything is under the Aya config home (`AYA_HOME`, `~/.aya`;
`~/.aya-dev` for Aya Dev). Writes go through `atomic-write.ts` with mode
0600.

- `machines.json` is the registry, written only by add, remove and note
  edits. A machine has: `id` (`[a-z0-9-]`), `label`,
  `reach: "local" | {ssh: alias}`, `ollama: {port: 11434}` (the port on the
  host), `proxyPort` (fixed when the machine is added, from 11501 up, so a
  long-lived pane's URL stays valid across restarts), and `note`.
- `machines-state.json` holds reservations and the proxy's pid. Leases are
  kept in memory and copied here only for display. A reservation has: `id`
  (a name such as `run5`), `machine`, `mode: exclusive | shared`,
  `allowedDigests[]`, `holder {pid, pidStartTime, terminalId?, label}`,
  `state: declared | active`, `expectedEnd`, `createdAt`, `activatedAt`.
- A lease has: `id`, `machine`, `terminalId | pid | "unknown"`, `model`,
  `digest`, `path`, `startedAt`, and on end `endedAt` and `outcome`
  (`done | error | client-gone | refused | timeout`).
- `machines-log.jsonl` is append-only and capped at 5 MB with one rotation.
  It records refusals, breaks, deviations, forced removals, stale-holder
  cleanups and ended leases.

The state survives a restart. On load, and every 15 s, each holder is
checked by pid plus start time, as in `pty-host-registry.ts`, so a reused
pid does not count. A dead holder releases its reservation and writes
"holder exited" to the log.

## Probes

- Remote: `ssh -o BatchMode=yes -o ConnectTimeout=5` plus Aya's own
  `ControlMaster=auto`, `ControlPath=<AYA_HOME>/ssh/%C` and
  `ControlPersist=60`, so repeated status calls reuse one connection. The
  alias is checked against `^[A-Za-z0-9._-]+$` and passed after `--`.
  The remote command is a fixed read-only script, with no user text in it:
  `nproc`, `/proc/meminfo` or `vm_stat`, `/proc/loadavg` or
  `sysctl vm.loadavg`, and `nvidia-smi
  --query-gpu=name,utilization.gpu,memory.used,memory.total
  --format=csv,noheader,nounits` if present. The whole call is killed after
  8 s.
- Local: the same facts from Node's `os` module. GPU is `n/a` on Apple
  Silicon until `ioreg` is measured (see Open questions).
- Ollama: `GET /api/version`, `/api/ps` and `/api/tags` (tags give the
  name -> digest map). A remote host is reached through an ssh local forward
  (`-N -L 127.0.0.1:<ephemeral>:127.0.0.1:<port>`, `ExitOnForwardFailure`,
  `ServerAliveInterval=15`), so Ollama can stay bound to the host's
  loopback.
- Cadence: one status call probes every machine in parallel, with a 5 s
  cache so a polling agent does not flood ssh. A machine that misses the
  budget returns its last result with `stale: true` and its age. Background
  polling runs only while the view is open, or while a reservation or lease
  is active (detection needs it then).

## Getting the URL into a pane (step 3)

- Each machine gets one proxy port, bound to `127.0.0.1:<proxyPort>`.
- `safeEnv` in `electron/pty.ts` adds `AYA_OLLAMA_<ID>_URL` for every
  registered machine (id upper-cased, `-` becomes `_`). The value is
  `http://127.0.0.1:<port>/t/<token>`, where the token is
  HMAC(secret, terminalId) and the secret lives in `machines-secret`
  (0600). An OpenAI-compatible client adds `/v1` to that base.
- A new preset field, `ollamaMachine: "athena"`, also sets
  `AYA_OLLAMA_URL` and `OLLAMA_HOST` for that pane. It never sets
  `OPENAI_BASE_URL`, because that would redirect Codex and similar agents.
- Panes that started before a machine was added: `aya machines url athena`
  prints the URL for the calling pane.
- Who is asking: the token in the path names the pane. A request without a
  token (an OLLAMA_HOST client that drops the path) is matched by its peer
  pid: look up the TCP source port (`lsof` or `/proc/net/tcp`), then walk
  parent pids up to a pane shell the pty host knows. If both fail, the
  request is `unknown`, is still served, and is logged. The token is for
  attribution, not security: every pane runs as the same user.

## Proxy and leases (step 3)

- The proxy runs in its own detached process, the machines host, built
  like the pty host: its own unix socket, a registry record and a staleness
  hash. It does not run in main, because main restarts on every Aya Dev
  rebuild and would cut a stream in the middle of a run. It does not run in
  the pty host, because a proxy bug there would kill every pane. It exits
  when there are no panes, leases or reservations, the same idle rule as
  the pty host.
- Each request: buffer the JSON body (64 MB cap) to read `model` and
  `keep_alive`, map name -> digest from cached `/api/tags` (refreshed on a
  miss), check the reservation, open a lease, then pipe the response back
  without buffering, so streaming works.
- A lease ends at the end of the response, on an upstream error, or when
  the client disconnects. On a disconnect, the upstream request is aborted
  so Ollama stops generating. No lease outlives its socket.
- Timeouts: 5 s to connect upstream. A per-machine idle-stream timeout
  (default 10 min, which allows for a cold model load) gets a 504, ends the
  lease and writes to the log.
- A refusal is HTTP 403 with `x-should-retry: false`, because OpenAI SDKs
  retry 409, 429 and 5xx. The body follows the path, so each client shows
  it as its own error:
  - `/api/*`: `{"error": "athena reserved by run5 (exclusive) until
    ~23:45; laptop has qwen3:32b hot, use AYA_OLLAMA_LAPTOP_URL"}`
  - `/v1/*`: `{"error": {"message": "...", "type": "aya_reserved",
    "code": "machine_reserved"}}`
- Errors from Aya itself use the same shapes with a 502: "athena: ssh down
  (connect timeout)" or "Ollama not answering on athena:11434".

## Reservations (step 4)

- `aya machines reserve athena --as run5 --model qwen3:32b@sha256:ab12
  --exclusive|--shared --until 23:45` declares a reservation. It is visible
  to everyone but not enforced yet.
- `aya machines run run5 -- python collect.py` activates it, runs the
  command as the holder, and releases the reservation when the command
  exits. The pid sweep is the backstop if the wrapper is killed.
  `aya machines reserve ... --now` activates for the calling pane right
  away.
- `aya machines release run5` releases it. Anyone may run
  `aya machines break run5 --reason "..."`; the break is logged and every
  pane's status tab shows it.
- Exclusive: only the holder's requests, and only for allowed digests. Any
  other request gets a refusal. Shared: anyone may use the allowed digests.
  A different model is refused, because loading it would push the run's
  model out of VRAM. Calibration with a cloud judge uses shared; timed
  collection uses exclusive.
- In both modes, a non-holder's `keep_alive: 0` for a reserved digest is
  refused. With no reservation, everything passes, and Ollama's own queue
  applies.
- If `expectedEnd` passes, the reservation stays (its pid is still alive)
  but shows as `overdue`, and the holder's pane gets an `aya notify`.

## Detection (step 5)

The proxy keeps the time of the last request it saw per machine and
digest. Each poll of `/api/ps` (15 s while anything is active) compares:

- `expires_at` moved later with no proxied request in that window: a
  direct client used the model.
- A model loaded that no lease asked for: a direct load.
- A model gone before its `expires_at`: unloaded by hand or evicted.

Each case writes a deviation to the log and appears in the view. During an
exclusive reservation, it also raises an `aya notify` alarm. Detection
never kills or blocks anything.

## Machines view (step 2)

- A top-bar chip next to the usage chips: `athena 97% | laptop` (a dot
  per machine: green up, gray down, orange reserved).
- Its panel shows one card per machine, with the same data as
  `aya machines --json`: load bars, loaded models with "hot until",
  in-flight leases (pane, model, elapsed), the reservation with a Break
  button, and the last 5 deviations.
- Settings -> Machines: the one-sentence field with its confirm card, a
  list with Remove, and the editable note.
- Main reads the same status function the CLI uses, over IPC
  (`machines:get`). There is no second code path.

## Failure modes

| Failure | What clients see | What Aya does |
|---|---|---|
| ssh down | 502 within about 5 s, message names the host | forward restarted with backoff; status shows `down` and the error |
| Ollama down, ssh up | 502 "Ollama not answering" | lease ended as `error` |
| Upstream dies mid-stream | stream ends with an error chunk | lease `error`, log entry |
| Client disconnects | n/a | upstream aborted, lease `client-gone` |
| Machines host crashes | connection refused right away (no hang) | restarted on next need; leases with a dead proxy pid dropped from the file |
| Aya not running | proxy keeps serving while the machines host lives; `aya machines` says start Aya | the pid sweep still runs in the machines host |
| Aya Dev and Aya.app both running | separate homes, separate pools and ports | accepted: Aya Dev is temporary, for testing unmerged PRs |

## Security

- Every listener, proxy and forward binds `127.0.0.1` only (not
  `0.0.0.0` or `::`). The proxy is not exposed over Aya Web or remote
  sessions.
- To block DNS rebinding, requests with a `Host` other than
  `127.0.0.1:<port>`/`localhost:<port>`, or with a browser `Origin`, are
  rejected.
- Aya stores no keys or passwords. ssh authentication stays with the
  user's agent and config. Remote commands are fixed strings.

## State x action test matrix

Following `tests/team-states.test.mjs`: every state x action combination,
with the outcome spelled out. The tests use a fake Ollama (a Node HTTP
server serving `/api/ps`, `/api/tags` and streaming `/api/chat`) and a fake
`ssh` on PATH.

| Machine state | Reservation | Actor | Action | Expected |
|---|---|---|---|---|
| up, idle | none | any | `aya machines --json` | reachable, empty loaded |
| ssh down | any | any | status | `reachable:false`, error text, under 8 s |
| ssh slow | none | any | status | cached entry, `stale:true` |
| up | none | pane A | chat, stream | lease open during, `done` after |
| up | none | pane A | client aborts mid-stream | upstream aborted, lease `client-gone` |
| Ollama down | none | pane A | chat | 502 Ollama shape, lease `error` |
| up | exclusive A | pane A | allowed digest | served |
| up | exclusive A | pane A | other digest | 403 naming the allowed digest |
| up | exclusive A | pane B | any | 403 with holder, until, alternative |
| up | exclusive A | pane B | `/v1` path | 403 OpenAI shape, `x-should-retry:false` |
| up | shared A | pane B | allowed digest | served |
| up | shared A | pane B | other model | 403 |
| up | shared A | pane B | `keep_alive:0` | 403 |
| up | declared | pane B | any | served; reservation shown as declared |
| up | exclusive A | holder exits | sweep | released, "holder exited" logged |
| up | exclusive A, pid reused | sweep | | released (start time differs) |
| up | exclusive A | pane B | break | released, log entry with reason |
| up | exclusive A | direct client | ps poll | deviation + alarm |
| up | none | direct client | ps poll | deviation, no alarm |
| any | any | Aya restart | status | reservations kept, dead holders released |
| any | lease open | machines host killed | client | connection reset; next start drops lease |
| lease open | any | `remove` | remove | refused; `--force` logged |

## Delivery plan

1. Registry + probe + `aya machines [--json]` + `add` (sentence -> draft
   -> probe -> confirm) + `remove`, plus capabilities entries. Read-only,
   no proxy. Tests: probe parsing (fixtures from real `nvidia-smi`,
   `/proc`, `vm_stat`), status rows in the matrix, sentence drafts.
2. Machines view: chip, panel, Settings -> Machines over the same status
   function.
3. Machines host + proxy + leases + env vars + `aya machines url` + the
   `ollamaMachine` preset field. Leases show in status.
4. Reservations: reserve, run, release, break, refusals, digests, pid
   sweep.
5. Detection: `/api/ps` diff, deviation log, alarms in the view.
6. Team line: `aya machines --brief`, and one line a team's cadence can
   ask the lead to run in each round. Teams only consume it.

## Open questions

1. **Does the base path survive in Ollama clients?** Path tokens (`/t/<token>`) work for OpenAI SDKs. It is not verified whether the Go `ollama` CLI (`OLLAMA_HOST`) and `ollama-python` keep a base path. If they drop it, peer-pid attribution becomes the main path for those clients and has to be measured on macOS and Linux.
- Resolved: one pool per Aya config home, like every other Aya setting. Aya Dev only runs while a PR is unmerged, so a pool shared with Aya.app is not worth the complexity.
3. **Where should the proxy run in step 3?** The design puts it in a separate machines host. Shipping step 3 inside main first would be smaller, but every Aya Dev rebuild would cut in-flight streams. Is that acceptable as an interim step?
4. **Apple Silicon GPU load.** Can `ioreg` "Device Utilization %" be read without sudo on current macOS, or does local GPU stay `n/a`?
5. **A cap on in-flight requests per machine without a reservation?** Claude Science has a per-host concurrency limit. The design leaves unreserved traffic to Ollama's own queue, which is the queue that froze agent turns for 70 minutes. Should a per-machine `maxInFlight` refuse past the limit?
6. **Should refusals suggest an alternative?** The example points to "laptop has the model hot", but the laptop was the about 6x slower fallback. Should the suggestion be limited to machines whose probe note puts them in the same speed class, or should the refusal only state the facts?
7. **`--confirm` for agents.** Is a draft id plus `aya machines add --confirm <id>` acceptable under "no flags"? The alternative is that only the UI saves, and the CLI prints the draft and a pointer to the view.

## Feasibility (estimates, not measured)

| Step | Feasibility | Size | Main risk |
|---|---|---|---|
| 1. `aya machines` + add/remove + probe | high | medium | parsing `nvidia-smi`, `/proc`, `vm_stat` on Linux and macOS |
| 2. Machines view | high | small-medium | none: same status function as the CLI |
| 3. Proxy + per-request leases | medium | large | a new detached process; streaming; whether the Go `ollama` CLI keeps a base path (open question 1) |
| 4. Run reservations | medium-high after 3 | medium | enforced only for clients that go through the proxy |
| 5. Detection of direct clients | medium-low reliability | small | a heuristic over `/api/ps`; a warning, never a gate |
| 6. A line for a team's round | high | small | none |

Steps 1, 2 and 6 show today's blind spots (which model is hot, until when, GPU load) at low risk. Step 3 needs one measurement first: does each Ollama client keep a path in its base URL.
