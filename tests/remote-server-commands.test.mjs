// The remote server's answers to what a client can get wrong, and the commands
// remote-server.test.mjs does not drive: fs:mkdir, "~" paths, a project without a
// name, a failing snapshot, and the socket file a stopped server leaves (none).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";

// startRemoteServer listens at REMOTE_SOCKET_PATH, which paths.js reads from AYA_HOME at load.
const AYA_HOME = mkdtempSync(join(tmpdir(), "aya-remote-home-"));
process.env.AYA_HOME = AYA_HOME;
const require = createRequire(import.meta.url);
const MODULE = join(process.cwd(), "dist-electron", "remote-server.js");
const { startRemoteServer, startRemoteServerOn } = await import(MODULE);
const { REMOTE_MAX_FRAME_BYTES } = await import("../dist-electron/remote-protocol.js");
const { RemoteRequestFrameBuffer } = await import("../dist-electron/remote-server.js");
const { RemotePtySessions } = await import("../dist-electron/remote-pty-sessions.js");
test.after(() => rmSync(AYA_HOME, { recursive: true, force: true }));

const EMPTY_SNAPSHOT = {
  projects: [],
  projectState: { version: 1, order: [], open: [], recent: [] },
  presets: [],
};

function start(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "aya-remote-cmd-"));
  const socket = join(dir, "aya-remote.sock");
  const stop = startRemoteServerOn(socket, {
    appVersion: "0.6.0-test",
    getSnapshot: async () => EMPTY_SNAPSHOT,
    createProject: async (name, directory) => ({ slug: "p", name, directory, tabs: [] }),
    ...overrides,
  });
  t.after(() => {
    stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, socket, stop };
}

/** Connects, writes `lines` once the hello is in, and collects messages until
 *  `done(messages)` is true or the server closes the connection. After `ms` it
 *  gives up and closes the connection itself, marking the result `timedOut`. */
function talk(socketPath, lines, done, ms = 5000) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    const messages = [];
    let buffer = "";
    let sent = false;
    const timer = setTimeout(() => {
      messages.timedOut = true;
      finish();
    }, ms);
    const finish = () => {
      clearTimeout(timer);
      client.destroy();
      resolve(messages);
    };
    client.setEncoding("utf8");
    client.on("data", (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        messages.push(JSON.parse(line));
        if (!sent && messages[0].type === "hello") {
          sent = true;
          for (const l of lines) client.write(`${l}\n`);
        }
        if (done(messages)) return finish();
      }
    });
    client.on("end", finish);
    client.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

const replies = (messages) => messages.filter((m) => m.type !== "hello" && m.type !== "snapshot");
const nReplies = (n) => (messages) => replies(messages).length >= n;

test("a line that is not JSON gets bad_json, and the connection keeps answering", async (t) => {
  const { socket } = start(t);
  const messages = await talk(socket, ["{not json", JSON.stringify({ id: "r1", type: "fs:mkdir" })], nReplies(2));
  const [bad, next] = replies(messages);
  assert.equal(bad.type, "error");
  assert.equal(bad.code, "bad_json");
  assert.equal(next.id, "r1", "the line after the bad one was still read");
});

test("a command that is not an object gets bad_request", async (t) => {
  const { socket } = start(t);
  const messages = await talk(socket, ["[1,2]", '"fs:list"', "null"], nReplies(3));
  for (const reply of replies(messages)) {
    assert.deepEqual([reply.type, reply.code], ["error", "bad_request"]);
  }
});

test("a changed identity on repeated session open gets an error and the socket keeps serving", async (t) => {
  const terminalSessions = new RemotePtySessions({
    listProjects: async () => [], listPresets: async () => [], spawn: async () => {},
    write: async () => true, resize: async () => {}, exit: async () => {},
  });
  const { socket } = start(t, { terminalSessions });
  const messages = await talk(socket, [
    JSON.stringify({ type: "session:open", protocol: 2, id: "open-1", clientId: "client-a" }),
    JSON.stringify({ type: "session:open", protocol: 2, id: "open-2", clientId: "client-b" }),
    JSON.stringify({ type: "pty:list", protocol: 2, id: "list-1" }),
  ], (items) => items.some((item) => item.id === "open-2") && items.some((item) => item.id === "list-1"));
  assert.equal(messages.find((item) => item.id === "open-1")?.type, "session:ready");
  const rejected = messages.find((item) => item.id === "open-2");
  assert.ok(rejected, JSON.stringify(messages));
  assert.equal(rejected?.type, "error");
  assert.equal(rejected?.code, "command_failed");
  assert.match(rejected?.message, /different client identity/);
  assert.equal(messages.find((item) => item.id === "list-1")?.type, "pty:list-result");
});

