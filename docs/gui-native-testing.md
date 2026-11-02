# Conversation GUI integration checks

Run `npm run test:gui-native` to build the adapter and test it against the installed
Codex, Claude Code, Pi and Antigravity CLIs. This is separate from `npm test`: it
uses the machine's configured accounts and providers, including real model calls.
It does not start a browser or an interactive sign-in flow.

The test uses a temporary `AYA_HOME` and a fresh workspace for each case. It leaves
`HOME` unchanged so each CLI can use its existing login. Prompts only ask for short
marker replies and `printf`/`sleep` commands. Permission callbacks only approve
those exact commands. The report is checkpointed after every case in `test-results/reliability/gui-native-smoke.json`; `complete: true` marks a finished run.

Examples:

```sh
npm run test:gui-native
npm run test:gui-native -- --agents=codex,claude --cases=login,resume,steer,stop
npm run test:gui-native -- --agents=pi,antigravity --cases=permissions
```

The checks cover:

- Existing login works through the actual GUI adapter.
- Closing and resuming the native session preserves a randomly generated code.
- Permission requests round-trip through the adapter; skip permissions avoids them.
- Steering changes the answer within the running turn when the transport supports it.
- Stop produces an interrupted turn rather than success or a generic failure.
- Side questions return the native side answer when supported.

Unsupported operations must be rejected without starting a different kind of turn
and must be absent from the GUI controls. They are recorded explicitly in the
report, rather than being simulated by fixtures.

## Transport differences

- Codex uses app-server RPC, including turn IDs for steering and interruption.
- Claude Code side-question text is returned in the control response's `response`
  field. Compaction is a `/compact` user message, not a `compact` control request.
  A result with `terminal_reason: aborted_streaming` is an interruption.
- Pi GUI requires Pi 0.80.4 or newer. `agent_end` only ends a low-level run;
  `agent_settled` is the authoritative idle event. Extension-handled prompts may
  acknowledge `disposition: handled` without starting any run.
- Antigravity's stream-json/headless transport does not support `/btw`, in-flight
  steering, or interactive permission replies. Aya offers queued messages instead
  of steering, reports denied actions as failed turns, and offers reconnect after
  a permission-setting change. Stop sends SIGINT, which the CLI reports with
  `finished_reason: interrupted`. Aya never treats a terminal `denied_actions`
  record as a pending approval it can answer through a nonexistent RPC.

The ordinary Electron e2e tests cover the UI with controlled agent fixtures:
reconnect preserving drafts/queues/artifacts, save failure and retry, command
availability, and large widget collections surviving cache eviction and reload.
