import { test } from "node:test";
import assert from "node:assert/strict";

const { parseRemoteTerminalRequest, REMOTE_TERMINAL_REPLAY_MAX_BYTES } = await import("../dist-electron/remote-protocol.js");

test("remote terminal protocol accepts only bounded, exact v2 frames", () => {
  assert.equal(REMOTE_TERMINAL_REPLAY_MAX_BYTES, 1_048_576);
  assert.deepEqual(parseRemoteTerminalRequest({ type: "session:open", protocol: 2, id: "open-1" }), { type: "session:open", protocol: 2, id: "open-1" });
  assert.deepEqual(parseRemoteTerminalRequest({ type: "pty:spawn", protocol: 2, id: "spawn-1", project: "repo", preset: "shell", cols: 80, rows: 24 }), {
    type: "pty:spawn", protocol: 2, id: "spawn-1", project: "repo", preset: "shell", cols: 80, rows: 24,
  });
  assert.deepEqual(parseRemoteTerminalRequest({ type: "pty:spawn", protocol: 2, id: "spawn-2", project: "repo", preset: "shell", cols: 80, rows: 24, terminalId: "stable-tab-id" }), {
    type: "pty:spawn", protocol: 2, id: "spawn-2", project: "repo", preset: "shell", cols: 80, rows: 24, terminalId: "stable-tab-id",
  });
  assert.deepEqual(parseRemoteTerminalRequest({ type: "pty:attach", protocol: 2, id: "attach-1", terminalId: "t1", offset: 123 }), {
    type: "pty:attach", protocol: 2, id: "attach-1", terminalId: "t1", offset: 123,
  });
  assert.equal(parseRemoteTerminalRequest({ type: "pty:spawn", protocol: 1, id: "old", project: "repo", preset: "shell", cols: 80, rows: 24 }), null);
  assert.equal(parseRemoteTerminalRequest({ type: "pty:spawn", protocol: 2, id: "bad", project: "repo", preset: "shell", cols: 0, rows: 24 }), null);
  assert.equal(parseRemoteTerminalRequest({ type: "pty:spawn", protocol: 2, id: "bad", project: "repo", preset: "shell", command: "sh -c whoami", cols: 80, rows: 24 }), null);
  assert.equal(parseRemoteTerminalRequest({ type: "pty:spawn", protocol: 2, id: "bad", project: "repo", preset: "shell", cols: 80, rows: 24, terminalId: "x".repeat(129) }), null);
  assert.equal(parseRemoteTerminalRequest({ type: "pty:write", protocol: 2, id: "large", terminalId: "t1", data: "x".repeat(256 * 1024 + 1) }), null);
});
