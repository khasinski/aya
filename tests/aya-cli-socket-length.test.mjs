// A socket path over the OS limit can never be bound, so `aya` must say so instead of
// reporting a missing socket, and the app must refuse to start only when it must.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { CLI_SHELLS, shellOptions } from "./helpers/cli-shells.mjs";

const cli = resolve("bin/aya");
const { homeSocketProblems, socketPathLimit } = await import("../dist-electron/socket-path.js");
const { CONTROL_SOCKET_NAME, PTY_HOST_SOCKET_NAME, REMOTE_SOCKET_NAME } = await import("../dist-electron/paths.js");
const limit = socketPathLimit();

/** A path of exactly `bytes` bytes ending in `name`. */
const pathOf = (bytes, name, fill = "h") => {
  const dir = "/tmp/" + fill.repeat(bytes - "/tmp/".length - name.length - 1);
  return `${dir}/${name}`;
};
const run = (shell, args, env) =>
  spawnSync(shell, [cli, ...args], { env: { ...process.env, AYA_HOME: "", AYA_SOCKET: "", AYA_REMOTE_SOCKET: "", ...env }, encoding: "utf8" });

for (const shell of CLI_SHELLS) {
  test(`aya names the limit when AYA_HOME is one byte too long, and only then (${shell})`, shellOptions(shell), () => {
    const long = run(shell, ["status", "done", "hi"], { AYA_HOME: pathOf(limit + 1, "aya.sock").replace(/\/aya\.sock$/, "") });
    assert.equal(long.status, 1);
    assert.match(long.stderr, /too long/);
    assert.ok(long.stderr.includes(`the limit is ${limit}`), long.stderr);
    const fits = run(shell, ["status", "done", "hi"], { AYA_HOME: pathOf(limit, "aya.sock").replace(/\/aya\.sock$/, "") });
    assert.match(fits.stderr, /control socket not found/);
  });

  test(`a long AYA_SOCKET is blamed on AYA_SOCKET, not AYA_HOME (${shell})`, shellOptions(shell), () => {
    const socket = pathOf(limit + 5, "x.sock");
    const out = run(shell, ["status", "done", "hi"], { AYA_SOCKET: socket });
    assert.equal(out.status, 1);
    assert.match(out.stderr, /too long/);
    assert.match(out.stderr, /set AYA_SOCKET to a shorter path/);
    assert.doesNotMatch(out.stderr, /AYA_HOME/);
  });

  test(`aya remote --stdio says a long AYA_HOME is too long for the remote socket (${shell})`, shellOptions(shell), () => {
    const home = pathOf(limit + 1, "aya-remote.sock").replace(/\/aya-remote\.sock$/, "");
    const out = run(shell, ["remote", "--stdio"], { AYA_HOME: home });
    assert.match(out.stdout + out.stderr, /too long/);
    assert.match(out.stdout + out.stderr, new RegExp(`the limit is ${limit}`));
  });

  test(`bytes, not characters, are counted in a UTF-8 locale (${shell})`, shellOptions(shell), () => {
    // 2-byte characters: under the limit as characters, over it as bytes.
    const home = "/tmp/" + "ż".repeat(Math.floor(limit / 2));
    const out = run(shell, ["status", "done", "hi"], { AYA_HOME: home, LC_ALL: "en_US.UTF-8" });
    assert.match(out.stderr, /too long/);
  });

  test(`aya keeps the plain not-found message for a short AYA_HOME (${shell})`, shellOptions(shell), () => {
    const out = run(shell, ["status", "done", "hi"], { AYA_HOME: "/tmp/aya-nope" });
    assert.equal(out.status, 1);
    assert.match(out.stderr, /control socket not found/);
  });
}

test("the socket path limit per platform, which the CLI tests above hold the CLI to", () => {
  assert.equal(socketPathLimit("darwin"), 104);
  assert.equal(socketPathLimit("linux"), 107);
});

test("the socket names the app checks are the ones bin/aya builds its paths from", () => {
  assert.deepEqual([CONTROL_SOCKET_NAME, PTY_HOST_SOCKET_NAME, REMOTE_SOCKET_NAME], ["aya.sock", "pty-host.sock", "aya-remote.sock"]);
});

test("per socket: control and pty-host are fatal, the remote bridge only degrades", () => {
  const homeFor = (name, bytes) => pathOf(bytes, name).replace(new RegExp(`/${name}$`), "");
  for (const platform of ["darwin", "linux"]) {
    const max = socketPathLimit(platform);
    assert.deepEqual(homeSocketProblems(homeFor("aya-remote.sock", max), platform), { fatal: null, remote: null });
    assert.equal(homeSocketProblems(homeFor("pty-host.sock", max), platform).fatal, null);
    const overRemote = homeSocketProblems(homeFor("aya-remote.sock", max + 1), platform);
    assert.equal(overRemote.fatal, null, "a home that only the remote socket outgrows still runs");
    assert.match(overRemote.remote, /remote/);
    assert.match(overRemote.remote, new RegExp(`the limit is ${max}`));
    const overHost = homeSocketProblems(homeFor("pty-host.sock", max + 1), platform);
    assert.match(overHost.fatal, /AYA_HOME is too long/);
    assert.match(overHost.fatal, new RegExp(`the limit is ${max}`));
  }
});

test("a multibyte AYA_HOME counts bytes in the app too", () => {
  const home = "/" + "ż".repeat(Math.floor(socketPathLimit("darwin") / 2));
  assert.notEqual(homeSocketProblems(home, "darwin").fatal, null);
});
