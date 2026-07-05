import { test } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const {
  createRemoteDirectory,
  createRemoteProjectOnHost,
  listRemoteDirectory,
  listRemotePresets,
  recoverExistingRemoteProject,
} = await import("../dist-electron/remote-client.js");

// --- recoverExistingRemoteProject --------------------------------------------
// An older remote Aya (before open-or-create) rejects re-opening an existing
// project with "Project \"<slug>\" already exists." The failed request still
// carried the host's project snapshot, so we recover the open from it instead
// of updating the remote host. This keeps opening remote projects working
// against remote hosts that haven't been upgraded.

function existsErr(slug, projects, host = { id: "darwine", name: "darwine" }) {
  const err = new Error(`Project "${slug}" already exists.`);
  err.remoteContext = { host, presets: [{ id: "shell" }], projects };
  return err;
}

test("recovers the existing project named by an 'already exists' error", () => {
  const pe = { slug: "pe", name: "pe", directory: "/home/hasik/pe", tabs: [] };
  const result = recoverExistingRemoteProject(
    existsErr("pe", [{ slug: "other", name: "o", directory: "/x", tabs: [] }, pe]),
  );
  assert.ok(result);
  assert.deepEqual(result.project, pe); // resolved absolute dir preserved
  assert.equal(result.host.id, "darwine");
  assert.equal(result.presets.length, 1);
});

test("returns null when the error carried no snapshot context", () => {
  const bare = new Error('Project "pe" already exists.');
  assert.equal(recoverExistingRemoteProject(bare), null);
});

test("returns null for errors that are not 'already exists'", () => {
  const err = new Error("Node is not available on darwine.");
  err.remoteContext = { host: { id: "d" }, presets: [], projects: [] };
  assert.equal(recoverExistingRemoteProject(err), null);
});

test("returns null when the named slug is absent from the snapshot", () => {
  assert.equal(
    recoverExistingRemoteProject(existsErr("pe", [{ slug: "nope", tabs: [] }])),
    null,
  );
});

test("never resolves a colliding slug to a remote-of-remote project", () => {
  // A project whose slug matches but is itself remote is not a local open
  // target - skip it and let the caller rethrow.
  const remoteProj = { slug: "pe", name: "pe", directory: "/x", tabs: [], remote: {} };
  assert.equal(recoverExistingRemoteProject(existsErr("pe", [remoteProj])), null);
});

test("non-Error inputs return null (no throw)", () => {
  assert.equal(recoverExistingRemoteProject(null), null);
  assert.equal(recoverExistingRemoteProject("boom"), null);
});

function mkFakeSsh() {
  const dir = mkdtempSync(join(tmpdir(), "aya-fake-ssh-"));
  const sshPath = join(dir, "ssh");
  writeFileSync(
    sshPath,
    `#!/bin/sh
target="$1"
shift
AYA_FAKE_SSH_TARGET="$target" exec sh -c "$1"
`,
  );
  chmodSync(sshPath, 0o755);
  return {
    dir,
    env: { PATH: `${dir}:${process.env.PATH}` },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function startRemoteSocket(handler) {
  const dir = mkdtempSync(join(tmpdir(), "aya-remote-client-"));
  const socket = join(dir, "aya-remote.sock");
  const server = net.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => {
      resolve({
        socket,
        cleanup: async () => {
          await new Promise((closeResolve) => server.close(closeResolve));
          rmSync(dir, { recursive: true, force: true });
        },
      });
    });
  });
}

function send(socket, value) {
  socket.write(`${JSON.stringify(value)}\n`);
}

function remoteHello() {
  return {
    type: "hello",
    protocol: 1,
    host: {
      id: "darwine",
      name: "darwine",
      platform: "linux",
      user: "hasik",
    },
    app: { version: "0.6.0-test" },
    permissions: { mode: "read-only" },
  };
}

function remoteSnapshot() {
  return {
    type: "snapshot",
    protocol: 1,
    generatedAt: 123,
    snapshot: {
      projects: [
        {
          slug: "aya",
          name: "Aya",
          directory: "/home/hasik/Projects/aya",
          tabs: [{ id: "t1", presetId: "shell", name: "Shell" }],
        },
        {
          slug: "home",
          name: "Home",
          directory: "/home/hasik",
          tabs: [],
        },
      ],
      projectState: {
        version: 1,
        order: ["aya", "home"],
        open: ["home"],
        recent: ["home", "aya"],
      },
      presets: [
        {
          id: "shell",
          name: "Shell",
          icon: "$",
          color: "",
          command: "$SHELL",
        },
        {
          id: "claude-yolo",
          name: "Claude Code",
          icon: "*",
          color: "#d97757",
          command: "claude --dangerously-skip-permissions",
        },
      ],
    },
  };
}

