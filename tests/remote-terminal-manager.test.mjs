import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const { RemoteTerminalManager, RemoteReconnectBackoff, isUnsupportedV2 } = await import("../dist-electron/remote-terminal-manager.js");

class FakeTerminalClient extends EventEmitter {
  calls = [];
  readOnly = false;
  failSpawn = null;
  failAttach = null;
  outputDuringSpawn = null;
  attachOutput = null;
  attachEndOffset = 0;
  attachTruncated = false;
  async spawnTerminal(project, preset, cols, rows, terminalId) {
    this.calls.push(["spawn", project, preset, cols, rows, terminalId]);
    if (this.failSpawn) throw this.failSpawn;
    if (this.outputDuringSpawn) this.emit("output", { terminalId, offset: 0, data: this.outputDuringSpawn });
    return { terminalId };
  }
  async attach(terminalId, offset) {
    this.calls.push(["attach", terminalId, offset]);
    if (this.failAttach) throw this.failAttach;
    if (this.attachOutput) setImmediate(() => this.emit("output", { terminalId, offset, data: this.attachOutput }));
    return { terminalId, fromOffset: this.attachTruncated ? Math.max(0, offset - 1) : offset, endOffset: this.attachEndOffset, truncated: this.attachTruncated, readOnly: this.readOnly };
  }
  async write(terminalId, data) { this.calls.push(["write", terminalId, data]); return true; }
  async resize(terminalId, cols, rows) { this.calls.push(["resize", terminalId, cols, rows]); }
  async exit(terminalId) { this.calls.push(["exit", terminalId]); }
  async detach() { this.calls.push(["detach"]); }
}

const request = { ptyId: "tab-uuid", projectSlug: "remote-repo", presetId: "codex", cols: 90, rows: 28 };

test("remote pane writes and resizes through v2, detaches without ending, and reattaches for replay", async () => {
  const clients = [];
  const events = [];
  const manager = new RemoteTerminalManager({
    connect: (target) => { assert.equal(target, "devbox"); const client = new FakeTerminalClient(); clients.push(client); return client; },
    sendEvent: (event) => events.push(event),
  });

  assert.equal(await manager.spawn(request, "devbox", "remote-repo"), "remote");
  assert.deepEqual(clients[0].calls.slice(0, 2), [
    ["spawn", "remote-repo", "codex", 90, 28, "tab-uuid"],
    ["attach", "tab-uuid", 0],
  ]);
  clients[0].emit("output", { terminalId: "tab-uuid", offset: 0, data: "first" });
  assert.deepEqual(events[0], { type: "remote-control", ptyId: "tab-uuid", controlled: false, readOnly: false });
  assert.deepEqual(events[1], { type: "data", ptyId: "tab-uuid", chunk: "first" });
  assert.equal(await manager.write("tab-uuid", "typed"), true);
  assert.equal(await manager.resize("tab-uuid", 100, 32), true);

  assert.equal(await manager.detach("tab-uuid"), true);
  assert.equal(clients[0].calls.some(([kind]) => kind === "exit"), false);
  assert.equal(clients[0].calls.at(-1)[0], "detach");
  assert.equal(await manager.spawn({ ...request, attachOnly: true }, "devbox", "remote-repo"), "remote");
  assert.deepEqual(clients[1].calls, [["attach", "tab-uuid", 5]]);
  clients[1].emit("output", { terminalId: "tab-uuid", offset: 0, data: "replayed" });
  assert.equal(events.at(-1).chunk, "replayed");
});

test("a read-only attachment refuses writes and explicit end", async () => {
  const client = new FakeTerminalClient();
  client.readOnly = true;
  const events = [];
  const manager = new RemoteTerminalManager({ connect: () => client, sendEvent: (event) => events.push(event) });
  await manager.spawn({ ...request, attachOnly: true }, "devbox", "remote-repo");
  assert.equal(events[0].type, "remote-control");
  assert.equal(events[0].readOnly, true);
  await assert.rejects(manager.write("tab-uuid", "blocked"), /another Aya controls this host/i);
  await assert.rejects(manager.resize("tab-uuid", 100, 32), /another Aya controls this host/i);
  await assert.rejects(manager.end("tab-uuid"), /another Aya controls this host/i);
  assert.equal(client.calls.some(([kind]) => kind === "write" || kind === "resize" || kind === "exit"), false);
});

