# Aya Native (Swift) — experiment

Native macOS frontend against the SAME backend as the Electron app: the
detached PTY host and the `~/.aya`-style config files. The wire contract is
documented in `docs/pty-host-protocol.md` — this app is a second client of
that protocol, not a fork of the backend.

## Run it

```sh
native/run-dev.sh
```

First run seeds an isolated world in `~/.aya-native` (own PTY host, own
presets, a `playground` project with two shells and a claude tab) — it cannot
touch your real `~/.aya` sessions. The host outlives the app: quit the app,
relaunch, and the same sessions replay (the Electron dead-tab semantics —
`attachOnly` + `no-session` — drive the attach flow).

To point it at another backend instead (plain `AYA_HOME` is deliberately
ignored - Aya's own terminals export it pointing at the live `~/.aya`, and
both the script and the app hard-refuse to run against that):

```sh
AYA_NATIVE_HOME=~/.aya-dev native/run-dev.sh
```

Two frontends can share one backend live (events are broadcast to every
connected client) — running this app and an Electron Aya on the same AYA_HOME
side by side is the intended experiment.

## Layout

- `Sources/AyaKit` — backend client, no UI: unix-socket protocol client
  (`PtyHostClient`), config models (`AyaConfig`). The part worth keeping
  regardless of what the UI becomes.
- `Sources/AyaNative` — AppKit shell: sidebar (projects/tabs), one SwiftTerm
  pane per tab kept warm in a dictionary, wiring to the client.
- `Tests/AyaKitTests` — integration test against a real node PTY host
  (needs `dist-electron` built: `npm run build:electron`).

## v0 scope (deliberate)

In: attach/replay, fresh spawn, typing, resize, exit banner + Enter-to-restart,
multiple tabs, warm panes, host version in the status bar.
Out (v1+): splits, find, snippets, themes from themes.json, config writes,
restart-with-resume semantics (today those live in the Electron renderer;
the experiment's thesis is that they belong in the host — see the protocol doc).
