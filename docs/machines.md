# Machines

One list of the user's own machines running Ollama or an OpenAI-compatible API, for any pane, team or not.
Aya shows each one's state and who claimed it. It never loads, unloads or calls a model.

## Why

An 8-hour measurement run by a team lead lost time in three ways:

1. The run moved to the laptop, and each call was about 6x slower. Nothing showed which machine had which model hot.
2. A reviewer model shared the GPU with a timed run. Nothing showed that the GPU was busy, or with what.
3. Models were unloaded by hand (`keep_alive 0`) while someone else was using them.

So the first need is to see every machine at a glance and to say who is using one.

## Rules

1. **App-level.** Machines are not part of teams and are not tied to roles.
2. **Ollama by default.** A machine is `local`, or reached over ssh by a `Host` alias from `~/.ssh/config`, a remote project's target, or `user@host`. Nothing is installed on the host. An optional API backend uses a URL supplied by the user.
3. **Read-only probes.** Status comes from a fixed read-only script, run over ssh with no forwards and no tunnels, and with no writes on the host.
4. **Only the user adds a machine.** In Aya, the click is the yes. `aya machines add` from a pane asks in Aya's own dialog, and the caller has no flag that saves.
5. **No model control.** Aya never loads, unloads or calls a model. A claim is advisory and never counts as approval to unload.
6. **Facts only.** Messages state facts. A refusal never suggests "use the laptop": a hot model on a slower machine is not a fast alternative.
7. **Versioned JSON.** Fields are added when a feature ships, not reserved in advance.

## Where you see it

**Status bar.** Once a machine is added, the status bar shows one machines icon, so six machines never fill the bar. Its tooltip and accessible name say each machine's state in words, for example `Machines: athena ready, claimed; mini unreachable`. With no machine added, there is no icon. The item polls every 30 s while Aya is visible; a slow answer that arrives after a newer one is dropped.

**Popover.** Clicking the icon opens a popover titled with how many machines are ready, for example `Machines · 1 of 6 ready · checked 13:14`. Ready machines come first, each in full:

- a green dot, the name and the GPU (or CPU) model; a ready machine needs no word;
- GPU use and VRAM, or load and RAM when there is no NVIDIA GPU (`load 8.8 on 18 CPUs`), plus how the machine is reached;
- each loaded model with its memory reported by Ollama and how long it stays hot;
- the claim (what for, who, which pane, since when) with Release.

API availability and host/GPU telemetry are independent. An API can serve models while `nvidia-smi` fails: the models stay visible alongside `GPU telemetry unavailable` and the NVML error. This does not tell us whether inference runs on the GPU or CPU. An unavailable Ollama or host shows its reason; claims remain visible in every state.

Each remote machine has Terminal: it opens a tab in the active project that runs `ssh -- <alias>`, since every fix (a reboot, `ollama serve`, an install) starts with a shell there. The tab is saved with its target, so it comes back as the same ssh session, and Escape closes the popover before a focused terminal sees it.

The popover's text can be selected and copied; each line pastes as one line, without the button labels.

Manage opens Settings > Machines.

**Settings > Machines.** This tab is for setup only:

- the added machines, each with Remove;
- one field that takes the same sentence as the CLI (`athena`, `user@host`, `local`, `port 11435`);
- one-click Add for each known host and this machine ("this machine" always means this one, even with a `Host local` alias).

Listing the hosts connects to nothing.

## CLI

```
$ aya machines
athena  RTX 4090 GPU 97% VRAM 21.0/24.0 GiB  CPU 3.2/32  RAM 41.0/125.7 GiB  ssh:athena
        ollama 0.12.3
          qwen3:32b 19.6 GiB (reported by Ollama) hot until 23:12 (14 min)
        claimed by justi (pane "lead") since 22:40: run5 timed collection
laptop  Apple M2 Max  CPU 2.1/12  RAM 20.1/32.0 GiB  local
        ollama 0.12.3, no model loaded
        not claimed
mini    unreachable  ssh:mini  ssh: connect to host mini port 22: Operation timed out
        not claimed
checked 23:01:05
```

