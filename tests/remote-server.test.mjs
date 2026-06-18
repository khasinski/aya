import { test } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { startRemoteServerOn } = await import("../dist-electron/remote-server.js");

function mkSocketPath() {
  const dir = mkdtempSync(join(tmpdir(), "aya-remote-"));
  return { dir, socket: join(dir, "aya-remote.sock") };
}

function readMessages(socketPath, afterConnect, expectedCount = 2) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    let buffer = "";
    const messages = [];
    client.setEncoding("utf8");
    client.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const idx = buffer.indexOf("\n");
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        messages.push(JSON.parse(line));
        if (messages.length >= expectedCount) {
          client.destroy();
          resolve(messages);
        }
      }
    });
    client.on("error", reject);
    client.on("connect", () => afterConnect?.(client));
  });
}

test("remote server sends hello and read-only snapshot on connect", async () => {
  const { dir, socket } = mkSocketPath();
  const stop = startRemoteServerOn(socket, {
    appVersion: "0.6.0-test",
    host: {
      id: "host-1",
      name: "Host 1",
      platform: "linux",
      user: "hasik",
    },
    getSnapshot: async () => ({
      projects: [
        {
          slug: "aya",
          name: "Aya",
          directory: "/repo/aya",
          tabs: [{ id: "term-1", presetId: "shell", name: "Shell" }],
        },
      ],
      projectState: {
        version: 1,
        order: ["aya"],
        open: ["aya"],
        recent: ["aya"],
      },
      presets: [
        {
          id: "shell",
          name: "Shell",
          icon: "$",
          color: "",
          command: "$SHELL",
        },
      ],
    }),
    createProject: async (name, directory) => ({
      slug: name.toLowerCase(),
      name,
      directory,
      tabs: [],
    }),
  });
  try {
    const messages = await readMessages(socket);
    assert.equal(statSync(socket).mode & 0o777, 0o600);
    assert.deepEqual(messages[0], {
      type: "hello",
      protocol: 1,
      host: {
        id: "host-1",
        name: "Host 1",
        platform: "linux",
        user: "hasik",
      },
      app: { version: "0.6.0-test" },
      permissions: { mode: "read-only" },
    });
    assert.equal(messages[1].type, "snapshot");
    assert.equal(messages[1].protocol, 1);
    assert.equal(messages[1].snapshot.projects[0].slug, "aya");
    assert.equal(messages[1].snapshot.presets[0].id, "shell");
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("remote server reports read-only for control commands", async () => {
  const { dir, socket } = mkSocketPath();
  const stop = startRemoteServerOn(socket, {
    appVersion: "0.6.0-test",
    host: {
      id: "host-1",
      name: "Host 1",
      platform: "linux",
      user: "hasik",
    },
    getSnapshot: async () => ({
      projects: [],
      projectState: { version: 1, order: [], open: [], recent: [] },
      presets: [],
    }),
    createProject: async (name, directory) => ({
      slug: name.toLowerCase(),
      name,
      directory,
      tabs: [],
    }),
  });
  try {
    const messages = await readMessages(
      socket,
      (client) => {
        client.write(`${JSON.stringify({ type: "pty:write" })}\n`);
      },
      3,
    );
    assert.equal(messages[0].type, "hello");
    assert.equal(messages[1].type, "snapshot");
    assert.equal(messages[2].type, "error");
    assert.equal(messages[2].code, "read_only");
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("remote server lists directories for fs:list", async () => {
  const { dir, socket } = mkSocketPath();
  const root = mkdtempSync(join(tmpdir(), "aya-remote-fs-"));
  mkdtempSync(join(root, "project-"));
  mkdtempSync(join(root, ".hidden-"));
  const stop = startRemoteServerOn(socket, {
    appVersion: "0.6.0-test",
    host: {
      id: "host-1",
      name: "Host 1",
      platform: "linux",
      user: "hasik",
    },
    getSnapshot: async () => ({
      projects: [],
      projectState: { version: 1, order: [], open: [], recent: [] },
      presets: [],
    }),
    createProject: async (name, directory) => ({
      slug: name.toLowerCase(),
      name,
      directory,
      tabs: [],
    }),
  });
  try {
    const messages = await readMessages(
      socket,
      (client) => {
        client.write(
          `${JSON.stringify({ id: "req-1", type: "fs:list", path: root })}\n`,
        );
      },
      3,
    );
    assert.equal(messages[2].type, "fs:list-result");
    assert.equal(messages[2].id, "req-1");
    assert.equal(messages[2].path, root);
    assert.equal(messages[2].entries.length, 1);
    assert.equal(messages[2].entries[0].kind, "directory");
    assert.match(messages[2].entries[0].name, /^project-/);
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("remote server creates a local project for project:create", async () => {
  const { dir, socket } = mkSocketPath();
  const root = mkdtempSync(join(tmpdir(), "aya-remote-project-"));
  let created = null;
  const stop = startRemoteServerOn(socket, {
    appVersion: "0.6.0-test",
    host: {
      id: "host-1",
      name: "Host 1",
      platform: "linux",
      user: "hasik",
    },
    getSnapshot: async () => ({
      projects: [],
      projectState: { version: 1, order: [], open: [], recent: [] },
      presets: [],
    }),
    createProject: async (name, directory) => {
      created = { name, directory };
      return {
        slug: "remote-project",
        name,
        directory,
        tabs: [],
      };
    },
  });
  try {
    const messages = await readMessages(
      socket,
      (client) => {
        client.write(
          `${JSON.stringify({
            id: "req-2",
            type: "project:create",
            name: "Remote Project",
            directory: root,
          })}\n`,
        );
      },
      3,
    );
    assert.deepEqual(created, { name: "Remote Project", directory: root });
    assert.equal(messages[2].type, "project:create-result");
    assert.equal(messages[2].id, "req-2");
    assert.equal(messages[2].project.slug, "remote-project");
    assert.equal(messages[2].project.directory, root);
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
