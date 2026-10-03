// A pty host lost while a tab's spawn is still in it: the spawn fails, the tab and a running pane are told their
// session is gone, and the restart reaches a new host. HOME and AYA_HOME are fake.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = realpathSync(mkdtempSync(join(tmpdir(), "aya-lost-inflight-")));
process.env.AYA_HOME = join(root, "aya-home");
process.env.HOME = join(root, "home");
process.env.PATH = "/usr/bin:/bin";
// The login shell the host asks for a CLI missing from PATH: slow, so the host is lost mid-question.
const slowShell = join(root, "slow-login-shell");
writeFileSync(slowShell, "#!/bin/sh\nsleep 4\nexit 1\n");
chmodSync(slowShell, 0o755);
process.env.SHELL = slowShell;
mkdirSync(process.env.HOME);
const cwd = join(root, "project");
mkdirSync(cwd);

const { PtyHostClient } = await import("../dist-electron/pty-host-client.js");
const { waitFor } = await import("./helpers/pty-host.mjs");

const HOST_SCRIPT = join(process.cwd(), "dist-electron", "pty-host.js");
const typeOf = (events, ptyId) => events.filter((e) => e.ptyId === ptyId).map((e) => e.type);

test("host lost while a spawn waits on its CLI check: the spawn fails, the tab and the running pane are told, a restart reaches a new host", async (t) => {
  const events = [];
  const client = new PtyHostClient(HOST_SCRIPT);
  t.after(() => client.restart().finally(() => client.dispose()));
  client.attachWebContents({ isDestroyed: () => false, send: (_channel, event) => events.push(event) });
  await client.spawn({ ptyId: "a", command: "/bin/sleep 120", cwd, cols: 80, rows: 24 });
  const { pid } = await client.hostStatus();
  const inFlight = client.spawn({ ptyId: "x", command: "aya-test-missing-cli --flag", cwd, cols: 80, rows: 24 }).then(
    () => "started",
    (err) => `refused: ${err.message}`,
  );
  await new Promise((r) => setTimeout(r, 500));
  process.kill(-pid, "SIGKILL");
  assert.equal(await inFlight, "refused: PTY host disconnected");
  await waitFor(() => typeOf(events, "a").includes("no-session"));
  assert.deepEqual([typeOf(events, "x"), typeOf(events, "a")], [["no-session"], ["no-session"]]);
  await client.spawn({ ptyId: "x", command: "/bin/sleep 120", cwd, cols: 80, rows: 24 });
  const { pid: newPid } = await client.hostStatus();
  assert.notEqual(newPid, pid);
  assert.deepEqual(await client.getSize("x"), { cols: 80, rows: 24, alt: false });
});