test("live output delivered during spawn is not replayed a second time on attach", async () => {
  const client = new FakeTerminalClient();
  client.outputDuringSpawn = "early-output";
  const events = [];
  const manager = new RemoteTerminalManager({ connect: () => client, sendEvent: (event) => events.push(event) });
  await manager.spawn(request, "devbox", "remote-repo");
  assert.deepEqual(client.calls.slice(0, 2), [
    ["spawn", "remote-repo", "codex", 90, 28, "tab-uuid"],
    ["attach", "tab-uuid", Buffer.byteLength("early-output")],
  ]);
  assert.equal(events.filter((event) => event.type === "data" && event.chunk === "early-output").length, 1);
});

test("an older host falls back to the SSH terminal once with a visible notice", async () => {
  const client = new FakeTerminalClient();
  client.failSpawn = new Error("Remote Aya does not support terminal protocol version 2; update Aya on the host.");
  const events = [];
  let connections = 0;
  const manager = new RemoteTerminalManager({ connect: () => { connections += 1; return client; }, sendEvent: (event) => events.push(event) });
  assert.equal(isUnsupportedV2(client.failSpawn), true);
  assert.equal(await manager.spawn(request, "devbox", "remote-repo"), "legacy");
  assert.match(events[0].chunk, /direct SSH terminal/i);
  assert.equal(await manager.spawn(request, "devbox", "remote-repo"), "legacy");
  assert.equal(connections, 1);
});

test("an explicitly restarted pane creates a new session after an attach reports no session", async () => {
  const events = [];
  const clients = [];
  const attachOnly = { ...request, attachOnly: true };
  const missingSessionClient = new FakeTerminalClient();
  missingSessionClient.failAttach = new Error("The remote terminal is no longer available.");
  clients.push(missingSessionClient);
  let first = true;
  const firstManager = new RemoteTerminalManager({
    connect: () => {
      if (first) { first = false; return clients[0]; }
      const client = new FakeTerminalClient();
      clients.push(client);
      return client;
    },
    sendEvent: (event) => events.push(event),
  });
  assert.equal(await firstManager.spawn(attachOnly, "devbox", "remote-repo"), "remote");
  assert.equal(events.at(-1).type, "no-session");
  assert.equal(firstManager.has("tab-uuid"), false);
  assert.equal(await firstManager.spawn(request, "devbox", "remote-repo"), "remote");
  assert.deepEqual(clients[1].calls[0], ["spawn", "remote-repo", "codex", 90, 28, "tab-uuid"]);
});

test("a truncated remote replay resets the local display before replay bytes are delivered", async () => {
  const client = new FakeTerminalClient();
  client.attachTruncated = true;
  client.attachOutput = "recent suffix";
  client.attachEndOffset = 20;
  const events = [];
  const manager = new RemoteTerminalManager({ connect: () => client, sendEvent: event => events.push(event) });

  await manager.spawn({ ...request, attachOnly: true }, "devbox", "remote-repo");
  assert.equal(events[0].type, "remote-replay-truncated");
  assert.deepEqual(events[0], { type: "remote-replay-truncated", ptyId: request.ptyId });
  await new Promise(resolve => setImmediate(resolve));
  const replayIndex = events.findIndex(event => event.type === "data" && event.chunk === "recent suffix");
  assert.ok(replayIndex > 0);
  assert.ok(events.findIndex(event => event.type === "remote-replay-truncated") < replayIndex);
  client.emit("output", { terminalId: request.ptyId, offset: 19, data: "recent suffix" });
  assert.equal(events.at(-1).type, "data");
  assert.equal(events.at(-1).chunk, "recent suffix");
});

test("remote output pauses its bridge until the renderer acknowledges delivery", async () => {
  const client = Object.assign(new FakeTerminalClient(), {
    outputPaused: false,
    pauseOutput() { this.outputPaused = true; },
    resumeOutput() { this.outputPaused = false; },
  });
  const events = [];
  const manager = new RemoteTerminalManager({ connect: () => client, outputSinks: () => [101], sendEvent: event => events.push(event) });
  await manager.spawn(request, "devbox", "remote-repo");
  client.emit("output", { terminalId: request.ptyId, offset: 0, data: "render this" });
  const delivered = events.find(event => event.type === "data");
  assert.equal(delivered.chunk, "render this");
  assert.equal(typeof delivered.remoteDeliveryId, "string");
  assert.equal(client.outputPaused, true);
  assert.equal(manager.acknowledgeOutput(request.ptyId, "stale-delivery", 101), false);
  assert.equal(manager.acknowledgeOutput(request.ptyId, delivered.remoteDeliveryId, 202), false);
  assert.equal(manager.acknowledgeOutput(request.ptyId, delivered.remoteDeliveryId, 101), true);
  assert.equal(client.outputPaused, false);
  assert.equal(manager.acknowledgeOutput(request.ptyId, delivered.remoteDeliveryId), false);
});

