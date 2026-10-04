# Machines (design)

Status: step 1 implemented (`aya machines`), later steps proposed. One
pool of the user's own machines running Ollama, for any pane, team or not.

## Why

An 8-hour measurement run by a team lead lost time three ways:

1. The run moved to the laptop and each call was about 6x slower. Nothing
   showed which machine had which model hot.
2. A reviewer model shared the GPU with a timed run. Nothing showed that
   the GPU was busy, or with what.
3. Models were unloaded by hand (`keep_alive 0`) while someone else used
   them. A queue in front of a busy GPU also froze agent turns for up to
   70 minutes.

The first need is to see the pool and to say who is using a machine.
Controlling it comes later, and only after a test shows it can work.

## Rules

1. App-level. Not part of teams and not tied to roles. Aya provides the
   pieces; each user or team protocol decides how to use them.
2. Ollama only, for now. A machine is `local`, or reached through a `Host`
   alias in `~/.ssh/config`. Nothing is installed on the host and Ollama is
   never exposed on the network.
3. Status uses read-only remote commands over ssh only: no port forwards,
   no tunnels, no writes on the host.
4. Setup is one sentence. Aya drafts the registry entry, shows it and saves
   nothing until the user confirms.
5. Aya never loads, unloads or calls a model in step 1. Every model unload
   Aya might do later needs the user's explicit approval at that moment.
   Occupancy or a reservation never counts as that approval.
6. Messages state facts. A refusal or warning never suggests "use the
   laptop" or another machine: a hot model is not a fast machine.
7. The JSON is versioned. Fields are added when a step ships, not reserved
   in advance.

## Step 1: `aya machines`

```
$ aya machines
athena  connected    ssh:athena  GPU 97% 21.0/24.0 GB  CPU 3.2/32  mem 41.0/125.7 GB
        ollama 0.12.3  qwen3:32b hot until 23:12 (14 min)
        occupied by justi since 22:40: run5 timed collection
        probe 210 ms (checked 23:01:05)
laptop  connected    local       GPU n/a  CPU 2.1/10  mem 20.1/32.0 GB
        ollama 0.12.3  no model loaded
mini    unreachable  ssh:mini    ssh: connect timeout (checked 23:01:05)
```

`aya machines --json` returns the same data. Agents parse the JSON; people
read the text.

```json
{"version": 1, "machines": [{
  "id": "athena", "label": "athena", "reach": {"ssh": "athena"},
  "ollama": {"port": 11434},
  "status": {"reachable": true, "checkedAt": "2026-10-03T21:01:05Z",
    "error": null, "probeMs": 210,
    "cpus": 32, "load1": 3.2, "memUsedBytes": 44e9, "memTotalBytes": 137e9,
    "gpus": [{"name": "RTX 4090", "utilPct": 97,
      "memUsedMiB": 21500, "memTotalMiB": 24564}],
    "ollama": {"up": true, "version": "0.12.3",
      "loaded": [{"name": "qwen3:32b", "digest": "sha256:ab12...",
        "vramBytes": 21000000000, "expiresAt": "2026-10-03T21:12:00Z"}]}},
  "occupancy": {"by": "justi", "purpose": "run5 timed collection",
    "since": "2026-10-03T20:40:00Z"}}]}
```

`version` is bumped when a later step changes the shape. `probeMs` is the
measured wall time of the probe (ssh round trip included), not a speed
estimate for a model. Memory and GPU sizes in the text are GiB. If
`expiresAt` is past year 2100 the model shows as `pinned`.

Commands:

- `aya machines [--json]`: state of every machine.
- `aya machines hosts`: `Host` aliases from `~/.ssh/config` (following
  `Include`), with an "added" mark on those already registered.
- `aya machines add "<sentence>"`: draft, probe, confirm in Aya (see Setup).
- `aya machines add --ssh <alias> | --local [--id <id>] [--port <n>]`: the
  manual form. `--ssh` takes only a `Host` alias from `~/.ssh/config`; an
  address or an unknown name is refused with the list of aliases. It is
  confirmed in Aya like a sentence.
- `aya machines remove <id>`.
- `aya machines occupy <id> "<purpose>"` and `aya machines free <id>`:
  advisory occupancy. Aya records who and when and shows it to everyone.
  It is never enforced: requests to Ollama are not checked against it.

There is no load or unload command.

Like every `aya` command, these go through the control socket
(`electron/control.ts`), are listed in `electron/capabilities.ts`, and fail
with "start Aya first" when Aya is not running.

## Setup in one sentence

