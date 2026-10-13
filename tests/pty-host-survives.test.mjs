// The pty host holds every terminal of every Aya window: whatever one client or one bug does, the host must not
// die with them. On 2026-10-13 the production host died after 26 hours with no shutdown line, no crash report and
// no trace (its stderr went to /dev/null), and every pane in every window went with it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import * as net from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP_AYA_HOME = mkdtempSync(join(tmpdir(), "aya-host-survives-"));
process.env.AYA_HOME = TMP_AYA_HOME;

const { PtyHostClient, openHostStderr } = await import("../dist-electron/pty-host-client.js");
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

/** Where a process's stderr (fd 2) leads: /proc on Linux, lsof on macOS. */
function stderrTarget(pid) {
  if (existsSync(`/proc/${pid}/fd/2`)) return readlinkSync(`/proc/${pid}/fd/2`);
  const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "2", "-Fn"], { encoding: "utf8" });
  return out.split("\n").find((line) => line.startsWith("n"))?.slice(1) ?? "";
}

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
  // Handled where it happens, on the dropped client's socket, not by the last-resort guard.
  const logged = readFileSync(join(TMP_AYA_HOME, "pty-events.log"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).ev);
  assert.ok(logged.includes("client-error"), "the dropped socket's error is logged as client-error");
  assert.equal(logged.includes("host-uncaught"), false, "no error reached the uncaught guard");
  // The app's client is still served by the same host, and the pane still runs.
  const status = await client.hostStatus();
  assert.equal(status.pid, hostPid);
  assert.equal(status.ptyCount, 1);
  // The host's stderr is kept: an error that does take it down leaves its stack behind.
  assert.match(stderrTarget(hostPid), /\/pty-host\.stderr\.log$/, "host stderr goes to pty-host.stderr.log");
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

test("openHostStderr appends, moves a full file to .1, and never writes through a link", () => {
  const dir = mkdtempSync(join(tmpdir(), "aya-host-stderr-"));
  try {
    const file = join(dir, "pty-host.stderr.log");
    let fd = openHostStderr(file, 10);
    assert.equal(typeof fd, "number");
    writeSync(fd, "first\n");
    closeSync(fd);
    fd = openHostStderr(file, 10);
    writeSync(fd, "second\n");
    closeSync(fd);
    assert.equal(readFileSync(file, "utf8"), "first\nsecond\n");
    assert.equal(lstatSync(file).mode & 0o777, 0o600);

    // Over the cap: the old output moves to .1 and a fresh file starts.
    fd = openHostStderr(file, 10);
    writeSync(fd, "third\n");
    closeSync(fd);
    assert.equal(readFileSync(`${file}.1`, "utf8"), "first\nsecond\n");
    assert.equal(readFileSync(file, "utf8"), "third\n");

    // A file left with wider permissions is narrowed to the owner before anything is written to it.
    const wide = join(dir, "wide.log");
    writeFileSync(wide, "");
    chmodSync(wide, 0o644);
    closeSync(openHostStderr(wide));
    assert.equal(lstatSync(wide).mode & 0o777, 0o600);

    // A FIFO at the path would stall the host's writes: it is not used.
    const fifo = join(dir, "fifo.log");
    execFileSync("mkfifo", [fifo]);
    assert.equal(openHostStderr(fifo), "ignore");

    // A link planted at the path is not followed: the host's stderr is dropped instead.
    const target = join(dir, "elsewhere");
    writeFileSync(target, "");
    const linked = join(dir, "linked.log");
    symlinkSync(target, linked);
    assert.equal(openHostStderr(linked), "ignore");
    assert.equal(readFileSync(target, "utf8"), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the real host installs the guard: an error thrown inside it is logged and the host serves on", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "aya-host-guarded-"));
  const injector = join(home, "inject.cjs");
  // Preloaded into the real host script: once it is serving, an exception and a rejection nobody handles.
  writeFileSync(
    injector,
    `setTimeout(() => { throw new Error("injected throw"); }, 300);
     setTimeout(() => { Promise.reject(new Error("injected rejection")); }, 400);`,
  );
  const host = spawn(process.execPath, ["--require", injector, HOST_SCRIPT], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, AYA_HOME: home },
  });
  t.after(() => {
    try {
      process.kill(-host.pid, "SIGKILL");
    } catch {
      // already gone
    }
    rmSync(home, { recursive: true, force: true });
  });
  const logFile = join(home, "pty-events.log");
  const events = () =>
    existsSync(logFile)
      ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : [];
  await waitFor(() => events().filter((e) => e.ev === "host-uncaught").length === 2);
  await delay(300);
  assert.equal(isAlive(host.pid), true, "the host is still running");
  const uncaught = events().filter((e) => e.ev === "host-uncaught");
  assert.match(uncaught[0].error, /injected throw/);
  assert.match(uncaught[1].error, /injected rejection/);
  // And it still answers on its socket.
  const answer = await new Promise((resolve, reject) => {
    const socket = net.createConnection(join(home, "pty-host.sock"), () => {
      socket.write(`${JSON.stringify({ id: 7, type: "version" })}\n`);
    });
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.includes("\n")) {
        socket.destroy();
        resolve(JSON.parse(buffer.slice(0, buffer.indexOf("\n"))));
      }
    });
    socket.on("error", reject);
  });
  assert.equal(answer.id, 7);
  assert.equal(answer.ok, true);
});
