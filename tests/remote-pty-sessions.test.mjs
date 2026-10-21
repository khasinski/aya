import { test } from "node:test";
import assert from "node:assert/strict";

const { RemotePtySessions } = await import("../dist-electron/remote-pty-sessions.js");
const { REMOTE_TERMINAL_REPLAY_MAX_BYTES } = await import("../dist-electron/remote-protocol.js");
const { MAX_PTY_PANES } = await import("../dist-electron/pty-pane-limits.js");
const { REMOTE_TERMINAL_SOCKET_QUEUE_MAX_BYTES, writeRemoteTerminalFrame } = await import("../dist-electron/remote-terminal-stream.js");

test("remote terminal attach reports truncation and replays no more than the byte limit", async () => {
  const project = { slug: "repo", name: "Repo", directory: "/repo", tabs: [] };
  const preset = { id: "shell", name: "Shell", icon: "$", color: "", command: "sh" };
  const sessions = new RemotePtySessions({
    listProjects: async () => [project],
    listPresets: async () => [preset],
    spawn: async () => {},
    write: async () => true,
    resize: async () => {},
    exit: async () => {},
    newId: () => "terminal-1",
  });
  const socket = { destroyed: false, writableLength: 0, write() { return true; }, destroy() { this.destroyed = true; } };
  const messages = [];
  const writer = (_socket, message) => messages.push(message);
  await sessions.handle(socket, { type: "pty:spawn", protocol: 2, id: "s", project: "repo", preset: "shell", cols: 80, rows: 24 }, writer);
  sessions.onPtyEvent({ type: "data", ptyId: "terminal-1", chunk: "x".repeat(REMOTE_TERMINAL_REPLAY_MAX_BYTES + 17) });

  messages.length = 0;
  await sessions.handle(socket, { type: "pty:attach", protocol: 2, id: "a", terminalId: "terminal-1", offset: 0 }, writer);
  const attached = messages.find((message) => message.type === "pty:attached");
  const outputs = messages.filter((message) => message.type === "pty:output");
  assert.equal(attached.truncated, true);
  assert.equal(attached.fromOffset, 17);
  assert.equal(outputs[0].offset, 17);
  assert.equal(outputs.reduce((sum, output) => sum + Buffer.byteLength(output.data, "utf8"), 0), REMOTE_TERMINAL_REPLAY_MAX_BYTES);
  assert.equal(outputs.map((output) => output.data).join(""), "x".repeat(REMOTE_TERMINAL_REPLAY_MAX_BYTES));
});

test("remote session metadata stays capped and only an exited record is evicted", async () => {
  const project = { slug: "repo", name: "Repo", directory: "/repo", tabs: [] };
  const preset = { id: "shell", name: "Shell", icon: "$", color: "", command: "sh" };
  let nextId = 0;
  const sessions = new RemotePtySessions({
    listProjects: async () => [project],
    listPresets: async () => [preset],
    spawn: async () => {},
    write: async () => true,
    resize: async () => {},
    exit: async () => {},
    newId: () => `terminal-${++nextId}`,
  });
  const socket = { destroyed: false, writableLength: 0, write() { return true; }, destroy() { this.destroyed = true; } };
  const send = async (id) => sessions.handle(socket, { type: "pty:spawn", protocol: 2, id, project: "repo", preset: "shell", cols: 80, rows: 24 }, () => {});
  for (let index = 0; index < MAX_PTY_PANES; index += 1) await send(`spawn-${index}`);
  await sessions.handle(socket, { type: "pty:exit", protocol: 2, id: "exit", terminalId: "terminal-1" }, () => {});
  await send("spawn-last");
  const messages = [];
  await sessions.handle(socket, { type: "pty:list", protocol: 2, id: "list" }, (_socket, message) => messages.push(message));
  assert.equal(messages[0].terminals.length, MAX_PTY_PANES);
  assert.equal(messages[0].terminals.some((item) => item.terminalId === "terminal-1"), false);
  assert.equal(messages[0].terminals.some((item) => item.terminalId === `terminal-${MAX_PTY_PANES + 1}`), true);
});

test("a host spawn refusal stays a failure with its reason, not a synthetic process exit", async () => {
  const project = { slug: "repo", name: "Repo", directory: "/repo", tabs: [] };
  const preset = { id: "shell", name: "Shell", icon: "$", color: "", command: "sh" };
  let sessions;
  let persisted = 0;
  sessions = new RemotePtySessions({
    listProjects: async () => [project],
    listPresets: async () => [preset],
    spawn: async (terminalId) => {
      sessions.onPtyEvent({ type: "spawn-failed", ptyId: terminalId, reason: "pane-limit-reached", detail: "Aya can run at most 128 terminals at once." });
      sessions.onPtyEvent({ type: "data", ptyId: terminalId, chunk: "spawn failure banner" });
      sessions.onPtyEvent({ type: "exit", ptyId: terminalId, exitCode: 127 });
    },
    onSpawned: async () => { persisted += 1; },
    write: async () => true,
    resize: async () => {},
    exit: async () => {},
    newId: () => "terminal-refused",
  });
  const socket = { destroyed: false, writableLength: 0, write() { return true; }, destroy() { this.destroyed = true; } };
  const messages = [];
  await sessions.handle(socket, { type: "pty:spawn", protocol: 2, id: "spawn", project: "repo", preset: "shell", cols: 80, rows: 24 }, (_socket, message) => messages.push(message));
  assert.equal(messages.some((message) => message.type === "pty:spawned"), false);
  assert.equal(messages.some((message) => message.type === "pty:exited"), false);
  assert.equal(persisted, 0);
  assert.equal(messages.find((message) => message.type === "error")?.message, "Aya can run at most 128 terminals at once.");
  const listed = [];
  await sessions.handle(socket, { type: "pty:list", protocol: 2, id: "list" }, (_socket, message) => listed.push(message));
  assert.equal(listed[0].terminals[0].state, "failed");
  assert.equal(listed[0].terminals[0].failureReason, "Aya can run at most 128 terminals at once.");
});

