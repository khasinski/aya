import {spawnAuthenticatedHost} from "./helpers/pty-host-launch.cjs";
// A host replaced by a restart must not take its successor's socket with it. On 2026-10-13 a stale host shut down
// by Aya kept running its exit handler after the new host had bound pty-host.sock, removed that path, and left
// the new host serving its panes with no socket: the next Aya start found none, started a third host and resumed
// every agent a second time while the unreachable host kept the first copies running.

import { test } from "node:test";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP_AYA_HOME = mkdtempSync(join(tmpdir(), "aya-handoff-"));
process.env.AYA_HOME = TMP_AYA_HOME;

const { PtyHostClient } = await import("../dist-electron/pty-host-client.js");
const { waitFor, fakeWebContents, ptyEventsFor, cleanupNativeOwner } = await import("./helpers/pty-host.mjs");

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
  t.after(async () => {
    for (const pid of pids) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    await cleanupNativeOwner(TMP_AYA_HOME);
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

test("a host whose socket another host replaced leaves that socket alone when it exits", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "aya-handoff2-"));
  const socket = join(home, "pty-host.sock");
  const hosts = [];
  const startHost = () => {
    const child = spawnAuthenticatedHost(process.execPath, [HOST_SCRIPT], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, AYA_HOME: home },
    });
    hosts.push(child.pid);
    return child.pid;
  };
  t.after(async () => {
    for (const pid of hosts) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    await cleanupNativeOwner(home);
    rmSync(home, { recursive: true, force: true });
  });

  const first = startHost();
  await waitFor(() => existsSync(socket));
  const firstInode = statSync(socket).ino;
  // A second host takes the path over without the first one closing (what a client does when it cannot reach the
  // host on the socket): it removes the file and binds its own.
  // A stand-in listener exercises inode ownership without starting a second
  // JS host or native owner for the same panes.
  rmSync(socket);
  const replacement = createServer();
  await new Promise(resolve => replacement.listen(socket, resolve));
  t.after(() => new Promise(resolve => replacement.close(resolve)));
  await waitFor(() => existsSync(socket) && statSync(socket).ino !== firstInode);
  const secondInode = statSync(socket).ino;

  process.kill(first, "SIGTERM");
  await waitFor(() => !isAlive(first), 10_000);
  assert.equal(replacement.listening, true);
  assert.equal(existsSync(socket), true, "the second host's socket survives the first host's exit");
  assert.equal(statSync(socket).ino, secondInode);
});

test("a displaced host that exits on its own, not through shutdown, leaves the successor's socket alone", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "aya-handoff3-"));
  const socket = join(home, "pty-host.sock");
  const flag = join(home, "exit-now");
  // Preloaded into the first host: it exits straight away, as the idle timer does, once the flag appears. Only the
  // exit handler runs, with the host still holding the inode it recorded.
  const preload = join(home, "exit-on-flag.cjs");
  writeFileSync(
    preload,
    `const fs = require("node:fs");
     setInterval(() => { if (fs.existsSync(${JSON.stringify(flag)})) process.exit(0); }, 50);`,
  );
  const hosts = [];
  const startHost = (args) => {
    const child = spawnAuthenticatedHost(process.execPath, [...args, HOST_SCRIPT], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, AYA_HOME: home },
    });
    hosts.push(child.pid);
    return child.pid;
  };
  t.after(async () => {
    for (const pid of hosts) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    await cleanupNativeOwner(home);
    rmSync(home, { recursive: true, force: true });
  });

  const first = startHost(["--require", preload]);
  await waitFor(() => existsSync(socket));
  const firstInode = statSync(socket).ino;
  rmSync(socket);
  const replacement = createServer();
  await new Promise(resolve => replacement.listen(socket, resolve));
  t.after(() => new Promise(resolve => replacement.close(resolve)));
  await waitFor(() => existsSync(socket) && statSync(socket).ino !== firstInode);
  const secondInode = statSync(socket).ino;

  writeFileSync(flag, "");
  await waitFor(() => !isAlive(first), 10_000);
  assert.equal(replacement.listening, true);
  assert.equal(existsSync(socket), true, "the successor's socket survives the displaced host's exit");
  assert.equal(statSync(socket).ino, secondInode);
});
