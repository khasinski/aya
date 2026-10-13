// restart() is the one way Aya replaces its host (Restart Aya, Diagnostics, a stale host at launch). It must not
// let the next host start before the old one has exited: on 2026-10-13 a new host started while the old one still
// ended its panes, lost its socket to the old host's exit handler, and the next Aya started a third host.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP_AYA_HOME = mkdtempSync(join(tmpdir(), "aya-restart-waits-"));
process.env.AYA_HOME = TMP_AYA_HOME;

const { PtyHostClient } = await import("../dist-electron/pty-host-client.js");
const { waitFor, fakeWebContents, ptyEventsFor } = await import("./helpers/pty-host.mjs");

const HOST_SCRIPT = join(process.cwd(), "dist-electron", "pty-host.js");
const LOG = join(TMP_AYA_HOME, "pty-events.log");

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const events = () =>
  existsSync(LOG)
    ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];

/** A client with one pane that ignores the hang-up: its host takes until its SIGKILL step to exit. */
async function slowHost(t) {
  const wc = fakeWebContents();
  const client = new PtyHostClient(HOST_SCRIPT);
  client.attachWebContents(wc);
  const pids = new Set();
  t.after(() => {
    for (const pid of pids) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });
  await client.spawn({ ptyId: "slow", command: "trap '' HUP TERM; echo ready; sleep 60", cwd: TMP_AYA_HOME, cols: 80, rows: 24 });
  await waitFor(() => ptyEventsFor(wc, "slow").some((e) => e.type === "data" && e.chunk.includes("ready")));
  const oldPid = (await client.hostStatus()).pid;
  pids.add(oldPid);
  return { client, oldPid, pids };
}

/** The new host started only after the old one's last line: nothing overlapped. */
function assertStartedAfterOldExit(oldPid, newPid) {
  const all = events();
  const lastOld = all.filter((e) => e.pid === oldPid).at(-1);
  const newStart = all.find((e) => e.pid === newPid && e.ev === "host-start");
  assert.ok(lastOld && newStart, "both hosts logged");
  assert.ok(newStart.ts >= lastOld.ts, `new host started at ${newStart.ts}, old host still logged at ${lastOld.ts}`);
}

test("restart() resolves only once the old host has exited", async (t) => {
  const { client, oldPid, pids } = await slowHost(t);
  assert.equal(await client.restart(), true);
  assert.equal(isAlive(oldPid), false, "the old host is gone when restart() resolves");
  const newPid = (await client.hostStatus()).pid;
  pids.add(newPid);
  assert.notEqual(newPid, oldPid);
  assertStartedAfterOldExit(oldPid, newPid);
  await client.shutdown();
});

test("a request sent during restart() waits, and reaches a host started after the old one exited", async (t) => {
  const { client, oldPid, pids } = await slowHost(t);
  // What a window does while Diagnostics restarts the host: it keeps asking.
  const [, status] = await Promise.all([client.restart(), client.hostStatus()]);
  pids.add(status.pid);
  assert.notEqual(status.pid, oldPid, "the request did not reach the host being replaced");
  assertStartedAfterOldExit(oldPid, status.pid);
  await client.shutdown();
  rmSync(TMP_AYA_HOME, { recursive: true, force: true });
});
