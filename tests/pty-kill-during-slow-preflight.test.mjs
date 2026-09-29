// A kill must cancel its in-flight spawn however long the preflight takes: a
// slow shell startup (command probe) plus a lookup that runs to its timeout
// outlast any fixed-lifetime kill marker.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = realpathSync(mkdtempSync(join(tmpdir(), "aya-kill-slow-")));
const bin = join(root, "bin");
const cwd = join(root, "wt");
const home = join(root, "home");
for (const dir of [bin, cwd, home]) mkdirSync(dir);
const lookups = join(root, "lookups");
writeFileSync(
  join(bin, "opencode"),
  `#!/bin/sh\nif [ "$1" = session ]; then touch '${lookups}'; fi\nexec sleep 30\n`,
);
chmodSync(join(bin, "opencode"), 0o755);
writeFileSync(join(home, ".profile"), "sleep 2\n");
process.env.AYA_HOME = join(root, "aya-home");
process.env.HOME = home;
process.env.XDG_DATA_HOME = join(root, "xdg-data");
process.env.SHELL = "/bin/sh";
process.env.PATH = `${bin}:/usr/bin:/bin`;

const { activePtyCount, killPty, spawnPty } = await import("../dist-electron/pty.js");

test("a kill during a slow command probe cancels the spawn, and the lookup never runs", async () => {
  const sink = { sendPtyEvent() {}, isDestroyed: () => false };
  const ptyId = "kill-slow-preflight";
  const spawning = spawnPty({ ptyId, command: "opencode --continue", cwd, cols: 80, rows: 24 }, sink);
  await new Promise((r) => setTimeout(r, 300));
  killPty(ptyId);
  await spawning;
  const started = activePtyCount();
  if (started) killPty(ptyId);
  assert.equal(started, 0, "no child may outlive the closed tab");
  assert.equal(existsSync(lookups), false);
});
