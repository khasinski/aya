// The idle shutdown must never take a host that still holds a pty or a client
// (its children die with it). Real host, real socket, a real `sleep` pty.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor } from "./helpers/wait-for.mjs";

const HOST_SCRIPT = join(process.cwd(), "dist-electron", "pty-host.js");
const IDLE_MS = 400;
const PAST_IDLE_MS = IDLE_MS * 3;
const REPLY_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 120_000;
let sleepSeed = 71000 + (process.pid % 1000) * 10;

async function withHost(body) {
  const home = mkdtempSync(join(tmpdir(), "aya-idle-live-"));
  const sock = join(home, "pty-host.sock");
  const host = spawn(process.execPath, [HOST_SCRIPT], {
    env: { ...process.env, AYA_HOME: home, AYA_PTY_HOST_IDLE_MS: String(IDLE_MS) },
    stdio: "ignore",
  });
  const clients = [];
  let nextId = 1;
  const connect = async () => {
    await waitFor(() => existsSync(sock), 10_000);
    const socket = net.createConnection(sock);
    await new Promise((resolve, reject) => socket.once("connect", resolve).once("error", reject));
    socket.on("error", () => {});
    const pending = new Map();
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        pending.get(msg.id)?.(msg);
      }
    });
    const client = {
      send: (req) =>
        new Promise((resolve, reject) => {
          const id = nextId++;
          pending.set(id, resolve);
          socket.once("close", () => reject(new Error(`the host closed the socket before answering ${req.type}`)));
          setTimeout(() => reject(new Error(`no answer to ${req.type} from the host`)), REPLY_TIMEOUT_MS).unref();
          socket.write(`${JSON.stringify({ id, ...req })}\n`);
        }),
      leave: () => socket.end(),
    };
    clients.push(client);
    return client;
  };
  const hostExit = new Promise((resolve) => host.once("exit", () => resolve(true)));
  const ctx = {
    host,
    connect,
    hostAlive: () => host.exitCode === null && host.signalCode === null,
    exits: async (ms) => {
      let timer;
      try {
        return await Promise.race([hostExit, new Promise((r) => (timer = setTimeout(() => r(false), ms)))]);
      } finally {
        clearTimeout(timer);
      }
    },
    async spawnSleep(client) {
      const n = sleepSeed++;
      const r = await client.send({ type: "spawn", req: { ptyId: `p${n}`, command: `sleep ${n}`, cwd: home, cols: 80, rows: 24 } });
      assert.equal(r.ok, true, JSON.stringify(r));
      await waitFor(() => sleepAlive(n), 15_000);
      return { ptyId: `p${n}`, n };
    },
    sleepAlive,
    pause: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  try {
    await body(ctx);
  } finally {
    for (const c of clients) c.leave();
    // Only kill descendants of the host this fixture started, by PID. A
    // command-line match can also select a process from another Aya instance.
    const table = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).stdout;
    const owned = new Set(ctx.hostAlive() ? [host.pid] : []);
    const rows = table.trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number));
    let added;
    do {
      added = false;
      for (const [pid, ppid] of rows) if (owned.has(ppid) && !owned.has(pid)) {
        owned.add(pid);
        added = true;
      }
    } while (added);
    for (const pid of [...owned].reverse()) {
      try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    rmSync(home, { recursive: true, force: true });
  }
}

function sleepAlive(n) {
  return spawnSync("pgrep", ["-f", `sleep ${n}$`]).status === 0;
}

