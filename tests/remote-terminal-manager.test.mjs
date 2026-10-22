import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const { RemoteTerminalManager, isUnsupportedV2 } = await import("../dist-electron/remote-terminal-manager.js");

class FakeTerminalClient extends EventEmitter {
  calls = [];
  readOnly = false;
  failSpawn = null;
  failAttach = null;
  outputDuringSpawn = null;
  async spawnTerminal(project, preset, cols, rows, terminalId) {
    this.calls.push(["spawn", project, preset, cols, rows, terminalId]);
    if (this.failSpawn) throw this.failSpawn;
    if (this.outputDuringSpawn) this.emit("output", { terminalId, offset: 0, data: this.outputDuringSpawn });
    return { terminalId };
  }
  async attach(terminalId, offset) {
    this.calls.push(["attach", terminalId, offset]);
    if (this.failAttach) throw this.failAttach;
    return { terminalId, fromOffset: 0, endOffset: 0, truncated: false, readOnly: this.readOnly };
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
  await assert.rejects(manager.write("tab-uuid", "blocked"), /another Aya controls this terminal/i);
  await assert.rejects(manager.resize("tab-uuid", 100, 32), /another Aya controls this terminal/i);
  await assert.rejects(manager.end("tab-uuid"), /another Aya controls this terminal/i);
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
