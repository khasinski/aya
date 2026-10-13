// The pty host holds every terminal of every Aya window: whatever one client or one bug does, the host must not
// die with them. On 2026-10-13 the production host died after 26 hours with no shutdown line, no crash report and
// no trace (its stderr went to /dev/null), and every pane in every window went with it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as net from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP_AYA_HOME = mkdtempSync(join(tmpdir(), "aya-host-survives-"));
process.env.AYA_HOME = TMP_AYA_HOME;

const { PtyHostClient } = await import("../dist-electron/pty-host-client.js");
const { waitFor, fakeWebContents, ptyEventsFor } = await import("./helpers/pty-host.mjs");

const HOST_SCRIPT = join(process.cwd(), "dist-electron", "pty-host.js");
const SOCKET = join(TMP_AYA_HOME, "pty-host.sock");
const REPLAY_BYTES = 1_000_000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A second client asks to attach to `req`'s pane and drops its socket as soon as the replay starts arriving. */
function attachAndDrop(req) {
  return new Promise((resolve) => {
    const socket = net.createConnection(SOCKET, () => {
      socket.write(`${JSON.stringify({ id: 1, type: "spawn", req: { ...req, attachOnly: true } })}\n`);
    });
    socket.on("error", () => resolve());
    socket.once("data", () => {
      socket.destroy();
      resolve();
    });
    setTimeout(() => {
      socket.destroy();
      resolve();
    }, 1_000);
  });
}

test("a client that drops its socket during a replay leaves the host and every terminal running", async (t) => {
  const wc = fakeWebContents();
  const client = new PtyHostClient(HOST_SCRIPT);
  client.attachWebContents(wc);
  let hostPid;
  t.after(() => {
    if (hostPid && isAlive(hostPid)) {
      try {
        process.kill(-hostPid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    rmSync(TMP_AYA_HOME, { recursive: true, force: true });
  });

  // A pane with about a megabyte of output to replay, as a long agent session has.
  const req = {
    ptyId: "big",
    command: "head -c 3000000 /dev/zero | tr '\\0' x; sleep 600",
    cwd: TMP_AYA_HOME,
    cols: 200,
    rows: 50,
  };
  await client.spawn(req);
  await waitFor(
    () =>
      ptyEventsFor(wc, "big")
        .filter((e) => e.type === "data")
        .reduce((n, e) => n + e.chunk.length, 0) >= REPLAY_BYTES,
  );
  hostPid = (await client.hostStatus()).pid;
  assert.ok(hostPid, "the host reports its pid");

  for (let i = 0; i < 10 && isAlive(hostPid); i++) {
    await attachAndDrop(req);
    await delay(100);
  }
  await delay(500);

  assert.equal(isAlive(hostPid), true, "the host survives clients that drop mid-replay");
  // The app's client is still served by the same host, and the pane still runs.
  const status = await client.hostStatus();
  assert.equal(status.pid, hostPid);
  assert.equal(status.ptyCount, 1);
  // The host's stderr is kept: an error that does take it down leaves its stack behind.
  assert.ok(existsSync(join(TMP_AYA_HOME, "pty-host.stderr.log")), "host stderr goes to pty-host.stderr.log");
  await client.shutdown();
});

test("an uncaught error in the host is logged with its stack and the host keeps serving", () => {
  const home = mkdtempSync(join(tmpdir(), "aya-host-uncaught-"));
  try {
    // A child process stands in for the host: the same guard, then an error nothing catches, thrown and rejected.
    const script = `
      const { keepHostOnUncaught } = require(${JSON.stringify(join(process.cwd(), "dist-electron", "pty-host-guard.js"))});
      const { createPtyLog } = require(${JSON.stringify(join(process.cwd(), "dist-electron", "pty-log.js"))});
      keepHostOnUncaught(createPtyLog(${JSON.stringify(join(home, "pty-events.log"))}));
      setTimeout(() => { throw new Error("boom from a socket handler"); }, 10);
      setTimeout(() => { Promise.reject(new Error("rejected nowhere")); }, 20);
      setTimeout(() => { console.log("still serving"); }, 200);
    `;
    const run = spawnSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      env: { ...process.env, AYA_HOME: home },
      timeout: 10_000,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /still serving/);
    const events = readFileSync(join(home, "pty-events.log"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const uncaught = events.filter((e) => e.ev === "host-uncaught");
    assert.equal(uncaught.length, 2);
    assert.match(uncaught[0].error, /boom from a socket handler/);
    assert.match(uncaught[0].error, /at /, "the stack is kept, not only the message");
    assert.equal(uncaught[0].kind, "uncaughtException");
    assert.match(uncaught[1].error, /rejected nowhere/);
    assert.equal(uncaught[1].kind, "unhandledRejection");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