// Every case starts its own host or CLI against its own temporary socket.
describe("idle shutdown with isolated hosts", { concurrency: 4 }, () => {
  test("a client leaves with a live pty: host and pty stay up, then the host exits once the pty is gone", { timeout: TEST_TIMEOUT_MS }, async () => {
    await withHost(async (h) => {
      const a = await h.connect();
      const pty = await h.spawnSleep(a);
      a.leave();
      await h.pause(PAST_IDLE_MS);
      assert.equal(h.hostAlive(), true, "the host was shut down under a live pty");
      assert.equal(h.sleepAlive(pty.n), true, "the pty died with its host");
      const b = await h.connect();
      await b.send({ type: "kill", ptyId: pty.ptyId });
      b.leave();
      assert.equal(await h.exits(PAST_IDLE_MS * 3), true, "an idle host with no pty never exited");
    });
  });

  test("spawn, then an immediate disconnect: the pty keeps the host", { timeout: TEST_TIMEOUT_MS }, async () => {
    await withHost(async (h) => {
      const a = await h.connect();
      const n = sleepSeed++;
      // Left on the reply, before the shell has started: the pty exists but nothing has run yet.
      await a.send({ type: "spawn", req: { ptyId: `p${n}`, command: `sleep ${n}`, cwd: tmpdir(), cols: 80, rows: 24 } });
      a.leave();
      await waitFor(() => h.sleepAlive(n), 15_000);
      await h.pause(PAST_IDLE_MS);
      assert.equal(h.hostAlive(), true, "the host was shut down under a pty spawned just before the disconnect");
      assert.equal(h.sleepAlive(n), true);
    });
  });

  test("two clients: one leaving does not idle the host, both leaving with a live pty does not either", { timeout: TEST_TIMEOUT_MS }, async () => {
    await withHost(async (h) => {
      const a = await h.connect();
      const b = await h.connect();
      const pty = await h.spawnSleep(a);
      a.leave();
      await h.pause(PAST_IDLE_MS);
      assert.equal(h.hostAlive(), true);
      b.leave();
      await h.pause(PAST_IDLE_MS);
      assert.equal(h.hostAlive(), true);
      assert.equal(h.sleepAlive(pty.n), true);
    });
  });

  test("a client that leaves and reconnects keeps the host, and a client alone (no pty) holds it too", { timeout: TEST_TIMEOUT_MS }, async () => {
    await withHost(async (h) => {
      const a = await h.connect();
      a.leave();
      await h.pause(IDLE_MS / 4);
      await h.connect();
      await h.pause(PAST_IDLE_MS);
      assert.equal(h.hostAlive(), true, "a connected client did not hold the host");
    });
  });

  async function spawnQuick(client, cwd) {
    const r = await client.send({ type: "spawn", req: { ptyId: "quick", command: "exit 0", cwd, cols: 80, rows: 24 } });
    assert.equal(r.ok, true, JSON.stringify(r));
  }

  test("a pty ends on its own while a client stays connected: the host stays, then exits once the client leaves", { timeout: TEST_TIMEOUT_MS }, async () => {
    await withHost(async (h) => {
      const a = await h.connect();
      await spawnQuick(a, tmpdir());
      await h.pause(PAST_IDLE_MS);
      assert.equal(h.hostAlive(), true, "the host was shut down under a connected client after a natural pty exit");
      a.leave();
      assert.equal(await h.exits(PAST_IDLE_MS * 3), true, "no client and no pty, yet the host never exited");
    });
  });

  test("a natural pty exit with a second client connected: the host stays until both are gone", { timeout: TEST_TIMEOUT_MS }, async () => {
    await withHost(async (h) => {
      const a = await h.connect();
      const b = await h.connect();
      await spawnQuick(a, tmpdir());
      a.leave();
      await h.pause(PAST_IDLE_MS);
      assert.equal(h.hostAlive(), true, "the host was shut down under the second client");
      b.leave();
      assert.equal(await h.exits(PAST_IDLE_MS * 3), true);
    });
  });

  test("a pty ends on its own with no client connected: the host exits after the idle wait", { timeout: TEST_TIMEOUT_MS }, async () => {
    await withHost(async (h) => {
      const a = await h.connect();
      const r = await a.send({ type: "spawn", req: { ptyId: "short", command: "sleep 2", cwd: tmpdir(), cols: 80, rows: 24 } });
      assert.equal(r.ok, true, JSON.stringify(r));
      a.leave();
      await h.pause(PAST_IDLE_MS);
      assert.equal(h.hostAlive(), true, "the host was shut down under a live pty");
      assert.equal(await h.exits(20_000), true, "the pty ended with nobody connected and the host never exited");
    });
  });
});
