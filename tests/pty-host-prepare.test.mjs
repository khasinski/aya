// The host reserves the spawn flight before main runs agent-specific work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const root = mkdtempSync(join(tmpdir(), "aya-prepare-"));
process.env.AYA_HOME = root;
process.env.SHELL = "/bin/sh";
process.env.AYA_PTY_PREPARE_TIMEOUT_MS = "500";
const { PtyHostClient } = await import("../dist-electron/pty-host-client.js");
const { prepareSpawn } = await import("../dist-electron/pty-prepare.js");
const { waitFor, fakeWebContents, ptyEventsFor } = await import("./helpers/pty-host.mjs");
const host = join(process.cwd(), "dist-electron/pty-host.js");
const req = (id) => ({ ptyId: id, command: "cat", cwd: root, cols: 80, rows: 24 });
function gate() {
  let release, entered;
  const arrived = new Promise((r) => entered = r);
  const wait = new Promise((r) => release = r);
  return { release, arrived, prepare: async (request, cwd) => { entered(); await wait; return prepareSpawn(request, cwd); } };
}
test("writes queued during main preparation reach the live PTY, in order", async (t) => {
  const g = gate(), client = new PtyHostClient(host, g.prepare), wc = fakeWebContents();
  client.attachWebContents(wc);
  t.after(() => client.shutdown().catch(() => {}));
  const started = client.spawn(req("queued"));
  await g.arrived;
  const written = client.write("queued", "FROM-PREPARE\n");
  assert.equal(await client.launch("queued"), "starting");
  g.release();
  await started;
  assert.equal(await written, true);
  await waitFor(() => ptyEventsFor(wc, "queued").some((e) => e.type === "data" && e.chunk.includes("FROM-PREPARE")));
});
test("a kill mid-prepare cancels that flight and a restart starts the successor", async (t) => {
  const g = gate(), client = new PtyHostClient(host, g.prepare);
  t.after(() => client.shutdown().catch(() => {}));
  const first = client.spawn(req("killed"));
  await g.arrived;
  const discarded = client.write("killed", "DISCARDED\n");
  await client.kill("killed");
  await first;
  assert.equal(await discarded, false);
  assert.equal(await client.getPid("killed"), null);
  g.release();
  await client.spawn(req("killed"));
  assert.ok(await client.getPid("killed"));
});
test("main disconnecting mid-prepare leaves no child or starting flight", async (t) => {
  const g = gate(), client = new PtyHostClient(host, g.prepare);
  const started = client.spawn(req("disconnected")).catch((err) => err);
  await g.arrived;
  client.dispose();
  client.dropSocket();
  await started;
  const observer = new PtyHostClient(host);
  t.after(() => observer.shutdown().catch(() => {}));
  await waitFor(async () => (await observer.launch("disconnected")) === null);
  assert.equal(await observer.getPid("disconnected"), null);
  g.release();
});
test("a silent main times out with a clear spawn failure and releases input waiters", async (t) => {
  const g = gate(), client = new PtyHostClient(host, g.prepare), wc = fakeWebContents();
  client.attachWebContents(wc);
  t.after(() => client.shutdown().catch(() => {}));
  const started = client.spawn(req("timeout"));
  await g.arrived;
  const written = client.write("timeout", "no\n");
  await started;
  assert.equal(await written, false);
  assert.equal(await client.launch("timeout"), null);
  const failure = ptyEventsFor(wc, "timeout").find((e) => e.type === "spawn-failed");
  assert.equal(failure.reason, "spawn-prepare-failed");
  assert.match(failure.detail, /timed out/);
  g.release();
});
test("a host restart while main prepares cannot launch a child in the old host", async (t) => {
  const g = gate(), client = new PtyHostClient(host, g.prepare);
  t.after(() => client.shutdown().catch(() => {}));
  const started = client.spawn(req("restart")).catch(() => {});
  await g.arrived;
  assert.equal(await client.restart(), true);
  await started;
  g.release();
  assert.equal(await client.getPid("restart"), null);
});
test("unknown or inherited request names and nonnumeric preparation ids get clean errors", async (t) => {
  const client = new PtyHostClient(host);
  t.after(() => client.shutdown().catch(() => {}));
  for (const name of ["unknown", "constructor", "__proto__", "toString"]) {
    await assert.rejects(client.request({ id: 0, type: name }), { message: "unknown request" });
    await assert.rejects(client.request({ id: 0, type: "prepared", prepareId: name, data: {} }),
      { message: "invalid preparation id" });
  }
  // Expired numeric replies remain harmless, and rejected requests do not break the host connection.
  await client.request({ id: 0, type: "prepared", prepareId: 999999, data: {} });
  assert.ok((await client.hostStatus()).pid);
});
test.after(() => rmSync(root, { force: true, recursive: true }));
