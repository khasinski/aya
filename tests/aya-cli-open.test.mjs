// `aya open` against a named instance (AYA_SOCKET / AYA_HOME) must reach that
// instance or fail; only an unnamed one may fall back to launching the app.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const cli = resolve("bin/aya");
const LAUNCH_SETTLE_MS = 2000;
const shells = ["/bin/sh", "/bin/dash"].filter((shell) => existsSync(shell));

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
    /** Linux launches in the background, so give a launch time to land. */
    async launched() {
      for (let waited = 0; waited < LAUNCH_SETTLE_MS && !existsSync(launches); waited += 50) await delay(50);
      return existsSync(launches) ? readFileSync(launches, "utf8") : "";
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Past the default 15 s wait, so a loop that never ends fails the test. */
const RUN_DEADLINE_MS = 20_000;

function runOpen(shell, project, env) {
  return new Promise((done, fail) => {
    const child = spawn(shell, [cli, "open", project], { env, timeout: RUN_DEADLINE_MS });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", fail);
    child.on("close", (status) => done({ status, stderr }));
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

for (const shell of shells) {
  for (const platform of ["Darwin", "Linux"]) {
    test(`${shell} ${platform}: a missing AYA_SOCKET fails after the wait, launching nothing`, async () => {
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

  test(`${shell}: a missing AYA_HOME instance fails, launching nothing`, async () => {
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

  for (const wait of ["1.5", "30s", "-1", " 2"]) {
    test(`${shell}: AYA_OPEN_WAIT_SECONDS=${JSON.stringify(wait)} is refused at once, launching nothing`, async () => {
      const box = sandbox("Linux");
      try {
        const started = Date.now();
        const { status, stderr } = await runOpen(shell, box.project, {
          ...box.env,
          AYA_SOCKET: join(box.root, "dev.sock"),
          AYA_OPEN_WAIT_SECONDS: wait,
        });
        assert.equal(status, 1);
        assert.ok(Date.now() - started < 900, "waited before refusing");
        assert.ok(stderr.includes(`AYA_OPEN_WAIT_SECONDS must be whole seconds, got '${wait}'`), stderr);
        assert.equal(await box.launched(), "");
      } finally {
        box.cleanup();
      }
    });
  }

  for (const [label, named] of [
    ["AYA_SOCKET", (root) => ({ AYA_SOCKET: join(root, "dev", "aya.sock") })],
    ["AYA_HOME", (root) => ({ AYA_HOME: join(root, "dev") })],
  ]) test(`${shell}: a named ${label} socket that appears within the default wait gets the open request`, async () => {
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
    ["AYA_SOCKET naming the installed app's socket", (home) => ({ AYA_SOCKET: `${home}/.aya/aya.sock` })],
    ["AYA_SOCKET spelled with a literal ~/", () => ({ AYA_SOCKET: "~/.aya/aya.sock" })],
    ["AYA_SOCKET spelled with doubled slashes", (home) => ({ AYA_SOCKET: `${home}//.aya///aya.sock` })],
    ["AYA_HOME naming the installed app's home", (home) => ({ AYA_HOME: `${home}/.aya` })],
    ["AYA_HOME with a trailing slash", (home) => ({ AYA_HOME: `${home}/.aya/` })],
    ["AYA_HOME spelled with a literal ~/", () => ({ AYA_HOME: "~/.aya" })],
  ]) {
    test(`${shell}: ${label} still launches the installed app at once`, async () => {
      const box = sandbox("Linux");
      try {
        const started = Date.now();
        const { status, stderr } = await runOpen(shell, box.project, { ...box.env, ...named(box.home) });
        assert.ok(Date.now() - started < 900, "waited for the installed app's socket");
        assert.equal(status, 0, stderr);
        assert.match(await box.launched(), /^aya-app \/.*project\n$/);
      } finally {
        box.cleanup();
      }
    });
  }
}
