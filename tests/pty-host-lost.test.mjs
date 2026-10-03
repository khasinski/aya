// The pty host dying under a running app takes every agent with it: the tabs must say so. A host the app itself
// told to go is handled by the renderer and stays silent. HOME and AYA_HOME are fake.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = realpathSync(mkdtempSync(join(tmpdir(), "aya-lost-")));
process.env.AYA_HOME = join(root, "aya-home");
process.env.HOME = join(root, "home");
process.env.PATH = "/usr/bin:/bin";
process.env.SHELL = "/bin/sh";
mkdirSync(process.env.HOME);
const cwd = join(root, "project");
mkdirSync(cwd);

const { PtyHostClient } = await import("../dist-electron/pty-host-client.js");
const { waitFor } = await import("./helpers/pty-host.mjs");

const HOST_SCRIPT = join(process.cwd(), "dist-electron", "pty-host.js");
const typeOf = (events, ptyId) => events.filter((e) => e.ptyId === ptyId).map((e) => e.type);

/** A client with four panes: a, b running (b has reported a status, which is not its end); c exited on its own; d killed by the app. */
async function session() {
  const events = [];
  const client = new PtyHostClient(HOST_SCRIPT);
  client.attachWebContents({ isDestroyed: () => false, send: (_channel, event) => events.push(event) });
  const spawn = (ptyId, command) => client.spawn({ ptyId, command, cwd, cols: 80, rows: 24 });
  await spawn("a", "sleep 120");
  await spawn("b", "printf '\\033]9001;aya.status=waiting:Approval needed\\007'; sleep 120");
  await spawn("c", "true");
  await spawn("d", "sleep 120");
  await waitFor(() => typeOf(events, "c").includes("exit") && typeOf(events, "b").includes("osc-status"));
  await client.kill("d");
  const { pid } = await client.hostStatus();
  assert.ok(pid > 1, "the host reports its pid");
  // A socket close is the boundary after which all its data/end events and
  // the client's close handler have run. Observe it before provoking a loss.
  const closed = new Promise((resolve) => client.socket.once("close", resolve));
  return { events, client, pid, closed };
}

async function disposeSession(s) {
  // A failed assertion can leave the replacement host alive. Only shut down
  // the socket this fixture already owns; never reconnect/start one in cleanup.
  if (s.client.socket && !s.client.socket.destroyed) await s.client.shutdown().catch(() => {});
  s.client.dispose();
}

const LOST = [
  // A killed host says nothing; a host told to stop may report exits itself first.
  ["SIGKILL from outside", (s) => process.kill(-s.pid, "SIGKILL"), ["no-session"]],
  ["SIGTERM from outside", (s) => process.kill(s.pid, "SIGTERM"), ["no-session", "exit"]],
];
for (const [how, end, told] of LOST) {
  test(`${how}: the panes still running are told, the ones already gone are not`, async (t) => {
    const s = await session();
    t.after(() => disposeSession(s));
    end(s);
    await waitFor(() => typeOf(s.events, "a").some((type) => told.includes(type)));
    await s.closed;
    for (const id of ["a", "b"]) {
      assert.ok(typeOf(s.events, id).some((type) => told.includes(type)), `${id} was not told its host is gone`);
    }
    assert.ok(!typeOf(s.events, "c").includes("no-session"), "c had already exited");
    assert.ok(!typeOf(s.events, "d").includes("no-session"), "d had been closed by the app");
  });
}

const ASKED = [
  ["restart()", (s) => s.client.restart()],
  ["shutdown()", (s) => s.client.shutdown()],
];
for (const [how, end] of ASKED) {
  test(`${how}: the app asked for it, so no pane is reported lost`, async (t) => {
    const s = await session();
    t.after(() => disposeSession(s));
    await end(s);
    await s.closed;
    assert.deepEqual(s.events.filter((e) => e.type === "no-session"), []);
  });
}

test("after restart(), a pane on the new host is reported lost when that host dies", async (t) => {
  const s = await session();
  t.after(() => disposeSession(s));
  await s.client.restart();
  await s.closed;
  await s.client.spawn({ ptyId: "e", command: "sleep 120", cwd, cols: 80, rows: 24 });
  const { pid } = await s.client.hostStatus();
  assert.notEqual(pid, s.pid, "restart() started a new host");
  process.kill(-pid, "SIGKILL");
  await waitFor(() => typeOf(s.events, "e").includes("no-session"));
});

test("a spawn right after restart() survives the old socket's late close", async (t) => {
  const s = await session();
  t.after(() => disposeSession(s));
  await s.client.restart();
  await s.client.spawn({ ptyId: "e", command: "sleep 120", cwd, cols: 80, rows: 24 });
  const socket = s.client.socket;
  await s.closed;
  assert.deepEqual([...s.client.live], ["e"], "e is still tracked");
  assert.ok(socket && s.client.socket === socket && !socket.destroyed, "the new connection is kept");
  const { pid } = await s.client.hostStatus();
  assert.ok(pid > 1 && pid !== s.pid, "the client still talks to the new host");
  process.kill(-pid, "SIGKILL");
  await waitFor(() => typeOf(s.events, "e").includes("no-session"));
});

test("a spawn refused after dispose() is not a pane the host could lose", async (t) => {
  const s = await session();
  s.client.dispose();
  await assert.rejects(s.client.spawn({ ptyId: "x", command: "sleep 120", cwd, cols: 80, rows: 24 }));
  process.kill(-s.pid, "SIGKILL");
  await waitFor(() => typeOf(s.events, "a").includes("no-session"));
  await s.closed;
  assert.deepEqual(typeOf(s.events, "x"), []);
});
