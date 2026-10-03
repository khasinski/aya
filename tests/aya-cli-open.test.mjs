// `aya open` against a named instance (AYA_SOCKET / AYA_HOME) must reach that
// instance or fail; only an unnamed one may fall back to launching the app.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import * as net from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CLI_SHELLS, shellOptions } from "./helpers/cli-shells.mjs";

const cli = resolve("bin/aya");

function delay(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/** A sandbox whose PATH stubs `uname` (as `platform`) and both launchers,
 *  each appending its argv to `launches`. */
function sandbox(platform) {
  const root = mkdtempSync(join(tmpdir(), "aya-cli-open-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  const project = join(root, "project");
  const launches = join(root, "launches");
  for (const dir of [bin, home, project]) mkdirSync(dir);
  const stub = (name, body) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub("uname", `echo ${platform}`);
  stub("open", `echo "open $*" >> "${launches}"`);
  stub("aya-app", `echo "aya-app $*" >> "${launches}"`);
  return {
    root,
    home,
    project,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, AYA_SOCKET: "", AYA_HOME: "", AYA_OPEN_WAIT_SECONDS: "" },
    /** runOpen waits for this sandbox's background launcher to finish. */
    async launched() {
      return existsSync(launches) ? readFileSync(launches, "utf8") : "";
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Past the default 15 s wait, so a loop that never ends fails the test. */
const RUN_DEADLINE_MS = 20_000;

function runOpen(shell, project, env) {
  return new Promise((done, fail) => {
    // Source the actual CLI with the same $0/argv in its shell, then reap its
    // stub launcher. Linux backgrounds aya-app; waiting for that owned child
    // proves its launch log is complete, including when there was no launch.
    const child = spawn(shell, ["-c", '. "$0"; status=$?; wait; exit "$status"', cli, "open", project], { env, timeout: RUN_DEADLINE_MS });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", fail);
    child.on("close", (status) => done({ status, stderr }));
    // The deadline kills the shell only; a CLI still waiting below it would keep the pipes (and this promise) open.
    child.on("exit", (status, signal) => signal && done({ status, stderr }));
  });
}

/** Resolves with the first request received on `socket`. */
function listen(socket) {
  let received;
  const request = new Promise((done) => (received = done));
  const server = net.createServer((conn) => {
    let buffer = "";
    conn.setEncoding("utf8");
    conn.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      received(JSON.parse(buffer.slice(0, newline)));
      conn.end(`${JSON.stringify({ ok: true })}\n`);
    });
  });
  return new Promise((done) => server.listen(socket, () => done({ server, request })));
}

/** Leaves a socket file nothing listens on, as a crashed Aya does: a killed
 *  process never unlinks it. */
function staleSocket(socket) {
  spawnSync(process.execPath, [
    "-e",
    `require("node:net").createServer().listen(${JSON.stringify(socket)}, () => process.kill(process.pid, "SIGKILL"))`,
  ]);
  assert.ok(lstatSync(socket).isSocket(), "no stale socket file was left");
}

// Each case owns its HOME, PATH stubs, project and socket. Keep the full
// retry windows and launch checks, but overlap independent cases.
describe("open CLI with isolated instances", { concurrency: 8 }, () => {
  for (const shell of CLI_SHELLS) {
    test(`${shell}: a stale named socket file is retried until the wait ends, launching nothing`, shellOptions(shell), async () => {
      const box = sandbox("Linux");
      try {
        const socket = join(box.root, "dev.sock");
        staleSocket(socket);
        const started = Date.now();
        const { status, stderr } = await runOpen(shell, box.project, {
          ...box.env,
          AYA_SOCKET: socket,
          AYA_OPEN_WAIT_SECONDS: "1",
        });
        assert.equal(status, 1);
        assert.ok(Date.now() - started >= 900, "gave up without waiting");
        assert.match(stderr, new RegExp(`no Aya is listening at ${socket} \\(waited 1s\\)`));
        assert.equal(await box.launched(), "");
      } finally {
        box.cleanup();
      }
    });

    test(`${shell}: a named instance restarting over its stale socket file gets the open request`, shellOptions(shell), async () => {
      const box = sandbox("Linux");
      const socket = join(box.root, "dev.sock");
      let server;
      try {
        staleSocket(socket);
        const run = runOpen(shell, box.project, { ...box.env, AYA_SOCKET: socket });
        await delay(1500);
        unlinkSync(socket);
        const listening = await listen(socket);
        server = listening.server;
        const { status, stderr } = await run;
        assert.equal(status, 0, stderr);
        const request = await Promise.race([listening.request, delay(2000).then(() => null)]);
        assert.ok(request, "no request reached the named socket");
        assert.equal(request.path, realpathSync(box.project));
        assert.equal(await box.launched(), "");
      } finally {
        await new Promise((done) => (server ? server.close(done) : done()));
        box.cleanup();
      }
    });

    for (const [state, expectLaunch] of [["stale (Aya crashed)", true], ["live", false]]) {
      test(`${shell}: the installed app's socket is ${state}: ${expectLaunch ? "the app is launched" : "the open request is sent, nothing is launched"}`, shellOptions(shell), async () => {
        const box = sandbox("Linux");
        mkdirSync(join(box.home, ".aya"));
        const socket = join(box.home, ".aya", "aya.sock");
        let server;
        try {
          if (expectLaunch) staleSocket(socket);
          else server = (await listen(socket)).server;
          // A wait for the installed app's socket would run into RUN_DEADLINE_MS (the child is killed, status null);
          // how long a loaded machine takes to start the CLI is not asserted.
          const { status, stderr } = await runOpen(shell, box.project, { ...box.env, AYA_OPEN_WAIT_SECONDS: "3000" });
          assert.equal(status, 0, stderr);
          assert.doesNotMatch(stderr, /waited/, "waited for the installed app's socket");
          const launched = await box.launched();
          if (expectLaunch) assert.match(launched, /^aya-app \/.*project\n$/);
          else assert.equal(launched, "");
        } finally {
          await new Promise((done) => (server ? server.close(done) : done()));
          box.cleanup();
        }
      });
    }

    for (const platform of ["Darwin", "Linux"]) {
      test(`${shell} ${platform}: a missing AYA_SOCKET fails after the wait, launching nothing`, shellOptions(shell), async () => {
        const box = sandbox(platform);
        try {
          const socket = join(box.root, "dev.sock");
          const started = Date.now();
          const { status, stderr } = await runOpen(shell, box.project, {
            ...box.env,
            AYA_SOCKET: socket,
            AYA_OPEN_WAIT_SECONDS: "1",
          });
          assert.notEqual(status, 0);
          assert.ok(Date.now() - started >= 900, "gave up without waiting");
          assert.match(stderr, new RegExp(`no Aya is listening at ${socket} \\(waited 1s\\)`));
          assert.equal(await box.launched(), "");
        } finally {
          box.cleanup();
        }
      });
    }

    test(`${shell}: a missing AYA_HOME instance fails, launching nothing`, shellOptions(shell), async () => {
      const box = sandbox("Linux");
      try {
        const ayaHome = join(box.root, "aya-dev");
        const { status, stderr } = await runOpen(shell, box.project, {
          ...box.env,
          AYA_HOME: ayaHome,
          AYA_OPEN_WAIT_SECONDS: "1",
        });
        assert.notEqual(status, 0);
        assert.match(stderr, new RegExp(`no Aya is listening at ${join(ayaHome, "aya.sock")}`));
        assert.equal(await box.launched(), "");
      } finally {
        box.cleanup();
      }
    });

    for (const wait of ["1.5", "30s", "-1", " 2", "+", "length", "10000", "999999999999999999999999999999999999"]) {
      test(`${shell}: AYA_OPEN_WAIT_SECONDS=${JSON.stringify(wait)} is refused at once, launching nothing`, shellOptions(shell), async () => {
        const box = sandbox("Linux");
        try {
          const started = Date.now();
          const { status, stderr } = await runOpen(shell, box.project, {
            ...box.env,
            AYA_SOCKET: join(box.root, "dev.sock"),
            AYA_OPEN_WAIT_SECONDS: wait,
          });
          assert.equal(status, 1);
          // The default socket wait is 15 s, so 7 s separates "refused at once" from "waited" even under load.
          assert.ok(Date.now() - started < 7000, "waited before refusing");
          assert.ok(stderr.includes(`AYA_OPEN_WAIT_SECONDS must be whole seconds, at most 4 digits, got '${wait}'`), stderr);
          assert.equal(await box.launched(), "");
        } finally {
          box.cleanup();
        }
      });
    }

    test(`${shell}: a four-digit AYA_OPEN_WAIT_SECONDS is accepted`, shellOptions(shell), async () => {
      const box = sandbox("Linux");
      try {
        const { status, stderr } = await runOpen(shell, box.project, {
          ...box.env,
          AYA_SOCKET: join(box.root, "dev.sock"),
          AYA_OPEN_WAIT_SECONDS: "0001",
        });
        assert.equal(status, 1);
        assert.match(stderr, /no Aya is listening at/);
      } finally {
        box.cleanup();
      }
    });

    for (const [label, named] of [
      ["AYA_SOCKET", (root) => ({ AYA_SOCKET: join(root, "dev", "aya.sock") })],
      ["AYA_HOME", (root) => ({ AYA_HOME: join(root, "dev") })],
    ]) test(`${shell}: a named ${label} socket that appears within the default wait gets the open request`, shellOptions(shell), async () => {
      const box = sandbox("Linux");
      mkdirSync(join(box.root, "dev"));
      const socket = join(box.root, "dev", "aya.sock");
      let server;
      try {
        const run = runOpen(shell, box.project, { ...box.env, ...named(box.root) });
        await delay(2500);
        const listening = await listen(socket);
        server = listening.server;
        const { status, stderr } = await run;
        assert.equal(status, 0, stderr);
        const request = await Promise.race([listening.request, delay(2000).then(() => null)]);
        assert.ok(request, "no request reached the named socket");
        assert.equal(request.type, "open");
        assert.equal(request.path, realpathSync(box.project));
        assert.equal(await box.launched(), "");
      } finally {
        await new Promise((done) => (server ? server.close(done) : done()));
        box.cleanup();
      }
    });

    for (const [label, named] of [
      ["nothing named", () => ({})],
      ["nothing named, HOME with a trailing slash", (home) => ({ HOME: `${home}/` })],
      ["AYA_SOCKET naming the installed app's socket", (home) => ({ AYA_SOCKET: `${home}/.aya/aya.sock` })],
      ["AYA_SOCKET spelled with a literal ~/", () => ({ AYA_SOCKET: "~/.aya/aya.sock" })],
      ["AYA_SOCKET spelled with doubled slashes", (home) => ({ AYA_SOCKET: `${home}//.aya///aya.sock` })],
      ["AYA_HOME naming the installed app's home", (home) => ({ AYA_HOME: `${home}/.aya` })],
      ["AYA_HOME with a trailing slash", (home) => ({ AYA_HOME: `${home}/.aya/` })],
      ["AYA_HOME spelled with a literal ~/", () => ({ AYA_HOME: "~/.aya" })],
      ["a whitespace-only AYA_HOME, which the app ignores", () => ({ AYA_HOME: " \t" })],
    ]) {
      test(`${shell}: ${label} still launches the installed app at once`, shellOptions(shell), async () => {
        const box = sandbox("Linux");
        try {
          const started = Date.now();
          // A 60 s socket wait makes "waited" unmistakable on a loaded machine, unlike a fixed 900 ms bound.
          const { status, stderr } = await runOpen(shell, box.project, { ...box.env, AYA_OPEN_WAIT_SECONDS: "60", ...named(box.home) });
          assert.ok(Date.now() - started < 20000, "waited for the installed app's socket");
          assert.equal(status, 0, stderr);
          assert.match(await box.launched(), /^aya-app \/.*project\n$/);
        } finally {
          box.cleanup();
        }
      });
    }
  }
});
