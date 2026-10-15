// A preset edit does not change the agent/config identity of a process that survived the app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "aya-replay-metadata-"));
process.env.AYA_HOME = root;
const { spawnPty, killPty } = await import("../dist-electron/pty-core.js");
test("replay carries the original spawn request; a respawn carries its new request", async () => {
  const replayed = [], sink = { sendPtyEvent() {}, isDestroyed: () => false };
  let prepared = 0;
  const services = {
    prepare: async (req, cwd) => {
      prepared++;
      return { argv: ["/bin/sh", "-c", "cat"], env: { PATH: "/usr/bin:/bin", TERM: "xterm-256color" },
        command: req.command, launch: { command: req.command, cwd }, ownSessionId: null, spawnedAt: Date.now() };
    },
    replay: (req) => { replayed.push(req); },
  };
  const original = { ptyId: "kept", agent: "codex", agentConfigDir: "/original", command: "codex", cwd: root, cols: 80, rows: 24 };
  const edited = { ...original, agent: "claude", agentConfigDir: "/edited", command: "claude" };
  try {
    await spawnPty(original, sink, services);
    await spawnPty({ ...edited, attachOnly: true }, sink, services);
    assert.equal(prepared, 1, "attaching does no agent preparation");
    assert.deepEqual(replayed, [original], "session watchers use the process's original agent and config");
    killPty(original.ptyId);
    await spawnPty(edited, sink, services);
    await spawnPty({ ...original, attachOnly: true }, sink, services);
    assert.equal(prepared, 2);
    assert.deepEqual(replayed, [original, edited], "the successor uses its own metadata");
  } finally {
    killPty(original.ptyId);
    rmSync(root, { recursive: true, force: true });
  }
});
