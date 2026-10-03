// An agent in a pane that outlived the app calls `aya team` while Aya restarts and its socket is gone for a few
// seconds: from a pane the call waits for Aya to come back, outside one it fails at once.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as net from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { distinctShells } from "./helpers/cli-shells.mjs";

const cli = resolve("bin/aya");
const DEFAULT_WAIT_SECONDS = Number(/AYA_OPEN_WAIT_SECONDS:-(\d+)/.exec(readFileSync(cli, "utf8"))[1]);
const SHELLS = distinctShells(["/bin/sh", "/bin/dash"]);
const AYA_BACK_AFTER_MS = 1500;
const WAIT_SECONDS = 1;
const MIN_WAIT_MS = 900;
// A wait that never ends is a bug: the CLI must give up within its wait plus this.
const WATCHDOG_SLACK_MS = 8000;

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

function run(shell, args, env) {
  return new Promise((done, fail) => {
    const started = Date.now();
    const child = spawn(shell, [cli, ...args], { env: { ...process.env, AYA_OPEN_WAIT_SECONDS: "", AYA_TERMINAL_ID: "", ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", fail);
    const watchdog = setTimeout(() => {
      process.kill(-child.pid, "SIGKILL"); // the whole group: the sh's node child would otherwise retry forever
      fail(new Error(`aya ${args.join(" ")} still waiting after ${WATCHDOG_SLACK_MS}ms`));
    }, Number(env.AYA_OPEN_WAIT_SECONDS || DEFAULT_WAIT_SECONDS) * 1000 + WATCHDOG_SLACK_MS);
    child.on("close", (status) => {
      clearTimeout(watchdog);
      done({ status, stdout, stderr, ms: Date.now() - started });
    });
  });
}

/** A server that takes the request line and closes without answering. */
function listenAndHangUp(socket) {
  const requests = [];
  const server = net.createServer((conn) => {
    conn.on("data", (chunk) => {
      requests.push(String(chunk));
      conn.end();
    });
    conn.on("error", () => {});
  });
  return new Promise((done) => server.listen(socket, () => done({ server, requests })));
}

/** A socket file whose Aya is gone, as a crash leaves it: it exists and refuses. */
function leaveStaleSocket(socket) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(socket)}, () => process.kill(process.pid, "SIGKILL"))`]);
    child.on("error", fail);
    child.on("close", () => (existsSync(socket) ? done() : fail(new Error("no stale socket left"))));
  });
}

function listen(socket) {
  const server = net.createServer((conn) => {
    conn.on("data", () => conn.end(`${JSON.stringify({ ok: true, output: "team ux-review\n" })}\n`));
  });
  return new Promise((done) => server.listen(socket, () => done(server)));
}

// Every case starts its own host or CLI against its own temporary socket.
describe("team CLI restart with isolated sockets", { concurrency: 4 }, () => {
  for (const shell of SHELLS) {
    for (const action of [["whoami"], ["inbox"], ["send", "implementer", "hello"]]) {
      test(`${shell}: aya team ${action[0]} from a pane waits for a restarting Aya and is answered`, async () => {
        const dir = mkdtempSync(join(tmpdir(), "aya-team-restart-"));
        const socket = join(dir, "aya.sock");
        let server;
        try {
          const call = run(shell, ["team", ...action], { AYA_SOCKET: socket, AYA_TERMINAL_ID: "tab-left" });
          await delay(AYA_BACK_AFTER_MS);
          server = await listen(socket);
          const { status, stdout, stderr } = await call;
          assert.equal(status, 0, stderr);
          assert.match(stdout, /team ux-review/);
        } finally {
          await new Promise((done) => (server ? server.close(done) : done()));
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }

    test(`${shell}: from a pane, an Aya that never comes back fails after the wait and says so`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "aya-team-restart-"));
      try {
        const socket = join(dir, "aya.sock");
        const { status, stderr, ms } = await run(shell, ["team", "whoami"], { AYA_SOCKET: socket, AYA_TERMINAL_ID: "tab-left", AYA_OPEN_WAIT_SECONDS: String(WAIT_SECONDS) });
        assert.equal(status, 1);
        assert.ok(ms >= MIN_WAIT_MS, "gave up without waiting");
        assert.match(stderr, new RegExp(`no Aya is listening at ${socket} \\(waited ${WAIT_SECONDS}s\\)`));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test(`${shell}: outside a pane a missing socket fails at once`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "aya-team-restart-"));
      try {
        const { status, stderr, ms } = await run(shell, ["team", "whoami"], { AYA_SOCKET: join(dir, "aya.sock") });
        assert.equal(status, 1);
        assert.ok(ms < MIN_WAIT_MS, "waited for a socket nobody is starting");
        assert.match(stderr, /control socket not found/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  for (const shell of SHELLS) {
    test(`${shell}: an accepted request answered with nothing is an error, not success`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "aya-team-restart-"));
      const socket = join(dir, "aya.sock");
      const { server, requests } = await listenAndHangUp(socket);
      try {
        const { status, stdout, stderr } = await run(shell, ["team", "send", "implementer", "hello"], { AYA_SOCKET: socket, AYA_TERMINAL_ID: "tab-left" });
        assert.equal(status, 1, "exit 0 would tell the agent the message was typed");
        assert.equal(stdout, "");
        assert.match(stderr, /closed the connection before answering; the message may or may not have been typed/);
        assert.equal(requests.length, 1);
      } finally {
        await new Promise((done) => server.close(done));
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // A unix socket gives EPIPE or a bare EOF here, never ECONNRESET; either way the
    // request may have been typed, so a second connection would be a possible duplicate.
    test(`${shell}: a connection dropped once the request was sent is not retried`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "aya-team-restart-"));
      const socket = join(dir, "aya.sock");
      let connections = 0;
      const server = net.createServer((conn) => {
        connections++;
        conn.destroy();
      });
      await new Promise((done) => server.listen(socket, done));
      const CALLS = 6;
      try {
        for (let i = 0; i < CALLS; i++) {
          const { status } = await run(shell, ["team", "send", "implementer", "hello"], { AYA_SOCKET: socket, AYA_TERMINAL_ID: "tab-left", AYA_OPEN_WAIT_SECONDS: "3" });
          assert.equal(status, 1);
        }
        assert.equal(connections, CALLS, "a resent request could type the message twice");
      } finally {
        await new Promise((done) => server.close(done));
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test(`${shell}: a stale socket file (crashed Aya) is waited on until the new Aya replaces it`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "aya-team-restart-"));
      const socket = join(dir, "aya.sock");
      let server;
      try {
        await leaveStaleSocket(socket);
        const call = run(shell, ["team", "whoami"], { AYA_SOCKET: socket, AYA_TERMINAL_ID: "tab-left" });
        await delay(AYA_BACK_AFTER_MS);
        rmSync(socket);
        server = await listen(socket);
        const { status, stdout, stderr } = await call;
        assert.equal(status, 0, stderr);
        assert.match(stdout, /team ux-review/);
      } finally {
        await new Promise((done) => (server ? server.close(done) : done()));
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  /** Answers each request with the next of `replies`, then repeats the last. */
  function listenScripted(socket, replies) {
    let served = 0;
    const server = net.createServer((conn) => {
      conn.on("data", () => conn.end(`${JSON.stringify(replies[Math.min(served++, replies.length - 1)])}\n`));
      conn.on("error", () => {});
    });
    return new Promise((done) => server.listen(socket, () => done({ server, served: () => served })));
  }

  const STARTING = { ok: false, retry: true, error: "Aya is still starting; run it again in a moment" };

  for (const shell of SHELLS) {
    test(`${shell}: from a pane, an Aya still starting is asked again until it answers`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "aya-team-restart-"));
      const socket = join(dir, "aya.sock");
      const { server, served } = await listenScripted(socket, [STARTING, STARTING, { ok: true, output: "team ux-review\n" }]);
      try {
        const { status, stdout, stderr } = await run(shell, ["team", "whoami"], { AYA_SOCKET: socket, AYA_TERMINAL_ID: "tab-left" });
        assert.equal(status, 0, stderr);
        assert.match(stdout, /team ux-review/);
        assert.equal(served(), 3);
      } finally {
        await new Promise((done) => server.close(done));
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test(`${shell}: from a pane, an Aya that stays starting fails after the wait with its own words`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "aya-team-restart-"));
      const socket = join(dir, "aya.sock");
      const { server } = await listenScripted(socket, [STARTING]);
      try {
        const { status, stderr, ms } = await run(shell, ["team", "whoami"], { AYA_SOCKET: socket, AYA_TERMINAL_ID: "tab-left", AYA_OPEN_WAIT_SECONDS: String(WAIT_SECONDS) });
        assert.equal(status, 1);
        assert.ok(ms >= MIN_WAIT_MS, "gave up without waiting");
        assert.match(stderr, /Aya is still starting/);
      } finally {
        await new Promise((done) => server.close(done));
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test(`${shell}: outside a pane a starting Aya is reported at once`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "aya-team-restart-"));
      const socket = join(dir, "aya.sock");
      const { server, served } = await listenScripted(socket, [STARTING]);
      try {
        const { status, stderr, ms } = await run(shell, ["team", "whoami"], { AYA_SOCKET: socket });
        assert.equal(status, 1);
        assert.ok(ms < MIN_WAIT_MS, "waited outside a pane");
        assert.match(stderr, /Aya is still starting/);
        assert.equal(served(), 1);
      } finally {
        await new Promise((done) => server.close(done));
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