- `aya machines --json` returns the same data as JSON.
- `aya machines hosts [--json]` lists the known ssh hosts and which of them are added.
- `aya machines add "athena is the 4090 box, and this machine"` drafts by deterministic matching, with no model involved:
  - a known host or `user@host` becomes an ssh machine;
  - `local` or "this machine" becomes this machine; a `Host local` alias wins over the word `local`, never over "this machine";
  - `port N` sets the port of the machine named right before it; after a word Aya asks about or an unknown host, it sets nothing;
  - a word like "laptop" is asked about, never taken as local.

  Aya then probes the drafted machines and asks in its own Add / Cancel dialog. If the CLI stops waiting, Aya closes the dialog and adds nothing. Options such as `--ssh` are refused.
- `aya machines remove <id>` asks in Aya, like add.
- `aya machines claim <id> "<purpose>"` records who claimed the machine and when. The purpose is one line of plain text, at most 200 characters. It is refused while someone else holds the claim, unless `--replace` is given; agents never pass `--replace` without the user's yes. The holder may change its own claim.
- `aya machines release <id>` clears the claim.

There is no load or unload command.

Sizes are binary gibibytes everywhere in Aya (`electron/units.ts`, `src/units.ts`), labelled GiB: RAM and VRAM read as their spec says (128.0 GiB on a 128 GB Mac, 24.0 GiB on an RTX 4090). `ollama ps` counts decimal GB, so the same model shows 8.5 GiB here and 9.1 GB there; the label tells the units apart.

Per-model memory is labelled `reported by Ollama`: it comes from `/api/ps` and can understate actual GPU use. The machine's total VRAM use comes from `nvidia-smi`.

## Data

Ollama remains the default for existing version 1 registries. An optional `api: { baseUrl }` selects one OpenAI-compatible backend instead. Settings > Machines edits the backend, URL and bearer token. Model IDs from `GET /v1/models` are labelled `served by API`; the API does not report loaded memory or expiry.

Selecting OpenAI-compatible API with an empty URL starts read-only endpoint discovery for that machine. Local machines use loopback; SSH aliases are resolved by local `ssh -G`, using only the validated hostname. Discovery disables forwards, proxies, canonicalization and the shell used by `Match exec`; aliases depending on such commands need a manual URL. It checks HTTP `/v1/models` on ports 8080, 8000, 1234 and 5000, concurrently with a 1.5 s deadline and 256 KB response limit per port. It uses no token or browser cookies, follows no redirects, and never scans a subnet or reads server configuration.

A valid HTTP200 model list confirms an endpoint. HTTP401/403 is an unconfirmed candidate requiring authentication, not proof of API compatibility. One candidate of either kind automatically fills an untouched empty URL, without an extra selection click; an authentication candidate remains labelled compatibility unconfirmed and asks for a bearer token. Multiple results, or results arriving after credential edits, offer a choice. Editing the URL, changing backend/machine or closing settings ignores old results; editing credentials prevents automatic filling. A saved URL stays intact. Search again optionally retries discovery, and manual URL entry remains available. Discovery writes nothing: only Save backend applies the configuration.

Configure an existing machine with `aya machines configure darwine openai-compatible http://192.168.0.203:8080 --token-stdin`, piping the token into stdin from a trusted secret source. Never put it in the command arguments. Without `--token-stdin`, an existing token is kept only for the same normalized URL; a new URL starts without a token. `--clear-token` removes it. `aya machines configure darwine ollama 11434` restores Ollama.