test("remote output waits for every renderer sink and drops closed windows", async () => {
  const client = Object.assign(new FakeTerminalClient(), {
    outputPaused: false,
    pauseOutput() { this.outputPaused = true; },
    resumeOutput() { this.outputPaused = false; },
  });
  const events = [];
  const manager = new RemoteTerminalManager({ connect: () => client, outputSinks: () => [11, 22], sendEvent: event => events.push(event) });
  await manager.spawn(request, "devbox", "remote-repo");
  client.emit("output", { terminalId: request.ptyId, offset: 0, data: "bounded frame" });
  const delivered = events.find(event => event.type === "data");
  assert.ok(delivered.remoteDeliveryId);
  assert.equal(client.outputPaused, true);
  assert.equal(manager.acknowledgeOutput(request.ptyId, delivered.remoteDeliveryId, 11), true);
  assert.equal(client.outputPaused, true, "fast window cannot resume delivery while the second window is stalled");
  manager.forgetOutputSink(22);
  assert.equal(client.outputPaused, false, "closing the stalled window releases its outstanding acknowledgement");
});

test("restarting a pane after its remote process exits starts a fresh host terminal", async () => {
  const events = [];
  const clients = [];
  const manager = new RemoteTerminalManager({
    connect: () => { const client = new FakeTerminalClient(); clients.push(client); return client; },
    sendEvent: (event) => events.push(event),
  });

  assert.equal(await manager.spawn(request, "devbox", "remote-repo"), "remote");
  clients[0].emit("exit", { terminalId: "tab-uuid", exitCode: 0 });
  assert.deepEqual(events.at(-1), { type: "exit", ptyId: "tab-uuid", exitCode: 0 });

  assert.equal(await manager.spawn(request, "devbox", "remote-repo"), "remote");
  assert.deepEqual(clients[1].calls.slice(0, 2), [
    ["spawn", "remote-repo", "codex", 90, 28, "tab-uuid"],
    ["attach", "tab-uuid", 0],
  ]);
  assert.equal(clients[0].calls.at(-1)[0], "detach");
});

test("remote reconnect backs off, resumes at the last offset, and replays the gap once", async () => {
  const delays = [];
  const events = [];
  const clients = [];
  const manager = new RemoteTerminalManager({
    connect: () => {
      const client = new FakeTerminalClient();
      if (clients.length === 1) client.failAttach = new Error("host still unavailable");
      if (clients.length === 2) { client.attachOutput = "gap"; client.attachEndOffset = 8; }
      clients.push(client);
      return client;
    },
    sendEvent: (event) => events.push(event),
    schedule: (callback, delayMs) => {
      const task = { callback, delayMs, cancelled: false };
      delays.push(task);
      return () => { task.cancelled = true; };
    },
  });
  assert.equal(await manager.spawn(request, "devbox", "remote-repo", "Dev box"), "remote");
  clients[0].emit("output", { terminalId: request.ptyId, offset: 0, data: "start" });
  clients[0].emit("error", new Error("bridge lost"));
  assert.deepEqual(events.at(-1), { type: "remote-connection", ptyId: request.ptyId, host: "Dev box", connected: false, retryInMs: 1_000 });
  await assert.rejects(manager.write(request.ptyId, "must not leak"), /disconnected/i);

  const run = async () => {
    const task = delays.find(item => !item.cancelled && !item.ran);
    assert.ok(task);
    task.ran = true;
    task.callback();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
  };
  assert.equal(delays[0].delayMs, 1_000);
  await run();
  assert.equal(delays[1].delayMs, 2_000);
  await run();
  assert.deepEqual(clients[2].calls[0], ["attach", request.ptyId, 5]);
  assert.equal(events.filter(event => event.type === "data" && event.chunk === "gap").length, 1);
  const connectedIndex = events.findIndex(event => event.type === "remote-connection" && event.connected);
  const replayIndex = events.findIndex(event => event.type === "data" && event.chunk === "gap");
  assert.ok(connectedIndex >= 0);
  assert.ok(replayIndex > connectedIndex, "replay is delivered after the client resumes reading");
  assert.equal(await manager.write(request.ptyId, "after reconnect"), true);
});

test("remote reconnect backoff resets after success and then repeats its last delay", () => {
  const backoff = new RemoteReconnectBackoff();
  assert.deepEqual(Array.from({ length: 8 }, () => backoff.next()), [1_000, 2_000, 5_000, 10_000, 30_000, 30_000, 30_000, 30_000]);
  backoff.reset();
  assert.equal(backoff.next(), 1_000);
});
