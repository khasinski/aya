import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { RemotePtySessions } = await import("../dist-electron/remote-pty-sessions.js");
const { restoreRemoteTerminalSessions } = await import("../dist-electron/remote-session-restore.js");
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

test("main-process restoration rebuilds a live session at the host output offset and retains ended tabs", async () => {
  const project = { slug: "repo", name: "Repo", directory: "/repo", tabs: [] };
  const preset = { id: "shell", name: "Shell", icon: "$", color: "", command: "sh" };
  const sessions = new RemotePtySessions({
    listProjects: async () => [project], listPresets: async () => [preset],
    spawn: async () => {}, write: async () => true, resize: async () => {}, exit: async () => {},
  });
  sessions.restoreTerminal({ terminalId: "live-after-main-restart", project: "repo", preset: "shell", output: "base", endOffset: 4, running: true, processIdentity: { pid: 100, startIdentity: "start" } });
  sessions.restoreTerminal({ terminalId: "ended-after-main-restart", project: "repo", preset: "shell", output: "done", endOffset: 4, running: false });
  // An event that was already included in the snapshot is ignored, while the
  // first byte after its high-water mark is appended once.
  sessions.onPtyEvent({ type: "data", ptyId: "live-after-main-restart", chunk: "base", streamOffset: 0 });
  sessions.onPtyEvent({ type: "data", ptyId: "live-after-main-restart", chunk: "gap", streamOffset: 4 });
  const socket = { destroyed: false, writableLength: 0, write() { return true; }, destroy() { this.destroyed = true; } };
  const replay = [];
  await sessions.handle(socket, { type: "pty:attach", protocol: 2, id: "attach-live", terminalId: "live-after-main-restart", offset: 4 }, (_socket, message) => replay.push(message));
  assert.equal(replay.find(message => message.type === "pty:attached").endOffset, 7);
  assert.equal(replay.filter(message => message.type === "pty:output").map(message => message.data).join(""), "gap");
  const ended = [];
  await sessions.handle(socket, { type: "pty:attach", protocol: 2, id: "attach-ended", terminalId: "ended-after-main-restart", offset: 0 }, (_socket, message) => ended.push(message));
  assert.equal(ended.some(message => message.type === "pty:output" && message.data === "done"), true);
  assert.equal(ended.some(message => message.type === "pty:exited"), true);
});

test("remote session restore discovers durable tabs, marks dead PTYs exited, and catches up across subscription", async () => {
  const project = { slug: "repo", name: "Repo", directory: "/repo", tabs: [
    { id: "restored-live", presetId: "shell", name: "Remote Shell", remoteTerminal: true },
    { id: "restored-dead", presetId: "shell", name: "Remote Shell 2", remoteTerminal: true },
    { id: "ordinary", presetId: "shell", name: "Shell" },
  ] };
  const preset = { id: "shell", name: "Shell", icon: "$", color: "", command: "sh" };
  const sessions = new RemotePtySessions({ listProjects: async () => [project], listPresets: async () => [preset], spawn: async () => {}, write: async () => true, resize: async () => {}, exit: async () => {} });
  const outputCalls = new Map();
  let attached = 0;
  const count = await restoreRemoteTerminalSessions({
    sessions,
    listProjects: async () => [project],
    getPid: async (id) => id === "restored-live" ? 321 : null,
    getOutput: async (id) => {
      if (id === "restored-dead") return { output: "ended", endOffset: 5 };
      const call = (outputCalls.get(id) ?? 0) + 1; outputCalls.set(id, call);
      return call === 1 ? { output: "base", endOffset: 4 } : { output: "basegap", endOffset: 7 };
    },
    processStartIdentity: (pid) => pid === 321 ? "process-start" : null,
    isAlive: () => true,
    attach: () => { attached += 1; sessions.onPtyEvent({ type: "data", ptyId: "restored-live", chunk: "gap", streamOffset: 4 }); },
  });
  assert.equal(count, 2);
  assert.equal(attached, 1);
  const socket = { destroyed: false, writableLength: 0, write() { return true; }, destroy() { this.destroyed = true; } };
  const listed = [];
  await sessions.handle(socket, { type: "pty:list", protocol: 2, id: "list" }, (_socket, message) => listed.push(message));
  assert.deepEqual(listed[0].terminals.map(item => [item.terminalId, item.state]), [["restored-live", "running"], ["restored-dead", "exited"]]);
  const replay = [];
  await sessions.handle(socket, { type: "pty:attach", protocol: 2, id: "attach", terminalId: "restored-live", offset: 4 }, (_socket, message) => replay.push(message));
  assert.equal(replay.filter(message => message.type === "pty:output").map(message => message.data).join(""), "gap");
});

