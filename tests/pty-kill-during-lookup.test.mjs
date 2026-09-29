// Closing a tab while its spawn is still in its async preflight (the command
// probe, opencode's session lookup) must not leave a child behind: the kill
// finds no PTY yet, so the spawn has to notice it before starting one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = realpathSync(mkdtempSync(join(tmpdir(), "aya-kill-lookup-")));
const bin = join(root, "bin");
const cwd = join(root, "wt");
mkdirSync(bin);
mkdirSync(cwd);
mkdirSync(join(root, "home"));
writeFileSync(
  join(bin, "opencode"),
  '#!/bin/sh\nif [ "$1" = session ]; then sleep 1; echo "[]"; exit 0; fi\nexec sleep 30\n',
);
chmodSync(join(bin, "opencode"), 0o755);
process.env.AYA_HOME = join(root, "aya-home");
process.env.HOME = join(root, "home");
process.env.XDG_DATA_HOME = join(root, "xdg-data");
process.env.SHELL = "/bin/sh";
process.env.PATH = `${bin}:/usr/bin:/bin`;

const { activePtyCount, killPty, spawnPty } = await import("../dist-electron/pty.js");

test("a kill that lands during the opencode lookup stops the spawn", async () => {
  const sink = { events: [], sendPtyEvent(e) { this.events.push(e); }, isDestroyed: () => false };
  const ptyId = "kill-during-lookup";
  const spawning = spawnPty({ ptyId, command: "opencode --continue", cwd, cols: 80, rows: 24 }, sink);
  await new Promise((r) => setTimeout(r, 300));
  killPty(ptyId);
  await spawning;
  const log = readFileSync(join(process.env.AYA_HOME, "pty-events.log"), "utf8");
  const started = activePtyCount();
  if (started) killPty(ptyId);
  assert.equal(started, 0, "no child may outlive the closed tab");
  assert.doesNotMatch(log, /"ev":"spawn","ptyId":"kill-during-lookup"/);
  assert.match(log, /"ev":"spawn-dropped-pending-kill","ptyId":"kill-during-lookup"/);
});