`aya machines add "athena is my 4090 box over ssh; this machine too"`.

1. Draft by deterministic matching, no model involved. The sentence is
   split into words; a word that equals a `Host` alias from `~/.ssh/config`
   (with `Include` files followed, wildcard patterns skipped) becomes an
   ssh machine. `local` or the phrase "this machine" becomes the local
   machine. A port number written as `port 11435` applies to the machine
   named before it.
2. An ambiguous word such as "laptop", "mac" or "desktop" that is not an
   alias is never taken as local. The draft lists it under "unclear" and
   asks: "Did you mean this machine by 'laptop'? Say `local` to add it."
3. Show the draft: id, reach, Ollama port, and the unclear words.
4. Probe the drafted machines (read-only) and ask in Aya itself: a native
   Add / Cancel dialog shows each machine, what the probe found and the
   pane that asked. Only Add saves. The CLI caller, agent or terminal, is
   never asked and has no flag that saves, so an agent cannot register a
   machine on its own. The command waits for the dialog and prints
   "added ..." or "Not added: cancelled in Aya".

Aya Intelligence may later turn freer sentences into the same draft. It is
not needed for step 1, and it never bypasses the confirm.

## Data and where state lives

Everything is under the Aya config home (`AYA_HOME`, by default `~/.aya`),
written with `atomic-write.ts`, mode 0600.

- `machines.json`: `{"version": 1, "machines": [...]}`. A machine has `id`
  (`[a-z0-9-]`), `label`, `reach: "local" | {ssh: alias}`,
  `ollama: {port}` (the port on the host, default 11434) and an optional
  `occupancy: {by, purpose, since}`.
- Changes (add, remove, occupy, free) run one at a time in main. Each
  re-reads the file, and refuses to write if it changed meanwhile.
- A file that is not JSON, has another `version` or a malformed machine is
  never rewritten; commands say why.

## Probes

