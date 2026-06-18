# Aya Remote Sessions Spec

Status: draft, exploratory. Phase 1 transport skeleton exists on the
`remote-stdio-bridge` branch: `aya remote --stdio` bridges to a host-local
`aya-remote.sock`, and the running Aya app serves a read-only `hello` +
workspace snapshot.

## Goal

Let one Aya app show both local Aya projects and projects hosted by remote Aya
instances. A user should be able to connect to another machine, see its
projects, tabs, splits, terminal buffers, and terminal status, then optionally
control those terminals from the local app.

The core value is continuity across computers:

- Desktop Aya keeps long-lived terminals running.
- Laptop Aya connects to the desktop.
- The laptop shows the desktop's Aya projects alongside local projects.
- Selecting a remote project feels like selecting any other project, with clear
  visual indication that the terminals are remote.

## Product Model

Remote sessions are host-owned. The remote machine keeps ownership of:

- PTY processes.
- Project config and tab layout.
- Split layout and active terminal selection.
- Terminal output buffers.
- Agent status, bell, exit state, and spawn failures.
- Host-local snippets/settings that affect terminal behavior.

The local app is a client:

- It renders a synchronized view of the remote host's state.
- It sends user commands to the host.
- It does not directly edit remote config files.
- It can disconnect without killing remote terminals.

## Mixed Local And Remote Workspace

Aya should not force a separate "remote mode" screen. Local and remote projects
should coexist in the same app shell.

### Project List

The sidebar should contain both local and remote projects:

- Local projects keep the current visual treatment.
- Remote projects get an orange accent/highlight.
- Remote projects show a small remote-machine icon near the project name.
- The remote host name should be visible in a compact way, for example
  `workstation`, `mini`, or `devbox`.

Suggested treatment:

- Orange left rail or project-row accent for remote projects.
- Small icon such as `cloud`, `lan`, `computer`, or `terminal` with a tooltip:
  `Remote: workstation`.
- Remote status badge if disconnected, reconnecting, or read-only.

Remote highlighting must be subtle but unmistakable. The user should never
confuse a shell running on a remote machine with a local shell.

### Tabs And Terminal Panes

Remote tabs and terminal panes should also carry source identity:

- Small remote icon in each remote tab header.
- Orange-tinted active indicator for remote terminal panes.
- Tooltip/title text showing `Remote: host-name`.
- Optional host label in the pane header when there is enough room.

The tab icon matters because a mixed project/sidebar view is not enough once
the user is focused inside a terminal.

### Scope Boundaries

For v1, remote projects should remain grouped by their owning host. Avoid
mixing local and remote terminals inside the same project/split layout until
the semantics are clearer.

Allowed:

- Local project A.
- Remote host `desktop` project B.
- Remote host `server` project C.
- Switching between all three in the same sidebar/app.

Deferred:

- One project containing both local and remote tabs.
- Dragging a terminal from one host into another host's split.
- Moving PTYs between hosts.

## Connection Model

The primary setup should be in-app, not a manual terminal command.

User flow:

1. User clicks `Connect`.
2. Aya shows a compact form with:
   - `Username`, pre-filled with the current local OS username.
   - `Hostname`, empty or selectable from previously seen machines.
3. User enters the hostname and confirms.
4. Aya automatically tries SSH for that pair:

   ```bash
   ssh username@hostname aya remote
   ```

5. If the remote machine has Aya running and remote access enabled, the
   command sets up the bridge/pairing automatically.
6. The remote host is saved for future use.

This gives users the right mental model: connect to a machine, not configure
network plumbing.

### Preferred SSH Bridge

The first implementation should use an SSH-backed bridge rather than asking
users to create tunnels manually.

Local Aya runs:

```bash
ssh username@hostname aya remote --stdio
```

Remote side:

```text
ssh session -> aya remote CLI -> remote Aya host-local remote socket -> remote PTYs/state
```

The `aya remote` CLI should be a bridge to the already-running remote Aya app.
It should not become the remote app itself and should not create independent
project/session state.

Benefits:

- No public TCP listener.
- No manual port forwarding.
- SSH handles encryption and machine/user authentication.
- Works with normal `~/.ssh/config`, host aliases, keys, agents, bastions, and
  known-host verification.
- Remote Aya can keep its server bound to a local socket or localhost-only API.

Manual SSH tunneling can remain a fallback/debug path:

```bash
ssh -L 8787:localhost:8787 username@hostname
```

Later LAN pairing can add:

- Explicit "Enable LAN remote access" setting.
- TLS.
- Trusted client keys.
- Client revoke/disconnect UI.
- Connected-client list on the host.

Remote access must be disabled by default.

### Enabling Remote On A Host

When the user enables remote access on a machine, Aya should run a host
readiness check before declaring the machine connectable.

Checks:

- `aya remote` CLI is installed and available to SSH sessions.
- Remote Aya app is running and can be reached through its local socket/API.
- Remote access is enabled in Aya settings.
- An SSH server is installed.
- The SSH server appears to be running/listening.
- The current user can be reached over SSH, or Aya can at least show the
  expected `username@hostname` value for another machine to try.

If no SSH server is found, Aya should not silently enable remote. It should
show a clear setup prompt:

- macOS: suggest enabling `Remote Login` in System Settings.
- Linux: suggest installing and starting OpenSSH server, using the distro's
  package manager where detectable.
- Windows: suggest installing/enabling OpenSSH Server from Windows Optional
  Features or PowerShell.

