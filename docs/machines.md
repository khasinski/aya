# Machines

One list of the user's own machines running Ollama, for any pane, team or not.
Aya shows each one's state and who claimed it. It never loads, unloads or calls a model.

## Why

An 8-hour measurement run by a team lead lost time in three ways:

1. The run moved to the laptop, and each call was about 6x slower. Nothing showed which machine had which model hot.
2. A reviewer model shared the GPU with a timed run. Nothing showed that the GPU was busy, or with what.
3. Models were unloaded by hand (`keep_alive 0`) while someone else was using them.

So the first need is to see every machine at a glance and to say who is using one.

## Rules

1. **App-level.** Machines are not part of teams and are not tied to roles.
2. **Ollama only.** A machine is `local`, or reached over ssh by a `Host` alias from `~/.ssh/config`, a remote project's target, or `user@host`. Nothing is installed on the host, and Ollama is never exposed on the network.
3. **Read-only probes.** Status comes from a fixed read-only script, run over ssh with no forwards and no tunnels, and with no writes on the host.
4. **Only the user adds a machine.** In Aya, the click is the yes. `aya machines add` from a pane asks in Aya's own dialog, and the caller has no flag that saves.
5. **No model control.** Aya never loads, unloads or calls a model. A claim is advisory and never counts as approval to unload.
6. **Facts only.** Messages state facts. A refusal never suggests "use the laptop": a hot model on a slower machine is not a fast alternative.
7. **Versioned JSON.** Fields are added when a feature ships, not reserved in advance.

## Where you see it

**Status bar.** Once a machine is added, the status bar shows one machines icon, so six machines never fill the bar. Its tooltip and accessible name say each machine's state in words, for example `Machines: athena ready, claimed; mini unreachable`. With no machine added, there is no icon. The item polls every 30 s while Aya is visible; a slow answer that arrives after a newer one is dropped.

**Popover.** Clicking the item opens a popover with one entry per machine:

- name, GPU (or CPU) model, and state: Ready, GPU error, Ollama down or Unreachable;
- GPU use and VRAM, or CPU load and RAM when there is no NVIDIA GPU, plus how the machine is reached;
- when `nvidia-smi` fails (say, a driver that does not match its library), its message: the card is there, but Ollama runs on the CPU;
- each loaded model with its size and how long it stays hot;
- the claim (what for, who, which pane, since when) with Release.

Manage opens Settings > Machines.

**Settings > Machines.** This tab is for setup only:

- the added machines, each with Remove;
- one field that takes the same sentence as the CLI (`athena`, `user@host`, `local`, `port 11435`);
- one-click Add for each known host and this machine ("this machine" always means this one, even with a `Host local` alias).

Listing the hosts connects to nothing.

## CLI

```
$ aya machines
athena  RTX 4090 GPU 97% VRAM 21.0/24.0 GB  CPU 3.2/32  RAM 41.0/125.7 GB  ssh:athena
        ollama 0.12.3
          qwen3:32b 19.6 GB hot until 23:12 (14 min)
        claimed by justi (pane "lead") since 22:40: run5 timed collection
laptop  Apple M2 Max  CPU 2.1/12  RAM 20.1/32.0 GB  local
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

## Data

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

- Text from a host (model names, ssh errors) and from `~/.ssh/config` reaches the terminal with every control character replaced by `?`, so it can neither redraw the screen nor pass for an Aya OSC signal from the pane that ran the command.
- An `/api/ps` entry that is not an object is skipped; one odd answer never hides the other machines.
- `~/.ssh/config` and its Includes are read only as regular files up to 1 MB.
- After 10 s the probe's process group gets SIGKILL, and the machine shows as unreachable with the reason.
- If `/api/version` answers but `/api/ps` does not, the models show as "unavailable", never as "no model loaded".
- Each machine has one probe in flight, shared by every caller and cached for 3 s.

## Security

- Aya stores no keys or passwords; ssh authentication stays with the user's agent and config.
- No listener and no forward is opened.

## Later

Reservations that Aya enforces, or a proxy in front of Ollama, would come only after a test shows they work. Any later listener would bind `127.0.0.1` only.
