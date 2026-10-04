// The spawn log line carries the pane's command, clamped: a command is unbounded user input.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = realpathSync(mkdtempSync(join(tmpdir(), "aya-spawn-log-")));
const cwd = join(root, "wt");
mkdirSync(cwd);
mkdirSync(join(root, "home"));
process.env.AYA_HOME = join(root, "aya-home");
process.env.HOME = join(root, "home");
process.env.SHELL = "/bin/sh";
process.env.PATH = "/usr/bin:/bin";

const { killPty, spawnPty, SPAWN_LOG_COMMAND_MAX_CHARS } = await import("../dist-electron/pty.js");

const sink = { sendPtyEvent() {}, isDestroyed: () => false };

async function loggedCommand(ptyId, command) {
  await spawnPty({ ptyId, command, cwd, cols: 80, rows: 24 }, sink);
  killPty(ptyId);
  const log = readFileSync(join(process.env.AYA_HOME, "pty-events.log"), "utf8");
  const line = log.split("\n").map((l) => (l ? JSON.parse(l) : null)).find((e) => e?.ev === "spawn" && e.ptyId === ptyId);
  assert.ok(line, `no spawn line for ${ptyId}`);
  return line.command;
}

test("a command past the clamp is logged at exactly SPAWN_LOG_COMMAND_MAX_CHARS, a short one whole", async () => {
  assert.equal(SPAWN_LOG_COMMAND_MAX_CHARS, 4096);
  const over = await loggedCommand("log-over", "sleep 5 #" + "a".repeat(SPAWN_LOG_COMMAND_MAX_CHARS));
  assert.equal(over.length, SPAWN_LOG_COMMAND_MAX_CHARS);
  const shortCommand = await loggedCommand("log-short", "sleep 5 #short");
  assert.match(shortCommand, /sleep 5 #short$/);
});