test("failed remote spawn records are evicted before a valid spawn is refused", async () => {
  const project = { slug: "repo", name: "Repo", directory: "/repo", tabs: [] };
  const preset = { id: "shell", name: "Shell", icon: "$", color: "", command: "sh" };
  let next = 0;
  const sessions = new RemotePtySessions({
    listProjects: async () => [project],
    listPresets: async () => [preset],
    spawn: async (terminalId) => {
      if (terminalId !== "terminal-valid") {
        sessions.onPtyEvent({ type: "spawn-failed", ptyId: terminalId, reason: "spawn-prepare-failed", detail: "Preset could not be started." });
        sessions.onPtyEvent({ type: "exit", ptyId: terminalId, exitCode: 127 });
      }
    },
    write: async () => true,
    resize: async () => {},
    exit: async () => {},
    newId: () => ++next === MAX_PTY_PANES + 1 ? "terminal-valid" : `failed-${next}`,
  });
  const socket = { destroyed: false, writableLength: 0, write() { return true; }, destroy() { this.destroyed = true; } };
  for (let index = 0; index < MAX_PTY_PANES; index += 1) {
    await sessions.handle(socket, { type: "pty:spawn", protocol: 2, id: `failed-${index}`, project: "repo", preset: "shell", cols: 80, rows: 24 }, () => {});
  }
  const result = [];
  await sessions.handle(socket, { type: "pty:spawn", protocol: 2, id: "last", project: "repo", preset: "shell", cols: 80, rows: 24 }, (_socket, message) => result.push(message));
  assert.equal(result.some((message) => message.type === "pty:spawned" && message.terminalId === "terminal-valid"), true);
  const listed = [];
  await sessions.handle(socket, { type: "pty:list", protocol: 2, id: "list" }, (_socket, message) => listed.push(message));
  assert.equal(listed[0].terminals.length, MAX_PTY_PANES);
  assert.equal(listed[0].terminals.some((item) => item.terminalId === "failed-1"), false);
  assert.equal(listed[0].terminals.some((item) => item.terminalId === "terminal-valid"), true);
});

test("a non-reading v2 socket stays under the queue cap for replay and list replies", async () => {
  const project = { slug: "repo", name: "Repo", directory: "/repo", tabs: [] };
  const preset = { id: "shell", name: "Shell", icon: "$", color: "", command: "sh" };
  const sessions = new RemotePtySessions({
    listProjects: async () => [project],
    listPresets: async () => [preset],
    spawn: async () => {},
    write: async () => true,
    resize: async () => {},
    exit: async () => {},
    newId: () => "terminal-slow",
  });
  let nextId = 0;
  const slow = () => ({
    destroyed: false,
    writableLength: 0,
    frames: [],
    write(frame) { this.frames.push(JSON.parse(frame)); this.writableLength += Buffer.byteLength(frame, "utf8"); return true; },
    destroy() { this.destroyed = true; },
  });
  const socket = slow();
  const cappedWriter = (target, message) => writeRemoteTerminalFrame(target, message);
  await sessions.handle(socket, { type: "pty:spawn", protocol: 2, id: "spawn", project: "repo", preset: "shell", cols: 80, rows: 24 }, cappedWriter);
  const terminalId = "terminal-slow";
  assert.equal(socket.frames.some((message) => message.type === "pty:spawned"), true);
  sessions.onPtyEvent({ type: "data", ptyId: "terminal-slow", chunk: "\u0001".repeat(REMOTE_TERMINAL_REPLAY_MAX_BYTES) });
  const replyAndReplay = slow();
  await sessions.handle(replyAndReplay, { type: "pty:attach", protocol: 2, id: "attach", terminalId, offset: 0 }, cappedWriter);
  assert.equal(replyAndReplay.destroyed, true);
  assert.equal(replyAndReplay.writableLength <= REMOTE_TERMINAL_SOCKET_QUEUE_MAX_BYTES, true);
  assert.equal(replyAndReplay.frames.some((message) => message.type === "pty:attached"), true);
  assert.equal(replyAndReplay.frames.some((message) => message.type === "pty:output"), true);

  const manySessions = new RemotePtySessions({
    listProjects: async () => [project],
    listPresets: async () => [preset],
    spawn: async (id) => manySessions.onPtyEvent({ type: "spawn-failed", ptyId: id, reason: "spawn-prepare-failed", detail: "x".repeat(3000) }),
    write: async () => true,
    resize: async () => {},
    exit: async () => {},
    newId: (() => { let id = 0; return () => `list-target-${++id}`; })(),
  });
  for (let index = 0; index < MAX_PTY_PANES; index += 1) {
    await manySessions.handle(socket, { type: "pty:spawn", protocol: 2, id: `seed-${index}`, project: "repo", preset: "shell", cols: 80, rows: 24 }, () => {});
  }
  const listSocket = slow();
  for (let index = 0; index < 10 && !listSocket.destroyed; index += 1) {
    await manySessions.handle(listSocket, { type: "pty:list", protocol: 2, id: `list-${index}` }, cappedWriter);
  }
  assert.equal(listSocket.destroyed, true);
  assert.equal(listSocket.writableLength <= REMOTE_TERMINAL_SOCKET_QUEUE_MAX_BYTES, true);
});
