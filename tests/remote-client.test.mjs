import { test } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const {
  checkRemoteHealth,
  createRemoteDirectory,
  createRemoteProjectOnHost,
  listRemoteDirectory,
  listRemotePresets,
  recoverExistingRemoteProject,
  REMOTE_TIMEOUTS,
} = await import("../dist-electron/remote-client.js");

// --- recoverExistingRemoteProject --------------------------------------------
// An older remote Aya (before open-or-create) rejects re-opening an existing
// project with "Project \"<slug>\" already exists." The failed request still
// carried the host's project snapshot, so we recover the open from it instead
// of updating the remote host. This keeps opening remote projects working
// against remote hosts that haven't been upgraded.

function existsErr(slug, projects, host = { id: "hostname", name: "hostname" }) {
  const err = new Error(`Project "${slug}" already exists.`);
  err.remoteContext = { host, presets: [{ id: "shell" }], projects };
  return err;
}

test("recovers the existing project named by an 'already exists' error", () => {
  const pe = { slug: "pe", name: "pe", directory: "/home/username/pe", tabs: [] };
  const result = recoverExistingRemoteProject(
    existsErr("pe", [{ slug: "other", name: "o", directory: "/x", tabs: [] }, pe]),
  );
  assert.ok(result);
  assert.deepEqual(result.project, pe); // resolved absolute dir preserved
  assert.equal(result.host.id, "hostname");
  assert.equal(result.presets.length, 1);
});

test("returns null when the error carried no snapshot context", () => {
  const bare = new Error('Project "pe" already exists.');
  assert.equal(recoverExistingRemoteProject(bare), null);
});

