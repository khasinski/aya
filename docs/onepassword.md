# 1Password CLI sessions for agents

An agent may give each shell tool call a new pseudo-terminal. 1Password CLI
identifies a macOS/Linux session by its terminal and start time, so an `op`
call in each new tool terminal can trigger another biometric prompt even
though the agent is still in one Aya panel.

Aya's optional session parent runs the real `op` with the panel's original
controlling terminal. Calls from the agent's tool terminals reach that parent
through a private local socket. Different panels have separate parents and
approvals. Closing/restarting the agent ends the session and removes its shim
and socket. There is no automatic retry of a disconnected command.

## Enable for a preset

Prefix the preset's command in Settings with `AYA_OP_SESSION=1`:

```sh
AYA_OP_SESSION=1 claude
AYA_OP_SESSION=1 codex
```

Restart the panel. Aya still detects the original agent for session resume,
Teams and screen rules; the parent is added after those launch decisions.
This option is supported on macOS and Linux. Existing presets are unchanged.

For a standalone command in a shell panel, use:

```sh
aya op-session -- claude
```

The session launcher must start in a real terminal. Run it when starting the
agent, rather than asking an already running agent to start it in a tool call.

## What is remembered

The first `op` access still asks for consent. 1Password owns that consent:
locking 1Password revokes it; its CLI session expires after 10 minutes of
inactivity and has a 12-hour maximum. Aya neither stores credentials nor
extends those limits. It does not use a service account or export vault data
to a cache.

The session supports read-only `op read op://…`, `item get/list`,
`vault get/list`, `account get/list` and `whoami` commands. Common long options
such as `--account`, `--vault`, `--fields`, `--format` and `--reveal` work.
Commands that execute programs (`op run`, plugins), write files (`--out-file`),
change configuration or mutate vaults are refused: this session parent runs
outside the agent tool's sandbox. Run those directly in your terminal.
Caller-provided environment variables cannot change the executable, preload
libraries or shell configuration. Only OP_ACCOUNT is forwarded per call.

Arguments, stdin and stdout/stderr pass through to the CLI. Secret output is
sent directly back to the requesting process, not through Aya's control API,
terminal scrollback or debug log. The agent itself can still record the output
in its normal tool history. Only an executable shim and Unix socket are written
to a private temporary directory (0700, socket 0600); its capability is kept in
the session's environment.

The wrapper catches `op` resolved through its PATH shim. An absolute invocation
such as `/opt/homebrew/bin/op`, a shell configuration that replaces PATH, or a
sandbox that blocks the local socket bypasses or prevents it. It fails visibly
if its session is gone; it does not silently run a second authenticated request.


## Verification

`tests/op-session.test.mjs` uses a stand-in CLI and agent. The agent creates a
new controlling terminal for each command; the test verifies that the actual
CLI runs in the original parent terminal, preserves args/stdin and cleans up
on exit. No test reads a real vault or opens biometric prompts.

Real 1Password biometric reuse still needs a manual check with the installed
CLI and agent: run two harmless `op vault list --format=json >/dev/null` calls in separate agent tool calls
and confirm the second does not ask again. Do not print secrets for this test.

Reference: https://www.1password.dev/cli/app-integration-security
