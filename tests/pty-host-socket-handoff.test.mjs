// A host replaced by a restart must not take its successor's socket with it. On 2026-10-13 a stale host shut down
// by Aya kept running its exit handler after the new host had bound pty-host.sock, removed that path, and left
// the new host serving its panes with no socket: the next Aya start found none, started a third host and resumed
// every agent a second time while the unreachable host kept the first copies running.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP_AYA_HOME = mkdtempSync(join(tmpdir(), "aya-handoff-"));
process.env.AYA_HOME = TMP_AYA_HOME;

const { PtyHostClient } = await import("../dist-electron/pty-host-client.js");
const { waitFor, fakeWebContents, ptyEventsFor } = await import("./helpers/pty-host.mjs");

const HOST_SCRIPT = join(process.cwd(), "dist-electron", "pty-host.js");
const SOCKET = join(TMP_AYA_HOME, "pty-host.sock");

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("after a restart, the old host's exit leaves the new host's socket in place", async (t) => {
  const pids = new Set();
  t.after(() => {
    for (const pid of pids) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    rmSync(TMP_AYA_HOME, { recursive: true, force: true });
  });

  const wc = fakeWebContents();
  const app = new PtyHostClient(HOST_SCRIPT);
  app.attachWebContents(wc);
  // A pane that ignores the hang-up, so the old host is still shutting down (until its SIGKILL step) when the new
  // one binds the socket: the order in which the race happened.
  await app.spawn({
    ptyId: "slow",
    command: "trap '' HUP TERM; echo ready; sleep 60",
    cwd: TMP_AYA_HOME,
    cols: 80,
    rows: 24,
  });
  await waitFor(() =>
    ptyEventsFor(wc, "slow").some((e) => e.type === "data" && e.chunk.includes("ready")),
  );
  const oldPid = (await app.hostStatus()).pid;
  pids.add(oldPid);

  // What Aya does with a stale host: ask it to shut down, then talk to a fresh one.
  await app.restart();
  const newPid = (await app.hostStatus()).pid;
  pids.add(newPid);
  assert.notEqual(newPid, oldPid, "a new host took over");

  await waitFor(() => !isAlive(oldPid), 10_000);

  assert.equal(existsSync(SOCKET), true, "the new host's socket is still there after the old host exited");
  // The next Aya start connects to the running host instead of starting another one.
  const nextStart = new PtyHostClient(HOST_SCRIPT);
  const reached = (await nextStart.hostStatus()).pid;
  pids.add(reached);
  assert.equal(reached, newPid, "a later client reaches the same host");
  await nextStart.shutdown();
});
