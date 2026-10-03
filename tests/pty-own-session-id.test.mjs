// A fresh grok pane gets its own --session-id; the tab hears it at spawn, before the CLI writes
// anything, so a restart right away resumes it. HOME and AYA_HOME are fake; "grok" is a stub.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = realpathSync(mkdtempSync(join(tmpdir(), "aya-own-session-")));
process.env.AYA_HOME = join(root, "aya-home");
process.env.HOME = join(root, "home");
const bin = join(root, "bin");
for (const dir of [process.env.HOME, bin, join(root, "grok-home")]) mkdirSync(dir);
writeFileSync(join(bin, "grok"), "#!/bin/sh\nexec sleep 30\n");
chmodSync(join(bin, "grok"), 0o755);
process.env.PATH = `${bin}:/usr/bin:/bin`;
process.env.SHELL = "/bin/sh";

const { spawnPty, killPty } = await import("../dist-electron/pty.js");
const { fakeSink, waitFor } = await import("./helpers/pty-host.mjs");

test("a fresh grok pane reports its own session id at spawn", async (t) => {
  const sink = fakeSink();
  const ptyId = "own-session-grok";
  t.after(() => killPty(ptyId));
  await spawnPty({ ptyId, command: "grok", agent: "grok", agentConfigDir: join(root, "grok-home"), cwd: root, cols: 80, rows: 24 }, sink);
  const event = await waitFor(() => sink.events.find((e) => e.type === "osc-session"), 3_000);
  assert.match(event.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});