- Remote: `ssh -o BatchMode=yes -o ConnectTimeout=5 <hardening> --
  <alias> sh -s`, with a fixed read-only script on stdin, so the remote
  login shell never parses it. The hardening overrides what the alias's
  config could add: `ClearAllForwardings=yes`, `PermitLocalCommand=no`,
  `ForwardAgent=no`, `ForwardX11=no`, `ControlMaster=no`,
  `ControlPath=none`, `Tunnel=no`, `RequestTTY=no`. The alias must match
  `^[A-Za-z0-9._-]+$` and comes after `--`.
  Only the validated port number is substituted into the script:
  `nproc`, `/proc/loadavg` or `sysctl -n vm.loadavg`, `/proc/meminfo` or
  `vm_stat` plus `sysctl -n hw.memsize`, `nvidia-smi
  --query-gpu=name,utilization.gpu,memory.used,memory.total
  --format=csv,noheader,nounits` if present, and
  `curl -q -s --noproxy '*' -X GET --max-time 3
  http://127.0.0.1:<port>/api/version` and `/api/ps` (`-q` first, so the
  host's `~/.curlrc` cannot add a body, a method or a proxy).
  Sections are separated by marker lines so a missing tool is an empty
  section, not a parse error.
- Local: Node's `os` module, memory from `/proc/meminfo` `MemAvailable` on
  Linux and `vm_stat` on macOS (the same parsers as the remote path), `nvidia-smi` if present, and the
  same two Ollama calls over HTTP to `127.0.0.1:<port>`. GPU is `n/a` on Apple
  Silicon (see Open questions).
- The whole probe is killed after 10 s and reported as unreachable with
  the error and `checkedAt`. Every process it started gets SIGKILL to its
  process group, and the probe answers only after they exited.
- `/api/version` answering while `/api/ps` fails gives `loaded: null` and
  `modelsError`, shown as "models: unavailable (<why>)", never as "no model
  loaded".
- One probe per machine is in flight at a time and shared by every caller
  (`electron/single-flight.ts`), with a 3 s cache so a polling agent does
  not flood ssh.

## Later steps

Each step ships only after the one before it is used and the open question
it depends on is answered.

2. **Machines view with suggestions.** A top-bar chip and a panel over the
   same status function, plus Settings -> Machines:
   - **Suggested machines.** Aya lists every Host alias in `~/.ssh/config`
     (with `Include`) that is not added yet, and `local`. Listing reads only
     the config file; it connects to nothing. A "Check" per host, or "Check
     all" on the user's click, runs the step 1 read-only probe with
     `BatchMode=yes` and a short timeout, and shows: reachable or why not,
     GPU, memory, Ollama and its models. Hosts with Ollama and a GPU come
     first, unreachable ones last. "Add" saves a suggestion after the user
     sees what it found; nothing is added on its own. Aya never probes
     hosts the user did not ask it to check, because a config can name
     servers the user does not want touched.
   - **A host that is not in the config yet.** "Set up ssh" asks for the
     address and user, checks for a key and offers to create one, opens a
     shell pane with `ssh-copy-id` where the user types the password (Aya
     never sees or stores it), then shows the `Host` block for
     `~/.ssh/config` and writes it only on the user's yes, after a backup.
     The new host then appears among the suggestions.
   - The added list with state, occupancy ("who and why") and Remove.
   Only added machines show in the top-bar chip, its panel and
   `aya machines`; suggestions live in Settings until the user adds them.
3. **Routing test (cheap, before any proxy).** With the user's approval
   and during a window they pick, put a throwaway forwarding shim (a small
   Node script on `127.0.0.1`, no Aya changes) in front of one machine's
   Ollama and point the real collector and reviewer at it. Check:
   - every inference request goes through the shim (compare the shim's
     count with Ollama's own log for the same window);
   - two concurrent clients can be told apart by port or header;
   - streaming responses arrive unchanged;
   - a client disconnect is visible, and whether the GPU work actually
     stops (watch `nvidia-smi` after the abort).
   If any client ignores the URL or keeps a configured one, the proxy plan
   below does not hold for it, and the step stops there.
4. **Proxy, per-pane ports and a detached machines host**, only if the
   routing test passes. Leases per request, an endpoint allowlist, a
   bounded admission limit per machine so no request waits in Ollama's
   queue, and a client disconnect never treated as proof the GPU is idle.
5. **Reservations**, enforced only through the proxy. Conflicting
   reservations are refused; activation waits until running work ends and
   never cancels it. `keep_alive: 0` and anything that could evict a model
   are refused unless the user approves that unload in the moment.
6. **Observation.** Diff `/api/ps` over time and label changes as
   observations ("expiry moved with no proxied request"), never as proven
   violations; it never blocks or kills anything.
7. **Team line.** `aya machines --brief`, one line a team's cadence can ask
   the lead to run each round. Teams only consume it.

## Security

- Aya stores no keys or passwords. ssh authentication stays with the
  user's agent and config. Remote commands are fixed strings with only a
  validated port number in them, and the alias is validated and placed
  after `--`.
- Step 1 opens no listener and no forward. Any later listener binds
  `127.0.0.1` only and rejects a foreign `Host` or a browser `Origin`.

## Step 1 test matrix

Tests never ssh to a real host: a fake `ssh` on PATH replays fixtures, and
`AYA_HOME`/`HOME` are temp dirs.

| Probe input | Expected |
|---|---|
| Linux: `/proc` + `nvidia-smi` + Ollama with a loaded model | cpus, load, memory, GPU rows, version, loaded model with expiry |
| macOS: `sysctl` + `vm_stat`, no GPU | memory from pages x page size, `gpus: []` |
| Linux without `nvidia-smi` | `gpus: []`, everything else filled |
| Ollama down (empty sections) | `ollama.up: false`, machine still reachable |
| ssh exits 255 | unreachable, ssh error text, `checkedAt` |
| ssh hangs | killed at 10 s, unreachable, "timed out" |

| Sentence | Expected draft |
|---|---|
| names an alias | one ssh machine with that alias |
| "laptop" only | nothing drafted, "laptop" listed as unclear |
| "this machine" or `local` | one local machine |
| unknown word that looks like a host | listed as unknown, not drafted |
| alias already added | marked "already added", not drafted again |

CLI tests cover add (sentence and manual, the dialog's Add and Cancel, a
non-alias refused, a terminal caller never asked), hosts, remove, occupy,
free, concurrent changes, malformed registries and `--json` against a temp
`AYA_HOME`.

## Open questions

1. **Apple Silicon GPU load.** Can `ioreg` "Device Utilization %" be read
   without sudo on current macOS, or does local GPU stay `n/a`?
2. **Routing test outcome.** If the real collector cannot be pointed at a
   proxy, is advisory occupancy plus visibility enough, or is a host-side
   component acceptable after all?
3. **Admission limit.** In step 4, should the per-machine limit be one
   request in flight, or configurable per machine?
4. **A speed hint.** `probeMs` measures ssh, not inference.
   Is a measured tokens-per-second figure per machine and model worth a
   user-approved benchmark command later?
