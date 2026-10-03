// A pane still in its spawn preflight has no mirror yet: the host must say it is
// starting, not "not running" (which Start and sends treat as a dead pane).

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = realpathSync(mkdtempSync(join(tmpdir(), "aya-hp-")));
const bin = join(root, "bin");
const home = join(root, "home");
for (const dir of [bin, home]) mkdirSync(dir);
writeFileSync(join(bin, "opencode"), "#!/bin/sh\nexec sleep 30\n");
chmodSync(join(bin, "opencode"), 0o755);
writeFileSync(join(home, ".profile"), "sleep 2\n");
process.env.AYA_HOME = root;
process.env.HOME = home;
process.env.XDG_DATA_HOME = join(root, "xdg-data");
process.env.SHELL = "/bin/sh";
process.env.PATH = `${bin}:/usr/bin:/bin`;

const { PtyHostClient } = await import("../dist-electron/pty-host-client.js");
const { HOLD_NOT_RUNNING, HOLD_STARTING } = await import("../dist-electron/pane-holds.js");
const { fakeWebContents } = await import("./helpers/pty-host.mjs");

test("the host answers 'starting up' for a pane in its spawn preflight, then the real state", async (t) => {
  const client = new PtyHostClient(join(process.cwd(), "dist-electron", "pty-host.js"));
  client.attachWebContents(fakeWebContents());
  t.after(async () => {
    try {
      await client.kill("slow");
      await client.shutdown();
    } catch {
      /* host already gone */
    }
  });
  await client.spawn({ ptyId: "warm", command: "true", cwd: root, cols: 80, rows: 24 });
  const spawning = client.spawn({ ptyId: "slow", command: "opencode", cwd: root, cols: 80, rows: 24 });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(await client.holdReason("slow"), HOLD_STARTING);
  assert.equal(await client.holdReason("never-spawned"), HOLD_NOT_RUNNING, "only a spawn in preflight is 'starting'");
  await spawning;
  assert.doesNotMatch((await client.holdReason("slow")) ?? "", /not running/);
});