async function withMockRemote(testFn) {
  const fake = mkFakeSsh();
  const previousPath = process.env.PATH;
  const previousSocket = process.env.AYA_REMOTE_SOCKET;
  process.env.PATH = fake.env.PATH;
  let requestBeforeSnapshot = false;
  let snapshotSent = false;
  const remote = await startRemoteSocket((socket) => {
    socket.setEncoding("utf8");
    send(socket, remoteHello());
    setTimeout(() => {
      snapshotSent = true;
      send(socket, remoteSnapshot());
    }, 25);
    let buffer = "";
    socket.on("data", (chunk) => {
      if (!snapshotSent) requestBeforeSnapshot = true;
      buffer += chunk;
      while (buffer.includes("\n")) {
        const idx = buffer.indexOf("\n");
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const request = JSON.parse(line);
        if (request.type === "fs:list") {
          send(socket, {
            type: "fs:list-result",
            protocol: 1,
            id: request.id,
            path: request.path ?? "/home/hasik",
            entries: [
              {
                name: "Projects",
                path: "/home/hasik/Projects",
                kind: "directory",
              },
            ],
          });
        } else if (request.type === "fs:mkdir") {
          send(socket, {
            type: "fs:mkdir-result",
            protocol: 1,
            id: request.id,
            path: request.path,
          });
        } else if (request.type === "project:create") {
          send(socket, {
            type: "project:create-result",
            protocol: 1,
            id: request.id,
            project: {
              slug: "remote-project",
              name: request.name,
              directory: request.directory,
              tabs: [],
            },
          });
        }
      }
    });
  });
  process.env.AYA_REMOTE_SOCKET = remote.socket;
  try {
    await testFn({
      get requestBeforeSnapshot() {
        return requestBeforeSnapshot;
      },
    });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousSocket === undefined) delete process.env.AYA_REMOTE_SOCKET;
    else process.env.AYA_REMOTE_SOCKET = previousSocket;
    fake.cleanup();
    await remote.cleanup();
  }
}

test("remote client waits for snapshot and returns recent projects with directory listing", async () => {
  await withMockRemote(async (mock) => {
    const listing = await listRemoteDirectory("darwine", "/home/hasik");

    assert.equal(mock.requestBeforeSnapshot, false);
    assert.equal(listing.host.name, "darwine");
    assert.equal(listing.path, "/home/hasik");
    assert.deepEqual(
      listing.entries.map((entry) => `${entry.kind}:${entry.name}`),
      ["directory:Projects"],
    );
    assert.deepEqual(
      listing.presets.map((preset) => preset.id),
      ["shell", "claude-yolo"],
    );
    assert.deepEqual(
      listing.recentProjects.map((project) => `${project.slug}:${project.directory}`),
      ["home:/home/hasik", "aya:/home/hasik/Projects/aya"],
    );
  });
});

test("remote client exposes presets from the remote Aya snapshot", async () => {
  await withMockRemote(async () => {
    const presets = await listRemotePresets("darwine");

    assert.deepEqual(
      presets.map((preset) => `${preset.id}:${preset.command}`),
      ["shell:$SHELL", "claude-yolo:claude --dangerously-skip-permissions"],
    );
  });
});

test("remote client sends mkdir and project:create through the mocked ssh bridge", async () => {
  await withMockRemote(async () => {
    const created = await createRemoteDirectory(
      "darwine",
      "/home/hasik/Projects/new-project",
    );
    assert.equal(created, "/home/hasik/Projects/new-project");

    const result = await createRemoteProjectOnHost(
      "darwine",
      "/home/hasik/Projects/new-project",
      "New Project",
    );
    assert.equal(result.host.id, "darwine");
    assert.equal(result.project.slug, "remote-project");
    assert.equal(result.project.name, "New Project");
    assert.equal(result.project.directory, "/home/hasik/Projects/new-project");
    assert.deepEqual(
      result.presets.map((preset) => preset.id),
      ["shell", "claude-yolo"],
    );
  });
});