test("remote session restore deduplicates and caps records with bounded host-probe concurrency", async () => {
  const tabs = Array.from({ length: MAX_PTY_PANES + 30 }, (_, index) => ({
    id: `remote-${index}`, presetId: "shell", name: `Remote ${index}`, remoteTerminal: true,
  }));
  tabs.push({ ...tabs[0] });
  const project = { slug: "repo", name: "Repo", directory: "/repo", tabs };
  const preset = { id: "shell", name: "Shell", icon: "$", color: "", command: "sh" };
  const sessions = new RemotePtySessions({
    listProjects: async () => [project], listPresets: async () => [preset],
    spawn: async () => {}, write: async () => true, resize: async () => {}, exit: async () => {},
  });
  let active = 0;
  let maxActive = 0;
  let pidCalls = 0;
  let outputCalls = 0;
  const probe = async (kind) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (kind === "pid") pidCalls += 1;
    else outputCalls += 1;
    await new Promise(resolve => setImmediate(resolve));
    active -= 1;
  };
  const count = await restoreRemoteTerminalSessions({
    sessions,
    listProjects: async () => [project],
    getPid: async () => { await probe("pid"); return null; },
    getOutput: async () => { await probe("output"); return { output: "", endOffset: 0 }; },
    processStartIdentity: () => null,
    isAlive: () => false,
    attach: () => {},
  });
  assert.equal(count, MAX_PTY_PANES);
  assert.equal(pidCalls, MAX_PTY_PANES);
  assert.equal(outputCalls, MAX_PTY_PANES * 2);
  assert.ok(maxActive <= 4, `host probes in flight: ${maxActive}`);
  const socket = { destroyed: false, writableLength: 0, write() { return true; }, destroy() { this.destroyed = true; } };
  const messages = [];
  await sessions.handle(socket, { type: "pty:list", protocol: 2, id: "bounded-list" }, (_socket, message) => messages.push(message));
  assert.equal(messages[0].terminals.length, MAX_PTY_PANES);
});

