// The spawn's "is the CLI installed" check reads a relative PATH entry (node_modules/.bin)
// where the pane runs, as the pane's own shell does - not in Aya's working directory.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = realpathSync(mkdtempSync(join(tmpdir(), "aya-preflight-cwd-")));
const withCli = join(root, "project-with");
const without = join(root, "project-without");
const home = join(root, "home");
for (const dir of [join(withCli, "node_modules", ".bin"), without, home]) mkdirSync(dir, { recursive: true });
const cli = `cli-${process.pid}`;
writeFileSync(join(withCli, "node_modules", ".bin", cli), "#!/bin/sh\nexec sleep 30\n");
chmodSync(join(withCli, "node_modules", ".bin", cli), 0o755);
process.env.AYA_HOME = join(root, "aya-home");
process.env.HOME = home;
process.env.SHELL = "/bin/sh";
process.env.PATH = "node_modules/.bin:/usr/bin:/bin";

const { killPty, spawnPty } = await import("../dist-electron/pty.js");

async function spawnIn(cwd, ptyId) {
  const events = [];
  const sink = { sendPtyEvent: (e) => events.push(e), isDestroyed: () => false };
  await spawnPty({ ptyId, command: cli, cwd, cols: 80, rows: 24 }, sink);
  killPty(ptyId);
  return events.find((e) => e.type === "spawn-failed")?.reason ?? "started";
}

test("pane dir has the CLI in node_modules/.bin -> starts", async () => {
  assert.equal(await spawnIn(withCli, "with"), "started");
});

test("pane dir without it -> command not found", async () => {
  assert.equal(await spawnIn(without, "without"), "command-not-found");
});

test.after(() => rmSync(root, { recursive: true, force: true }));
