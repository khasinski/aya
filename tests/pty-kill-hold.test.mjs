// A killed pane is gone at once for the hold check, even when its process outlives
// the signal: a team send must not type into a pane the user just closed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = realpathSync(mkdtempSync(join(tmpdir(), "aya-kh-")));
const home = join(root, "home");
mkdirSync(home);
process.env.AYA_HOME = root;
process.env.HOME = home;

const { killPty, spawnPty } = await import("../dist-electron/pty.js");
const { paneHold } = await import("../dist-electron/vt-state.js");
const { HOLD_NOT_RUNNING } = await import("../dist-electron/pane-holds.js");

test("killPty, then an immediate hold check: not running, although the process ignores SIGTERM", async () => {
  const sink = { sendPtyEvent() {}, isDestroyed: () => false };
  const ptyId = "kill-then-hold";
  await spawnPty({ ptyId, command: "trap '' TERM HUP; exec sleep 30", cwd: root, cols: 80, rows: 24 }, sink);
  assert.notEqual(await paneHold(ptyId), HOLD_NOT_RUNNING, "a live pane has a mirror");
  killPty(ptyId);
  assert.equal(await paneHold(ptyId), HOLD_NOT_RUNNING);
  killPty(ptyId);
});