Tokens are stored in `machines-auth.json` in the Aya config home, written atomically with mode 0600. They are bound to the machine and normalized API URL, absent from `machines.json`, setup, status and JSON replies, and removed when the machine is removed. The settings password field never receives a saved token. Local desktop setup metadata includes a masked `Saved token` preview generated in main: the first four characters followed by eight mask dots; tokens shorter than eight characters show only the fixed mask. The preview does not reveal the full token or its length, disappears for an edited URL, a different backend or a pending clear, and updates after replacing the token on Save. Public/windowless Web setup returns only whether a token is configured; the preview never enters the registry, status, CLI JSON, logs or cache keys. API probes have a timeout and response-size limit, follow no redirects, and report sanitized errors rather than response bodies.

Known network errors are shown as `API host unreachable` or `API network access denied`. On macOS, a LAN API with either error offers `Privacy & Security settings` and the path `Privacy & Security → Local Network`. The button opens the parent pane: the direct Local Network anchor did not reach the intended page on macOS 26.6. This is a repair suggestion, not a claim that macOS permissions are definitely the cause; Aya never changes the permission. API availability refreshes when Aya regains focus.

Electron main probes use Chromium's `net.fetch`, the application's network transport. Plain Node tools use Node fetch. The API request sends the configured bearer header and omits browser cookies; both transports retain the same deadline, response limit and redirect prohibition.

`machines.json` lives in the Aya config home (`~/.aya`), mode 0600:

```json
{"version": 1, "machines": [{"id": "athena", "reach": {"ssh": "athena"},
  "ollama": {"port": 11434},
  "claim": {"by": "justi", "pane": "lead", "purpose": "run5", "since": "..."}}]}
```

- Only Aya's main process writes the file: one change at a time, then an atomic write.
- A file that is not JSON, has another `version`, or has a malformed machine is never rewritten; commands say why.
- A model whose `expiresAt` is past the year 2100 shows as `pinned`.

## Probes

Locally and over ssh alike, `sh -s` reads one fixed script on stdin. The only thing substituted into it is the validated Ollama port. The script reads:

- the CPU name;
- `nproc`, the load average and memory, from `/proc` on Linux or `sysctl` and `vm_stat` on macOS;
- `nvidia-smi` if present; only well-formed rows are GPUs, and anything else it prints is kept as its failure;
- whether an `ollama` binary or Ollama.app is in its usual places (ssh's `sh -s` has no Homebrew on its PATH) and whether an `ollama` process runs, so a silent port reads as `not installed`, `not running` or `not answering`;
- `curl -q -s --noproxy '*' -X GET` to `127.0.0.1:<port>/api/version` and `/api/ps`. `-q` comes first, so the host's `~/.curlrc` cannot add a body, a method or a proxy.

Marker lines separate the sections, so a missing tool leaves an empty section, not a parse error.

The ssh call looks like this:

```
ssh -o BatchMode=yes -o ConnectTimeout=5 -o ClearAllForwardings=yes -o PermitLocalCommand=no \
  -o ForwardAgent=no -o ForwardX11=no -o ControlMaster=no -o ControlPath=none -o Tunnel=no \
  -o RequestTTY=no -- <target> sh -s
```

The target never starts with `-`. Remote projects keep their own ssh call, which these options do not change.

Limits:

- Text from a host (model names, ssh errors) and from `~/.ssh/config` reaches the terminal with every control character shown as its `\uXXXX` escape, as in every reply Aya's CLI prints, so it can neither redraw the screen nor pass for an Aya OSC signal from the pane that ran the command.
- An `/api/ps` entry that is not an object is skipped; one odd answer never hides the other machines.
- `~/.ssh/config` and its Includes are read only as regular files up to 1 MB.
- After 10 s the probe's process group gets SIGKILL, and the machine shows as unreachable with the reason.
- If `/api/version` answers but `/api/ps` does not, the models show as "unavailable", never as "no model loaded".
- Each machine has one probe in flight, shared by every caller and cached for 3 s.

## Security

- SSH authentication stays with the user's agent and config; API bearer tokens use the separate private store described above.
- No listener and no forward is opened.

## Later

Reservations that Aya enforces, or a proxy in front of Ollama, would come only after a test shows they work. Any later listener would bind `127.0.0.1` only.
