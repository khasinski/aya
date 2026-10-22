// Usage and agent-hook IPC (electron/ipc/usage-ipc.ts). The install and uninstall handlers write the user's agent
// settings, so this test only checks what is registered and how the status is put together.

import { test } from "node:test";
import assert from "node:assert/strict";

const { registerUsageIpc, withCodexStatus } = await import("../dist-electron/ipc/usage-ipc.js");

test("registers exactly the usage and hook channels", () => {
  const channels = [];
  registerUsageIpc({ handle: (channel) => channels.push(channel) });
  assert.deepEqual(channels.sort(), [
    "status-hook:install",
    "status-hook:status",
    "status-hook:uninstall",
    "usage-hook:install",
    "usage-hook:status",
    "usage-hook:uninstall",
    "usage:get",
    "usage:get-antigravity",
    "usage:get-codex",
    "usage:get-grok",
  ]);
});

test("the automatic-status answer is Claude's, with only Codex's configured, conflict and configPath beside it", () => {
  const claude = { installed: true, scriptPath: "/s" };
  const codex = { configured: true, conflict: "notify", configPath: "/c/config.toml", extra: "not passed on" };
  assert.deepEqual(withCodexStatus(claude, codex), {
    installed: true,
    scriptPath: "/s",
    codex: { configured: true, conflict: "notify", configPath: "/c/config.toml" },
  });
});