test("request buffering stays capped and latches closed after an oversized frame", () => {
  const requestBuffer = new RemoteRequestFrameBuffer();
  const withinLimit = requestBuffer.push("x".repeat(REMOTE_MAX_FRAME_BYTES));
  assert.equal(withinLimit.tooLarge, false);
  assert.equal(requestBuffer.bufferedBytes, REMOTE_MAX_FRAME_BYTES);
  const overLimit = requestBuffer.push("y");
  assert.equal(overLimit.tooLarge, true);
  assert.equal(requestBuffer.bufferedBytes, 0);
  for (let index = 0; index < 32; index += 1) {
    assert.equal(requestBuffer.push("z".repeat(64 * 1024)).tooLarge, true);
    assert.equal(requestBuffer.bufferedBytes, 0);
  }
});

test("the server processes a valid frame then drops an oversized suffix and continued input", async (t) => {
  const { dir, socket } = start(t);
  const client = net.createConnection(socket);
  const messages = [];
  let buffer = "";
  client.setEncoding("utf8");
  const closed = new Promise((resolve) => client.on("close", resolve));
  // The queued post-limit writes may receive the expected reset/EPIPE as the
  // server destroys the stream.
  client.on("error", () => {});
  client.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line) messages.push(JSON.parse(line));
    }
  });
  await new Promise((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  const madePath = join(dir, "made-before-oversized-suffix");
  client.write(`${JSON.stringify({ type: "fs:mkdir", id: "valid", path: madePath })}\n${"x".repeat(REMOTE_MAX_FRAME_BYTES + 1)}`);
  // Queue more hostile input before the peer can observe the close. The
  // server must destroy the socket on the first over-limit frame, not append
  // these chunks to its retained request buffer.
  for (let index = 0; index < 32; index += 1) client.write("y".repeat(64 * 1024));
  await closed;
  assert.equal(existsSync(madePath), true, "the valid frame before the suffix was handled");
  assert.equal(client.destroyed, true);
  assert.equal(client.writable, false);
});

test("fs:mkdir makes the whole path and answers with it; without a path it fails with the reason", async (t) => {
  const { dir, socket } = start(t);
  const target = join(dir, "a", "b", "c");
  const messages = await talk(
    socket,
    [JSON.stringify({ id: "m1", type: "fs:mkdir", path: target }), JSON.stringify({ id: "m2", type: "fs:mkdir", path: "  " })],
    nReplies(2),
  );
  const made = replies(messages).find((m) => m.id === "m1");
  assert.deepEqual([made.type, made.path], ["fs:mkdir-result", target]);
  assert.equal(statSync(target).isDirectory(), true);
  const missing = replies(messages).find((m) => m.id === "m2");
  assert.deepEqual([missing.type, missing.code, missing.message], ["error", "command_failed", "fs:mkdir.path is required"]);
});

test("\"~\" and \"~/...\" paths are the user's home, for fs:mkdir, fs:list and project:create", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "aya-remote-home-"));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });
  let created = null;
  const { socket } = start(t, {
    createProject: async (name, directory) => ((created = { name, directory }), { slug: "p", name, directory, tabs: [] }),
  });
  // Each line is handled as it arrives, not after the one before it finishes: the
  // directory must exist before it is listed, so fs:mkdir goes first, on its own.
  const made = await talk(socket, [JSON.stringify({ id: "mk", type: "fs:mkdir", path: "~/work/new" })], nReplies(1));
  const messages = await talk(
    socket,
    [
      JSON.stringify({ id: "ls", type: "fs:list", path: "~" }),
      JSON.stringify({ id: "pc", type: "project:create", directory: "~/work/new" }),
    ],
    nReplies(2),
  );
  const byId = Object.fromEntries([...replies(made), ...replies(messages)].map((m) => [m.id, m]));
  assert.equal(byId.mk.path, join(home, "work", "new"));
  assert.equal(statSync(join(home, "work", "new")).isDirectory(), true);
  assert.equal(byId.ls.path, home);
  assert.deepEqual(byId.ls.entries.map((e) => [e.name, e.path]), [["work", join(home, "work")]]);
  // No name: the directory's last part.
  assert.deepEqual(created, { name: "new", directory: join(home, "work", "new") });
  assert.equal(byId.pc.project.name, "new");
});

test("fs:list lists only directories, without hidden ones, sorted by name", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aya-remote-ls-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ["zeta", "Alpha", "mid", ".git"]) mkdirSync(join(root, name));
  writeFileSync(join(root, "file.txt"), "");
  const { socket } = start(t);
  const messages = await talk(socket, [JSON.stringify({ id: "ls", type: "fs:list", path: root })], nReplies(1));
  const names = replies(messages)[0].entries.map((e) => e.name);
  assert.deepEqual(names, ["Alpha", "mid", "zeta"]);
});

