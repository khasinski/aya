import { test } from "node:test";
import assert from "node:assert/strict";

const { RemotePtySessions } = await import("../dist-electron/remote-pty-sessions.js");
const { REMOTE_TERMINAL_REPLAY_MAX_BYTES } = await import("../dist-electron/remote-protocol.js");
const { MAX_PTY_PANES } = await import("../dist-electron/pty-pane-limits.js");

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
  const output = messages.find((message) => message.type === "pty:output");
  assert.equal(attached.truncated, true);
  assert.equal(attached.fromOffset, 17);
  assert.equal(output.offset, 17);
  assert.equal(Buffer.byteLength(output.data, "utf8"), REMOTE_TERMINAL_REPLAY_MAX_BYTES);
  assert.equal(output.data, "x".repeat(REMOTE_TERMINAL_REPLAY_MAX_BYTES));
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