test("returns null for errors that are not 'already exists'", () => {
  const err = new Error("Node is not available on hostname.");
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
shift
exec sh -c "$1"
`,
  );
  chmodSync(sshPath, 0o755);
  return {
    dir,
    env: { PATH: `${dir}:${process.env.PATH}` },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function startRemoteSocket(handler, subdir = "") {
  const dir = mkdtempSync(join(tmpdir(), "aya-remote-client-"));
  mkdirSync(join(dir, subdir), { recursive: true });
  const socket = join(dir, subdir, "aya-remote.sock");
  const server = net.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => {
      resolve({
        dir,
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
      id: "hostname",
      name: "hostname",
      platform: "linux",
      user: "username",
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
          directory: "/home/username/Projects/aya",
          tabs: [{ id: "t1", presetId: "shell", name: "Shell" }],
        },
        {
          slug: "home",
          name: "Home",
          directory: "/home/username",
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

async function withMockRemote(
  testFn,
  { subdir = "", envFor = (remote) => ({ AYA_REMOTE_SOCKET: remote.socket }) } = {},
) {
  const fake = mkFakeSsh();
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
            path: request.path ?? "/home/username",
            entries: [
              {
                name: "Projects",
                path: "/home/username/Projects",
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
  }, subdir);
  try {
    await withEnv({ PATH: fake.env.PATH, ...envFor(remote) }, () =>
      testFn({
        get requestBeforeSnapshot() {
          return requestBeforeSnapshot;
        },
      }),
    );
  } finally {
    fake.cleanup();
    await remote.cleanup();
  }
}

test("remote client waits for snapshot and returns recent projects with directory listing", async () => {
  await withMockRemote(async (mock) => {
    const listing = await listRemoteDirectory("hostname", "/home/username");

    assert.equal(mock.requestBeforeSnapshot, false);
    assert.equal(listing.host.name, "hostname");
    assert.equal(listing.path, "/home/username");
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
      ["home:/home/username", "aya:/home/username/Projects/aya"],
    );
  });
});

test("remote client exposes presets from the remote Aya snapshot", async () => {
  await withMockRemote(async () => {
    const presets = await listRemotePresets("hostname");

    assert.deepEqual(
      presets.map((preset) => `${preset.id}:${preset.command}`),
      ["shell:$SHELL", "claude-yolo:claude --dangerously-skip-permissions"],
    );
  });
});

test("remote client sends mkdir and project:create through the mocked ssh bridge", async () => {
  await withMockRemote(async () => {
    const created = await createRemoteDirectory(
      "hostname",
      "/home/username/Projects/new-project",
    );
    assert.equal(created, "/home/username/Projects/new-project");

    const result = await createRemoteProjectOnHost(
      "hostname",
      "/home/username/Projects/new-project",
      "New Project",
    );
    assert.equal(result.host.id, "hostname");
    assert.equal(result.project.slug, "remote-project");
    assert.equal(result.project.name, "New Project");
    assert.equal(result.project.directory, "/home/username/Projects/new-project");
    assert.deepEqual(
      result.presets.map((preset) => preset.id),
      ["shell", "claude-yolo"],
    );
  });
});

// --- timeouts ----------------------------------------------------------------
// The remote bridge gives up first and says the remote Aya is silent; the local
// ssh kill is only a backstop for an ssh that never gets the bridge running.

const SILENT_AYA = { bridgeMs: 300, sshKillMs: 60_000 };
const HUNG_SSH = { bridgeMs: 60_000, sshKillMs: 1_000 };

function mkHungSsh() {
  const dir = mkdtempSync(join(tmpdir(), "aya-hung-ssh-"));
  writeFileSync(join(dir, "ssh"), "#!/bin/sh\nexec sleep 30\n");
  chmodSync(join(dir, "ssh"), 0o755);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function withEnv(vars, fn) {
  const previous = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function failedCheck(result) {
  assert.equal(result.ok, false);
  const failed = result.checks.filter((check) => !check.ok);
  assert.equal(failed.length, 1);
  return failed[0];
}

test("a silent remote Aya fails at the bridge timeout, before the ssh kill", async () => {
  const fake = mkFakeSsh();
  const remote = await startRemoteSocket((socket) => send(socket, remoteHello()));
  try {
    const started = Date.now();
    const result = await withEnv(
      { PATH: fake.env.PATH, AYA_REMOTE_SOCKET: remote.socket },
      () => checkRemoteHealth("hostname", SILENT_AYA),
    );
    const elapsed = Date.now() - started;
    const failed = failedCheck(result);
    assert.equal(failed.stage, "aya-remote");
    assert.equal(failed.message, "Remote Aya did not respond within 0.3s.");
    assert.ok(elapsed >= SILENT_AYA.bridgeMs && elapsed < REMOTE_TIMEOUTS.bridgeMs, `took ${elapsed}ms`);
    assert.deepEqual(
      result.checks.map((check) => `${check.stage}:${check.ok}`),
      ["ssh:true", "node:true", "aya-remote:false"],
    );
  } finally {
    fake.cleanup();
    await remote.cleanup();
  }
});

test("an ssh that never starts the bridge is killed at the backstop and blamed on ssh", async () => {
  const hung = mkHungSsh();
  try {
    const started = Date.now();
    const result = await withEnv({ PATH: `${hung.dir}:${process.env.PATH}` }, () =>
      checkRemoteHealth("hostname", HUNG_SSH),
    );
    const elapsed = Date.now() - started;
    const failed = failedCheck(result);
    assert.equal(failed.stage, "ssh");
    assert.equal(failed.message, "ssh hostname did not finish within 1s.");
    assert.ok(elapsed >= HUNG_SSH.sshKillMs, `took ${elapsed}ms`);
  } finally {
    hung.cleanup();
  }
});

test("the ssh kill backstop leaves the bridge timeout room to report first", () => {
  assert.ok(REMOTE_TIMEOUTS.sshKillMs - REMOTE_TIMEOUTS.bridgeMs >= 5_000);
});

// --- socket fallback ---------------------------------------------------------
// Without AYA_REMOTE_SOCKET the bridge uses $AYA_HOME, else the installed Aya's
// ~/.aya - AYA_DEV never reaches an ssh session (docs/remote-sessions.md).

async function presetsViaFallback(subdir, envFor) {
  let ids = [];
  await withMockRemote(
    async () => {
      ids = (await listRemotePresets("hostname")).map((preset) => preset.id);
    },
    { subdir, envFor: (remote) => ({ AYA_REMOTE_SOCKET: undefined, ...envFor(remote.dir) }) },
  );
  return ids;
}

test("the bridge falls back to $AYA_HOME/aya-remote.sock", async () => {
  const ids = await presetsViaFallback("", (dir) => ({ AYA_HOME: dir, HOME: "/nonexistent" }));
  assert.deepEqual(ids, ["shell", "claude-yolo"]);
});

test("without AYA_HOME the bridge reaches ~/.aya even when AYA_DEV=1", async () => {
  const ids = await presetsViaFallback(".aya", (dir) => ({
    AYA_HOME: undefined,
    AYA_DEV: "1",
    HOME: dir,
  }));
  assert.deepEqual(ids, ["shell", "claude-yolo"]);
});
