import {authenticatedFixtureServer} from "./helpers/pty-host-launch.cjs";
// restart() is the one way Aya replaces its host (Restart Aya, Diagnostics, a stale host at launch). It must not
// let the next host start before the old one has exited: on 2026-10-13 a new host started while the old one still
// ended its panes, lost its socket to the old host's exit handler, and the next Aya started a third host.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { spawn } from "node:child_process";
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
});

/** A stand-in host on the socket: answers "version" without a pid (as hosts before the registry did), takes
 *  "shutdown", and closes its connection `closeAfterMs` later, or never when null. */
async function fakeHost(t, closeAfterMs) {
  const socketPath = join(TMP_AYA_HOME, "pty-host.sock");
  rmSync(socketPath, { force: true });
  const conns = new Set();
  const server = authenticatedFixtureServer((socket) => {
    conns.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const request = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (closeAfterMs === null) continue; // a hung host: answers nothing
        const result = request.type === "version" ? { version: "0.0.1", scriptHash: "x" } : null;
        socket.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
        if (request.type === "shutdown") setTimeout(() => socket.destroy(), closeAfterMs);
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(async () => {
    for (const socket of conns) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
}

test("a host that gives no pid is waited for until it closes the connection, as it does when it exits", async (t) => {
  await fakeHost(t, 1_500);
  const client = new PtyHostClient(HOST_SCRIPT);
  await client.hostStatus();
  const started = Date.now();
  assert.equal(await client.restart(), true);
  assert.ok(Date.now() - started >= 1_400, `restart() returned after ${Date.now() - started} ms, before the host closed`);
  client.dispose();
});

test("a host that answers shutdown but never exits is killed, so no second host runs beside it", async (t) => {
  const socketPath = join(TMP_AYA_HOME, "pty-host.sock");
  rmSync(socketPath, { force: true });
  // A separate process on the socket that gives its pid, says yes to shutdown, and stays (SIGTERM ignored too).
  const source = `
    const net = require("node:net");
    process.on("SIGTERM", () => {});
    require(${JSON.stringify(join(process.cwd(),"tests/helpers/pty-host-launch.cjs"))}).authenticatedFixtureServer((s) => {
      s.setEncoding("utf8");
      let b = "";
      s.on("data", (c) => {
        b += c;
        let e;
        while ((e = b.indexOf("\\n")) !== -1) {
          const r = JSON.parse(b.slice(0, e));
          b = b.slice(e + 1);
          const result = r.type === "version" ? { version: "0.0.1", scriptHash: "x", pid: process.pid } : null;
          s.write(JSON.stringify({ id: r.id, ok: true, result }) + "\\n");
        }
      });
    }).listen(${JSON.stringify(socketPath)}, () => console.log("ready"));`;
  const stubborn = spawn(process.execPath, ["-e", source], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => {
    try {
      process.kill(stubborn.pid, "SIGKILL");
    } catch {
      // already gone
    }
  });
  await new Promise((resolve) => stubborn.stdout.once("data", resolve));
  const client = new PtyHostClient(HOST_SCRIPT);
  assert.equal((await client.hostStatus()).pid, stubborn.pid);
  const started = Date.now();
  assert.equal(await client.restart(), true);
  assert.equal(isAlive(stubborn.pid), false, "the host that would not exit is gone");
  assert.ok(Date.now() - started >= 4_900, "it was given the full wait first");
  client.dispose();
});

test("a host that does not answer at all: restart() gives up within its bounds and says it did not finish", async (t) => {
  await fakeHost(t, null);
  const client = new PtyHostClient(HOST_SCRIPT);
  // Connected first, as Aya is: hostStatus() itself never gets an answer from this host.
  void client.hostStatus();
  await waitFor(() => client.isConnected());
  const started = Date.now();
  assert.equal(await client.restart(), false);
  const took = Date.now() - started;
  assert.ok(took < 2_000 + 2_000 + 5_000 + 1_000, `restart() took ${took} ms`);
  client.dispose();
  rmSync(TMP_AYA_HOME, { recursive: true, force: true });
});