The prompt should explain that Aya uses SSH for authentication and encryption,
and that Aya does not need a public TCP listener when the SSH bridge is used.

Suggested wording:

```text
SSH server not detected

Aya remote connections use SSH. Install or enable an SSH server on this
machine, then try enabling remote access again.
```

When possible, include a copyable command or system setting shortcut, but avoid
running privileged installation commands automatically.

### Saved Machines

Aya should save previously seen remote machines for quick reconnect.

Stored fields:

- Hostname or SSH alias.
- Username.
- Display name, defaulting to hostname.
- Last successful connection time.
- Last connection status/error.
- Remote host id/fingerprint after first successful pairing.

Connect UI behavior:

- Username defaults to the current local OS username.
- Recently connected machines appear as selectable rows.
- Selecting a saved machine fills username + hostname.
- Failed machines remain visible with the last error until removed.
- Users can remove saved machines and revoke trusted pairing data.

Saved machines should not store SSH passwords. Authentication should rely on
the user's SSH setup: keys, ssh-agent, host aliases, and platform prompts.

### Failure Handling

The automatic SSH setup should return clear errors:

- SSH executable not found.
- Host unreachable.
- SSH authentication failed.
- Host key verification failed.
- `aya` command not found on remote host.
- Remote Aya app not running.
- Remote access disabled on host.
- Protocol version mismatch.
- Pairing denied or timed out.

Errors should be actionable in the Connect UI and not require reading terminal
logs.

## Protocol Shape

Use a host-authoritative protocol with an initial snapshot plus live events.

Initial snapshot:

- Host id/name.
- Aya version and protocol version.
- Projects.
- Tabs and split layouts.
- Terminal metadata.
- Current active selections.
- Recent buffered terminal output.
- Connection permissions: read-only or control.

Live event stream:

- PTY output chunks.
- Terminal status changes.
- Spawn/exit/failure events.
- Project/tab/split changes.
- Git/status/snippet changes.
- Host disconnect/reconnect state.

Command stream:

- PTY write.
- PTY resize.
- Spawn/restart/kill terminal.
- Focus terminal.
- Open/close project.
- Create/rename/close tab.
- Send snippet.

WebSocket is the natural transport for terminal output and events. HTTP or RPC
over the same socket can handle commands.

## Terminal Rendering

Send raw PTY bytes from the host and render them locally with xterm.js.

Do not stream pixels/canvas. Raw bytes preserve:

- Text selection.
- Search.
- Copy/paste.
- Existing xterm rendering behavior.
- Lower bandwidth.

The host remains the source of truth for PTY lifetime. The client is only a
renderer/controller.

## Resize And Control Policy

Multiple clients can create conflicting terminal sizes and input streams. Start
simple:

- v1 supports one controlling client per remote host.
- Other clients are read-only viewers.
- The controlling client sends resize events.
- Host UI should show when a remote client has control.
- Host can revoke control.

Later:

- Per-terminal control handoff.
- Multi-client presence.
- Read-only collaboration.

## Security Requirements

Remote PTY control is equivalent to shell access. Treat it as high risk.

Requirements:

- Disabled by default.
- Localhost-only by default.
- Explicit user action to enable.
- Pairing token or one-time code.
- Persist trusted clients by public key/fingerprint, not reusable plaintext
  passwords.
- Clear connected-client indicator.
- Revoke/disconnect controls.
- Audit/event log for connects, disconnects, and control handoffs.
- Never expose unauthenticated terminal access.

Open questions:

- Whether remote snippets should be executable from clients by default.
- Whether clipboard paste should require confirmation in read/write sessions.
- Whether opening URLs should happen on the host or client.

## Reconnect Behavior

On disconnect:

- Remote projects remain visible but marked disconnected.
- Orange highlight remains, with a disconnected badge.
- Terminal panes show last known buffered output.
- Input is disabled.
- Aya attempts reconnect if configured.

On reconnect:

- Client requests a fresh snapshot.
- Host sends buffered output and current terminal metadata.
- Client reconciles by host terminal ids.

## Roadmap

### Phase 1: Read-Only Remote Viewer

- Host-local server on owner-only `aya-remote.sock`.
- SSH stdio workflow through `aya remote --stdio`.
- Pairing token.
- Initial project/state/preset snapshot. Done on `remote-stdio-bridge`.
- PTY output streaming.
- Local app renders remote projects in the normal sidebar.
- Orange remote highlight and small remote icon in project rows/tabs.

### Phase 2: Single-Client Control

- Keyboard input.
- Terminal resize forwarding.
- Restart/kill/spawn commands.
- Host-visible "remote client controlling" state.
- Control revoke.

### Phase 3: Full Remote Workspace Control

- Open/close remote projects.
- Rename/create/close remote tabs.
- Send remote snippets.
- Remote project search/status/git info.
- Persist trusted remote hosts in local Aya.

### Phase 4: LAN Pairing

- Optional LAN bind.
- TLS.
- Trusted client key management.
- Connected-client UI.

### Phase 5: Collaboration

- Multiple viewers.
- Control handoff.
- Presence.
- Per-terminal read/write permissions.

## Non-Goals For V1

- Public internet relay service.
- Pixel streaming.
- Moving running PTYs between machines.
- Merging local and remote terminals into the same split layout.
- Team collaboration semantics.
- Cloud account system.

## Key Design Principle

The local app can show many machines, but every terminal must make its host
identity obvious. Remote projects should feel integrated, not hidden in a
separate mode, while orange highlights and small remote icons keep the mental
model honest.