test("project:create without a directory, or with a createProject that throws, fails with the reason", async (t) => {
  const { socket } = start(t, {
    createProject: async () => {
      throw new Error("not a git repo");
    },
  });
  const messages = await talk(
    socket,
    [
      JSON.stringify({ id: "p1", type: "project:create", name: "x" }),
      JSON.stringify({ id: "p2", type: "project:create", directory: "/tmp/somewhere" }),
    ],
    nReplies(2),
  );
  const byId = Object.fromEntries(replies(messages).map((m) => [m.id, m]));
  assert.deepEqual([byId.p1.code, byId.p1.message], ["command_failed", "project:create.directory is required"]);
  assert.deepEqual([byId.p2.code, byId.p2.message], ["command_failed", "not a git repo"]);
});

test("a snapshot that fails is reported and the server closes the connection", async (t) => {
  const { socket } = start(t, {
    getSnapshot: async () => {
      throw new Error("projects.json unreadable");
    },
  });
  const messages = await talk(socket, [], () => false);
  assert.equal(messages.timedOut, undefined, "the server kept the connection open");
  assert.equal(messages[0].type, "hello");
  assert.deepEqual(
    messages.slice(1).map((m) => [m.type, m.code, m.message]),
    [["error", "snapshot_failed", "projects.json unreadable"]],
  );
});

test("the stream holds nothing a terminal would act on, and parses to the same data", async (t) => {
  // aya remote --stdio prints this stream; a project name from a team or agent may hold C1 CSI or a bidi override.
  const name = "game\u009b31m\u202eTXT\x1b]0;owned\x07";
  const { socket } = start(t, { getSnapshot: async () => ({ ...EMPTY_SNAPSHOT, projects: [{ slug: "game", name, directory: "/g", tabs: [] }] }) });
  const raw = await new Promise((resolve, reject) => {
    const client = net.createConnection(socket);
    let text = "";
    client.setEncoding("utf8");
    client.on("data", (chunk) => {
      text += chunk;
      if (text.split("\n").length > 2) {
        client.destroy();
        resolve(text);
      }
    });
    client.on("error", reject);
  });
  assert.doesNotMatch(raw, /[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u206f]/);
  const snapshot = raw.split("\n").map((l) => l && JSON.parse(l)).find((m) => m && m.type === "snapshot");
  assert.equal(snapshot.snapshot.projects[0].name, name);
});

test("without host info the hello names this machine", async (t) => {
  const { socket } = start(t);
  const [hello] = await talk(socket, [], (m) => m.length >= 1);
  assert.deepEqual(hello.host, { id: hostname(), name: hostname(), platform: process.platform, user: userInfo().username });
  assert.deepEqual(hello.app, { version: "0.6.0-test" });
  assert.equal(hello.protocol, 1);
  assert.equal(hello.permissions.mode, "read-only");
});

test("a stale socket file is replaced on start, and stop removes the socket", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aya-remote-stale-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // The parent does not exist yet: the first start makes it.
  const socket = join(dir, "nested", "aya-remote.sock");
  const stopFirst = startRemoteServerOn(socket, { appVersion: "t", getSnapshot: async () => EMPTY_SNAPSHOT, createProject: async () => ({}) });
  stopFirst();
  // A plain file where the socket goes, as a crashed run could leave behind.
  writeFileSync(socket, "stale");
  const stop = startRemoteServerOn(socket, { appVersion: "t", getSnapshot: async () => EMPTY_SNAPSHOT, createProject: async () => ({}) });
  let stopped = false;
  t.after(() => stopped || stop());
  const [hello] = await talk(socket, [], (m) => m.length >= 1);
  assert.equal(hello.type, "hello");
  stop();
  stopped = true;
  assert.equal(existsSync(socket), false);
});

test("stopping the remote server closes accepted bridges before a replacement starts", async (t) => {
  const { socket, stop } = start(t);
  const client = net.createConnection(socket);
  t.after(() => client.destroy());
  await new Promise((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  await new Promise((resolve, reject) => {
    client.once("data", resolve);
    client.once("error", reject);
  });
  const closed = new Promise((resolve) => client.once("close", resolve));
  await stop();
  await closed;
});

test("startRemoteServer listens in AYA_HOME and stops when Aya quits", async (t) => {
  const electronId = createRequire(MODULE).resolve("electron");
  const saved = require.cache[electronId];
  const onQuit = [];
  require.cache[electronId] = {
    id: electronId,
    filename: electronId,
    loaded: true,
    exports: { app: { once: (event, fn) => onQuit.push([event, fn]) } },
  };
  t.after(() => {
    if (saved) require.cache[electronId] = saved;
    else delete require.cache[electronId];
  });
  const stop = startRemoteServer({ appVersion: "t", getSnapshot: async () => EMPTY_SNAPSHOT, createProject: async () => ({}) });
  let quit = false;
  t.after(() => quit || stop());
  const socket = join(AYA_HOME, "aya-remote.sock");
  const [hello] = await talk(socket, [], (m) => m.length >= 1);
  assert.equal(hello.type, "hello");
  assert.deepEqual(onQuit.map(([event]) => event), ["before-quit"]);
  onQuit[0][1]();
  quit = true;
  assert.equal(existsSync(socket), false, "quitting Aya removed the socket");
});