test("Aya main restores remote sessions before accepting remote connections on every startup", () => {
  const source = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
  assert.match(source, /remotePtySessions\.setReady\(restoreRemoteTerminalSessions\(\{/);
  assert.match(source, /getPid: \(terminalId\) => ptyHost\.getPid\(terminalId\)/);
  assert.match(source, /getOutput: \(terminalId\) => ptyHost\.getRemoteOutput\(terminalId\)/);
  assert.match(source, /attach: \(\) => ptyHost\.attachWebContents\(remotePtySessions!\)/);
});

test("one socket controls the host while other sockets can only observe until it disconnects", async () => {
  const project = { slug: "repo", name: "Repo", directory: "/repo", tabs: [] };
  const preset = { id: "shell", name: "Shell", icon: "$", color: "", command: "sh" };
  const controlChanges = [];
  let writes = 0;
  let resizes = 0;
  const sessions = new RemotePtySessions({
    listProjects: async () => [project],
    listPresets: async () => [preset],
    spawn: async () => {},
    write: async () => { writes += 1; return true; },
    resize: async () => { resizes += 1; },
    exit: async () => {},
    onController: (id, controlled) => controlChanges.push({ id, controlled }),
  });
  const makeSocket = () => ({ destroyed: false, writableLength: 0, write() { return true; }, destroy() { this.destroyed = true; } });
  const first = makeSocket();
  const second = makeSocket();
  const firstWriter = (_socket, message) => {};
  await sessions.handle(first, { type: "pty:spawn", protocol: 2, id: "spawn-a", project: "repo", preset: "shell", cols: 80, rows: 24, terminalId: "terminal-a" }, firstWriter);

  const firstAttach = [];
  await sessions.handle(first, { type: "pty:attach", protocol: 2, id: "attach-first", terminalId: "terminal-a", offset: 0 }, (_socket, message) => firstAttach.push(message));
  assert.equal(firstAttach.find((message) => message.type === "pty:attached").readOnly, undefined);
  await sessions.handle(first, { type: "pty:spawn", protocol: 2, id: "spawn-b", project: "repo", preset: "shell", cols: 80, rows: 24, terminalId: "terminal-b" }, firstWriter);
  const firstAttachB = [];
  await sessions.handle(first, { type: "pty:attach", protocol: 2, id: "attach-first-b", terminalId: "terminal-b", offset: 0 }, (_socket, message) => firstAttachB.push(message));
  assert.equal(firstAttachB.find((message) => message.type === "pty:attached").readOnly, undefined);

  const secondAttach = [];
  await sessions.handle(second, { type: "pty:attach", protocol: 2, id: "attach-second", terminalId: "terminal-a", offset: 0 }, (_socket, message) => secondAttach.push(message));
  assert.equal(secondAttach.find((message) => message.type === "pty:attached").readOnly, true);
  const secondAttachB = [];
  await sessions.handle(second, { type: "pty:attach", protocol: 2, id: "attach-second-b", terminalId: "terminal-b", offset: 0 }, (_socket, message) => secondAttachB.push(message));
  assert.equal(secondAttachB.find((message) => message.type === "pty:attached").readOnly, true);

  const deniedSpawn = [];
  await sessions.handle(second, { type: "pty:spawn", protocol: 2, id: "spawn-denied", project: "repo", preset: "shell", cols: 80, rows: 24, terminalId: "terminal-c" }, (_socket, message) => deniedSpawn.push(message));
  assert.match(deniedSpawn.find((message) => message.type === "error")?.message ?? "", /another Aya controls this host/i);

  const deniedWrite = [];
  await sessions.handle(second, { type: "pty:write", protocol: 2, id: "write-second", terminalId: "terminal-b", data: "must not arrive" }, (_socket, message) => deniedWrite.push(message));
  assert.match(deniedWrite.find((message) => message.type === "error")?.message ?? "", /another Aya controls this host/i);
  const deniedResize = [];
  await sessions.handle(second, { type: "pty:resize", protocol: 2, id: "resize-second", terminalId: "terminal-b", cols: 100, rows: 30 }, (_socket, message) => deniedResize.push(message));
  assert.match(deniedResize.find((message) => message.type === "error")?.message ?? "", /another Aya controls this host/i);
  assert.equal(writes, 0);
  assert.equal(resizes, 0);

  sessions.detach(first);
  const promotedAttach = [];
  await sessions.handle(second, { type: "pty:attach", protocol: 2, id: "attach-promoted", terminalId: "terminal-b", offset: 0 }, (_socket, message) => promotedAttach.push(message));
  assert.equal(promotedAttach.find((message) => message.type === "pty:attached").readOnly, undefined);
  await sessions.handle(second, { type: "pty:write", protocol: 2, id: "write-promoted", terminalId: "terminal-b", data: "allowed" }, () => {});
  await sessions.handle(second, { type: "pty:resize", protocol: 2, id: "resize-promoted", terminalId: "terminal-b", cols: 100, rows: 30 }, () => {});
  const promotedSpawn = [];
  await sessions.handle(second, { type: "pty:spawn", protocol: 2, id: "spawn-promoted", project: "repo", preset: "shell", cols: 80, rows: 24, terminalId: "terminal-c" }, (_socket, message) => promotedSpawn.push(message));
  assert.equal(promotedSpawn.some((message) => message.type === "pty:spawned" && message.terminalId === "terminal-c"), true);
  assert.equal(writes, 1);
  assert.equal(resizes, 1);
  assert.deepEqual(controlChanges, [
    { id: "terminal-a", controlled: true },
    { id: "terminal-b", controlled: true },
    { id: "terminal-a", controlled: false },
    { id: "terminal-b", controlled: false },
    { id: "terminal-b", controlled: true },
  ]);
});

test("separate bridges from one Aya process share the same host control identity", async () => {
  const project = { slug: "repo", name: "Repo", directory: "/repo", tabs: [] };
  const preset = { id: "shell", name: "Shell", icon: "$", color: "", command: "sh" };
  const sessions = new RemotePtySessions({
    listProjects: async () => [project],
    listPresets: async () => [preset],
    spawn: async () => {}, write: async () => true, resize: async () => {}, exit: async () => {},
  });
  const makeSocket = () => ({ destroyed: false, writableLength: 0, write() { return true; }, destroy() { this.destroyed = true; } });
  const firstBridge = makeSocket();
  const secondBridge = makeSocket();
  const otherAya = makeSocket();
  sessions.registerClient(firstBridge, "same-aya");
  sessions.registerClient(secondBridge, "same-aya");
  sessions.registerClient(otherAya, "other-aya");

  const send = (socket, message, replies = []) => sessions.handle(socket, message, (_socket, reply) => replies.push(reply));
  await send(firstBridge, { type: "pty:spawn", protocol: 2, id: "spawn-a", project: "repo", preset: "shell", cols: 80, rows: 24, terminalId: "terminal-a" });
  await send(secondBridge, { type: "pty:spawn", protocol: 2, id: "spawn-b", project: "repo", preset: "shell", cols: 80, rows: 24, terminalId: "terminal-b" });
  const refused = [];
  await send(otherAya, { type: "pty:spawn", protocol: 2, id: "spawn-other", project: "repo", preset: "shell", cols: 80, rows: 24, terminalId: "terminal-c" }, refused);
  assert.match(refused.find((message) => message.type === "error")?.message ?? "", /another Aya controls this host/i);

  sessions.detach(firstBridge);
  const allowed = [];
  await send(secondBridge, { type: "pty:write", protocol: 2, id: "write-b", terminalId: "terminal-b", data: "still controlled" }, allowed);
  assert.equal(allowed.some((message) => message.type === "pty:written"), true);
  sessions.detach(secondBridge);
  const acquired = [];
  await send(otherAya, { type: "pty:attach", protocol: 2, id: "attach-c", terminalId: "terminal-a", offset: 0 }, acquired);
  assert.equal(acquired.find((message) => message.type === "pty:attached")?.readOnly, undefined);
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

test("replay storage bounds chunk metadata and copies only the retained suffix", async () => {
  const project = { slug: "repo", name: "Repo", directory: "/repo", tabs: [] };
  const preset = { id: "shell", name: "Shell", icon: "$", color: "", command: "sh" };
  const sessions = new RemotePtySessions({
    listProjects: async () => [project],
    listPresets: async () => [preset],
    spawn: async () => {},
    write: async () => true,
    resize: async () => {},
    exit: async () => {},
    newId: () => "terminal-tiny-output",
  });
  const socket = { destroyed: false, writableLength: 0, write() { return true; }, destroy() { this.destroyed = true; } };
  await sessions.handle(socket, { type: "pty:spawn", protocol: 2, id: "spawn", project: "repo", preset: "shell", cols: 80, rows: 24 }, () => {});
  const session = sessions.sessions.get("terminal-tiny-output");
  const maxBytes = REMOTE_TERMINAL_REPLAY_MAX_BYTES;
  for (let index = 0; index < Math.ceil(maxBytes / 16) + 10; index += 1) {
    sessions.onPtyEvent({ type: "data", ptyId: session.terminalId, chunk: "abcdefghijklmnop" });
  }
  assert.equal(session.retainedBytes, maxBytes);
  assert.equal(session.chunks.length <= 17, true);
  assert.equal(session.chunks.every((chunk) => chunk.bytes.byteLength === 64 * 1024), true);
  assert.equal(session.chunks.reduce((sum, chunk) => sum + chunk.end - chunk.start, 0), maxBytes);

  const oversized = "z".repeat(maxBytes * 4);
  sessions.onPtyEvent({ type: "data", ptyId: session.terminalId, chunk: oversized });
  assert.equal(session.retainedBytes, maxBytes);
  assert.equal(session.chunks.length <= 17, true);
  assert.equal(session.chunks.every((chunk) => chunk.bytes.byteLength === 64 * 1024), true);
  assert.equal(session.totalBytes, (Math.ceil(maxBytes / 16) + 10) * 16 + oversized.length);
});

test("an exit timeout reconciles an already-removed host PTY before reporting state", async () => {
  const project = { slug: "repo", name: "Repo", directory: "/repo", tabs: [] };
  const preset = { id: "shell", name: "Shell", icon: "$", color: "", command: "sh" };
  let running = true;
  const sessions = new RemotePtySessions({
    listProjects: async () => [project],
    listPresets: async () => [preset],
    spawn: async () => ({ pid: 301, startIdentity: "301:started" }),
    write: async () => true,
    resize: async () => {},
    exit: async () => { running = false; throw new Error("host exit wait timed out"); },
    isRunning: async (identity) => {
      assert.deepEqual(identity, { pid: 301, startIdentity: "301:started" });
      return running;
    },
    newId: () => "terminal-exit-timeout",
  });
  const socket = { destroyed: false, writableLength: 0, write() { return true; }, destroy() { this.destroyed = true; } };
  await sessions.handle(socket, { type: "pty:spawn", protocol: 2, id: "spawn", project: "repo", preset: "shell", cols: 80, rows: 24 }, () => {});
  const result = [];
  await sessions.handle(socket, { type: "pty:exit", protocol: 2, id: "exit", terminalId: "terminal-exit-timeout" }, (_socket, message) => result.push(message));
  assert.equal(result.some((message) => message.type === "pty:exit-result"), true);
  const listed = [];
  await sessions.handle(socket, { type: "pty:list", protocol: 2, id: "list" }, (_socket, message) => listed.push(message));
  assert.equal(listed[0].terminals[0].state, "exited");
  const writeReply = [];
  await sessions.handle(socket, { type: "pty:write", protocol: 2, id: "write", terminalId: "terminal-exit-timeout", data: "x" }, (_socket, message) => writeReply.push(message));
  assert.match(writeReply[0].message, /no longer running/i);
});

test("a real exit event wins when it arrives before an explicit exit request rejects", async () => {
  const project = { slug: "repo", name: "Repo", directory: "/repo", tabs: [] };
  const preset = { id: "shell", name: "Shell", icon: "$", color: "", command: "sh" };
  let beginExit;
  let rejectExit;
  const exitStarted = new Promise((resolve) => { beginExit = resolve; });
  const pendingExit = new Promise((_resolve, reject) => { rejectExit = reject; });
  const sessions = new RemotePtySessions({
    listProjects: async () => [project],
    listPresets: async () => [preset],
    spawn: async () => ({ pid: 304, startIdentity: "304:started" }),
    write: async () => true,
    resize: async () => {},
    exit: async () => { beginExit(); return pendingExit; },
    isRunning: async () => false,
    newId: () => "terminal-exit-race",
  });
  const socket = {
    destroyed: false,
    writableLength: 0,
    frames: [],
    write(frame) { this.frames.push(JSON.parse(frame)); return true; },
    destroy() { this.destroyed = true; },
  };
  await sessions.handle(socket, { type: "pty:spawn", protocol: 2, id: "spawn", project: "repo", preset: "shell", cols: 80, rows: 24 }, () => {});
  await sessions.handle(socket, { type: "pty:attach", protocol: 2, id: "attach", terminalId: "terminal-exit-race", offset: 0 }, () => {});

  const response = [];
  const exitRequest = sessions.handle(socket, { type: "pty:exit", protocol: 2, id: "exit", terminalId: "terminal-exit-race" }, (_socket, message) => response.push(message));
  await exitStarted;
  sessions.onPtyEvent({ type: "exit", ptyId: "terminal-exit-race", exitCode: 23 });
  rejectExit(new Error("host exit wait timed out after the child exited"));
  await exitRequest;

  const exitEvents = socket.frames.filter((message) => message.type === "pty:exited");
  assert.equal(exitEvents.length, 1);
  assert.equal(exitEvents[0].exitCode, 23);
  assert.equal(exitEvents[0].killed, undefined);
  assert.equal(response.some((message) => message.type === "pty:exit-result"), true);
  const listed = [];
  await sessions.handle(socket, { type: "pty:list", protocol: 2, id: "list", }, (_socket, message) => listed.push(message));
  assert.equal(listed[0].terminals[0].state, "exited");
});

test("a real exit event during the liveness probe is not replaced by a killed event", async () => {
  const project = { slug: "repo", name: "Repo", directory: "/repo", tabs: [] };
  const preset = { id: "shell", name: "Shell", icon: "$", color: "", command: "sh" };
  let rejectExit;
  let resolveLiveness;
  let beginLiveness;
  const livenessStarted = new Promise((resolve) => { beginLiveness = resolve; });
  const pendingExit = new Promise((_resolve, reject) => { rejectExit = reject; });
  const pendingLiveness = new Promise((resolve) => { resolveLiveness = resolve; });
  const sessions = new RemotePtySessions({
    listProjects: async () => [project],
    listPresets: async () => [preset],
    spawn: async () => ({ pid: 305, startIdentity: "305:started" }),
    write: async () => true,
    resize: async () => {},
    exit: async () => pendingExit,
    isRunning: async () => { beginLiveness(); return pendingLiveness; },
    newId: () => "terminal-exit-probe-race",
  });
  const socket = {
    destroyed: false,
    writableLength: 0,
    frames: [],
    write(frame) { this.frames.push(JSON.parse(frame)); return true; },
    destroy() { this.destroyed = true; },
  };
  await sessions.handle(socket, { type: "pty:spawn", protocol: 2, id: "spawn", project: "repo", preset: "shell", cols: 80, rows: 24 }, () => {});
  await sessions.handle(socket, { type: "pty:attach", protocol: 2, id: "attach", terminalId: "terminal-exit-probe-race", offset: 0 }, () => {});

  const response = [];
  const exitRequest = sessions.handle(socket, { type: "pty:exit", protocol: 2, id: "exit", terminalId: "terminal-exit-probe-race" }, (_socket, message) => response.push(message));
  rejectExit(new Error("host exit wait timed out"));
  await livenessStarted;
  sessions.onPtyEvent({ type: "exit", ptyId: "terminal-exit-probe-race", exitCode: 23 });
  resolveLiveness(false);
  await exitRequest;

  const exitEvents = socket.frames.filter((message) => message.type === "pty:exited");
  assert.equal(exitEvents.length, 1);
  assert.equal(exitEvents[0].exitCode, 23);
  assert.equal(exitEvents[0].killed, undefined);
  assert.equal(response.some((message) => message.type === "pty:exit-result"), true);
  const listed = [];
  await sessions.handle(socket, { type: "pty:list", protocol: 2, id: "list" }, (_socket, message) => listed.push(message));
  assert.equal(listed[0].terminals[0].state, "exited");
});

test("an exit timeout with a signalable PTY is reported as uncertain and no longer writable", async () => {
  const project = { slug: "repo", name: "Repo", directory: "/repo", tabs: [] };
  const preset = { id: "shell", name: "Shell", icon: "$", color: "", command: "sh" };
  const sessions = new RemotePtySessions({
    listProjects: async () => [project],
    listPresets: async () => [preset],
    spawn: async () => {},
    write: async () => true,
    resize: async () => {},
    exit: async () => { throw new Error("host exit wait timed out"); },
    isRunning: async () => true,
    newId: () => "terminal-exit-uncertain",
  });
  const socket = { destroyed: false, writableLength: 0, write() { return true; }, destroy() { this.destroyed = true; } };
  await sessions.handle(socket, { type: "pty:spawn", protocol: 2, id: "spawn", project: "repo", preset: "shell", cols: 80, rows: 24 }, () => {});
  const result = [];
  await sessions.handle(socket, { type: "pty:exit", protocol: 2, id: "exit", terminalId: "terminal-exit-uncertain" }, (_socket, message) => result.push(message));
  assert.match(result.find((message) => message.type === "error")?.message ?? "", /could not confirm.*stopped.*may still be running/i);
  const listed = [];
  await sessions.handle(socket, { type: "pty:list", protocol: 2, id: "list" }, (_socket, message) => listed.push(message));
  assert.equal(listed[0].terminals[0].state, "uncertain");
  assert.match(listed[0].terminals[0].failureReason, /may still be running/i);
  const writeReply = [];
  await sessions.handle(socket, { type: "pty:write", protocol: 2, id: "write", terminalId: "terminal-exit-uncertain", data: "x" }, (_socket, message) => writeReply.push(message));
  assert.match(writeReply[0].message, /no longer running/i);
});

test("a missing PTY-host map entry is unknown, and an uncertain live session is never evicted", async () => {
  const project = { slug: "repo", name: "Repo", directory: "/repo", tabs: [] };
  const preset = { id: "shell", name: "Shell", icon: "$", color: "", command: "sh" };
  let nextId = 0;
  let spawnCount = 0;
  const sessions = new RemotePtySessions({
    listProjects: async () => [project],
    listPresets: async () => [preset],
    spawn: async () => {
      spawnCount += 1;
      return spawnCount === 1 ? { pid: 302, startIdentity: "302:started" } : undefined;
    },
    write: async () => true,
    resize: async () => {},
    exit: async () => { throw new Error("host exit wait timed out after dropping the PTY map entry"); },
    // getPtyPid() returns null after pty-core removes the child from its map;
    // that does not prove the OS child has closed or been reaped.
    isRunning: async (identity) => {
      assert.deepEqual(identity, { pid: 302, startIdentity: "302:started" });
      return null;
    },
    newId: () => `terminal-${++nextId}`,
  });
  const socket = { destroyed: false, writableLength: 0, write() { return true; }, destroy() { this.destroyed = true; } };
  await sessions.handle(socket, { type: "pty:spawn", protocol: 2, id: "spawn-uncertain", project: "repo", preset: "shell", cols: 80, rows: 24 }, () => {});
  const exitReply = [];
  await sessions.handle(socket, { type: "pty:exit", protocol: 2, id: "exit-uncertain", terminalId: "terminal-1" }, (_socket, message) => exitReply.push(message));
  assert.equal(exitReply.some((message) => message.type === "pty:exit-result"), false);

  for (let index = 0; index < MAX_PTY_PANES - 1; index += 1) {
    await sessions.handle(socket, { type: "pty:spawn", protocol: 2, id: `spawn-${index}`, project: "repo", preset: "shell", cols: 80, rows: 24 }, () => {});
  }
  const refused = [];
  await sessions.handle(socket, { type: "pty:spawn", protocol: 2, id: "spawn-over-cap", project: "repo", preset: "shell", cols: 80, rows: 24 }, (_socket, message) => refused.push(message));
  assert.match(refused.find((message) => message.type === "error")?.message ?? "", /maximum number of remote terminals/i);
  const listed = [];
  await sessions.handle(socket, { type: "pty:list", protocol: 2, id: "list" }, (_socket, message) => listed.push(message));
  assert.equal(listed[0].terminals.length, MAX_PTY_PANES);
  assert.equal(listed[0].terminals[0].terminalId, "terminal-1");
  assert.equal(listed[0].terminals[0].state, "uncertain");
});

test("a successful retry keeps an uncertain PTY until its captured process is confirmed gone", async () => {
  const project = { slug: "repo", name: "Repo", directory: "/repo", tabs: [] };
  const preset = { id: "shell", name: "Shell", icon: "$", color: "", command: "sh" };
  let exitAttempts = 0;
  let running = true;
  const identity = { pid: 303, startIdentity: "303:started" };
  const sessions = new RemotePtySessions({
    listProjects: async () => [project],
    listPresets: async () => [preset],
    spawn: async () => identity,
    write: async () => true,
    resize: async () => {},
    exit: async () => {
      exitAttempts += 1;
      if (exitAttempts === 1) throw new Error("PTY removed from host map before child close");
    },
    isRunning: async (seen) => {
      assert.deepEqual(seen, identity);
      return running;
    },
    newId: () => "terminal-retry-exit",
  });
  const socket = { destroyed: false, writableLength: 0, write() { return true; }, destroy() { this.destroyed = true; } };
  await sessions.handle(socket, { type: "pty:spawn", protocol: 2, id: "spawn", project: "repo", preset: "shell", cols: 80, rows: 24 }, () => {});

  const first = [];
  await sessions.handle(socket, { type: "pty:exit", protocol: 2, id: "exit-1", terminalId: "terminal-retry-exit" }, (_socket, message) => first.push(message));
  assert.equal(first.some((message) => message.type === "error"), true);

  const second = [];
  await sessions.handle(socket, { type: "pty:exit", protocol: 2, id: "exit-2", terminalId: "terminal-retry-exit" }, (_socket, message) => second.push(message));
  assert.equal(second.some((message) => message.type === "pty:exit-result"), false);
  assert.match(second.find((message) => message.type === "error")?.message ?? "", /could not confirm.*stopped/i);
  const stillUncertain = [];
  await sessions.handle(socket, { type: "pty:list", protocol: 2, id: "list-uncertain" }, (_socket, message) => stillUncertain.push(message));
  assert.equal(stillUncertain[0].terminals[0].state, "uncertain");

  running = false;
  const third = [];
  await sessions.handle(socket, { type: "pty:exit", protocol: 2, id: "exit-3", terminalId: "terminal-retry-exit" }, (_socket, message) => third.push(message));
  assert.equal(third.some((message) => message.type === "pty:exit-result"), true);
  const confirmedGone = [];
  await sessions.handle(socket, { type: "pty:list", protocol: 2, id: "list-gone" }, (_socket, message) => confirmedGone.push(message));
  assert.equal(confirmedGone[0].terminals[0].state, "exited");
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

test("a terminal frame write racing a disconnected peer is contained", () => {
  const socket = {
    destroyed: false,
    writableLength: 0,
    destroyCalls: 0,
    write() { throw Object.assign(new Error("broken pipe"), { code: "EPIPE" }); },
    destroy() { this.destroyed = true; this.destroyCalls += 1; },
  };

  assert.equal(writeRemoteTerminalFrame(socket, { type: "pty:output", protocol: 2, terminalId: "t", offset: 0, data: "x" }), false);
  assert.equal(socket.destroyed, true);
  assert.equal(socket.destroyCalls, 1);
});
