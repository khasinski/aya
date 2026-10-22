import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = mkdtempSync(join(tmpdir(), "aya-remote-pty-"));
const home = join(root, "aya-home");
const projectDir = join(root, "project");
mkdirSync(home, { recursive: true });
mkdirSync(projectDir, { recursive: true });
process.env.AYA_HOME = home;
process.env.HOME = home;
process.env.SHELL = "/bin/sh";
process.env.AYA_REMOTE_SOCKET = join(home, "remote.sock");

const { PtyHostClient } = await import("../dist-electron/pty-host-client.js");
const { startRemoteServerOn } = await import("../dist-electron/remote-server.js");
const { RemotePtySessions } = await import("../dist-electron/remote-pty-sessions.js");
const { RemoteTerminalClient } = await import("../dist-electron/remote-client.js");
const { MAX_PTY_PANES } = await import("../dist-electron/pty-pane-limits.js");
const { createProject, listProjects, updateProjectFromLatest } = await import("../dist-electron/config.js");
const { createRemoteTerminalOnSpawned } = await import("../dist-electron/remote-terminal-project.js");
const { waitFor } = await import("./helpers/pty-host.mjs");

const hostScript = resolve("dist-electron/pty-host.js");
const ayaCli = resolve("bin/aya");
const project = { slug: "project", name: "Project", directory: projectDir, tabs: [] };
const command = "i=0; while [ $i -lt 80 ]; do printf 'REMOTE-OUTPUT-%02d\\n' $i; i=$((i+1)); sleep 0.05; done; exec cat";
const bridgeParentScript = `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const child = spawn("/bin/sh", [process.env.REMOTE_AYA_CLI, "remote", "--stdio"], { stdio: ["pipe", "pipe", "inherit"] });
fs.writeFileSync(process.env.REMOTE_BRIDGE_PID_FILE, String(child.pid));
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.once("close", (code) => { process.exitCode = code ?? 1; });
`;

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}

async function waitForAsync(predicate, timeoutMs, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error(`waitForAsync timed out after ${timeoutMs}ms`);
}

test("remote bridges can die abruptly and reattach with the exact output gap", { timeout: 120_000 }, async (t) => {
  await createProject("Project", projectDir);
  const host = new PtyHostClient(hostScript);
  const localEvents = [];
  const localSink = { isDestroyed: () => false, send: (_channel, event) => localEvents.push(event) };
  host.attachWebContents(localSink);
  let nextTerminalId = 0;
  const sessions = new RemotePtySessions({
    listProjects: async () => [project],
    listPresets: async () => [
      { id: "test", name: "Test", icon: "$", color: "", command },
      { id: "missing", name: "Missing command", icon: "$", color: "", command: "/aya-test-command-does-not-exist" },
    ],
    ensureCapacity: async () => {
      const status = await host.hostStatus();
      if (status.ptyCount >= MAX_PTY_PANES) throw new Error(`Aya can run at most ${MAX_PTY_PANES} terminals at once. Close a terminal you no longer need, then try again.`);
    },
    spawn: (id, selectedProject, preset, cols, rows) => host.spawn({
      ptyId: id, projectSlug: selectedProject.slug, presetId: preset.id,
      command: preset.command, cwd: selectedProject.directory, cols, rows,
    }),
    onSpawned: async (id, selectedProject, preset) => {
      await onRemoteTerminalSpawned(id, selectedProject, preset);
      sessionsPersisted.add(id);
    },
    write: (id, data) => host.write(id, data),
    resize: (id, cols, rows) => host.resize(id, cols, rows),
    exit: (id) => host.kill(id),
    newId: () => `remote-session-${++nextTerminalId}`,
  });
  const sessionsPersisted = new Set();
  const openedProjects = [];
  const onRemoteTerminalSpawned = createRemoteTerminalOnSpawned({
    updateProjectFromLatest,
    openProject: async (directory) => { openedProjects.push(directory); },
    broadcastProjects: () => {},
    stopTerminal: (id) => host.kill(id),
  });
  host.attachWebContents(sessions);
  const stopServer = startRemoteServerOn(process.env.AYA_REMOTE_SOCKET, {
    appVersion: "test",
    host: { id: "test-host", name: "Test host", platform: process.platform, user: "test" },
    getSnapshot: async () => ({ projects: [project], projectState: { version: 1, order: [project.slug], open: [project.slug], recent: [project.slug] }, presets: [{ id: "test", name: "Test", icon: "$", color: "", command }] }),
    createProject: async (name, directory) => ({ slug: name, name, directory, tabs: [] }),
    terminalSessions: sessions,
  });
  const clients = [];
  const parentPidFiles = [];
  const makeClient = (kind = "bridge") => {
    const env = { ...process.env, AYA_REMOTE_SOCKET: process.env.AYA_REMOTE_SOCKET };
    let bridge;
    let bridgePidFile;
    if (kind === "ssh-parent") {
      bridgePidFile = join(root, `bridge-${parentPidFiles.length}.pid`);
      parentPidFiles.push(bridgePidFile);
      bridge = spawn(process.execPath, ["-e", bridgeParentScript], {
        env: { ...env, REMOTE_AYA_CLI: ayaCli, REMOTE_BRIDGE_PID_FILE: bridgePidFile },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } else {
      bridge = spawn(ayaCli, ["remote", "--stdio"], { env, stdio: ["pipe", "pipe", "pipe"] });
    }
    const client = new RemoteTerminalClient(bridge);
    clients.push(client);
    return { client, bridge, bridgePidFile };
  };
  t.after(async () => {
    stopServer();
    for (const client of clients) await client.detach().catch(() => {});
    try { await host.shutdown(); } catch {}
    host.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  const exerciseAbruptDisconnect = async (kind) => {
    const terminalId = `remote-session-${nextTerminalId + 1}`;
    const first = makeClient(kind);
    const received = [];
    let offset = 0;
    first.client.on("output", (event) => {
      if (event.terminalId !== terminalId) return;
      received.push(event);
      offset = Math.max(offset, event.offset + Buffer.byteLength(event.data, "utf8"));
    });
    const spawned = await first.client.spawnTerminal(project.slug, "test", 80, 24);
    assert.equal(spawned.terminalId, terminalId);
    await first.client.attach(terminalId, 0);
    await waitFor(() => received.map((event) => event.data).join("").includes("REMOTE-OUTPUT-02"), 10_000);
    const resumeAt = offset;
    const originalPid = await host.getPid(terminalId);
    assert.ok(originalPid > 1);
    if (kind === "bridge") {
      await waitFor(() => received.map((event) => event.data).join("").includes("REMOTE-OUTPUT-79"), 10_000);
      assert.equal(await first.client.write(terminalId, "REMOTE-INPUT-PROBE\n"), true);
      await waitFor(() => received.map((event) => event.data).join("").includes("REMOTE-INPUT-PROBE"), 5_000);
      const initialSize = await host.getSize(terminalId);
      assert.equal(initialSize?.cols, 80);
      assert.equal(initialSize?.rows, 24);
      await first.client.resize(terminalId, 101, 33);
      await waitForAsync(async () => {
        const size = await host.getSize(terminalId);
        return size?.cols === 101 && size?.rows === 33;
      }, 5_000);
    }

    let childBridgePid;
    if (kind === "ssh-parent") {
      await waitFor(() => first.bridgePidFile && existsSync(first.bridgePidFile), 5_000);
      childBridgePid = Number(readFileSync(first.bridgePidFile, "utf8"));
      assert.ok(childBridgePid > 1);
    }
    const bridgeClosed = new Promise((resolve) => first.bridge.once("close", resolve));
    first.bridge.kill("SIGKILL");
    await bridgeClosed;
    if (childBridgePid) {
      await waitFor(() => !processAlive(childBridgePid), 5_000);
      assert.equal(processAlive(childBridgePid), false);
    }

    await waitFor(() => localEvents.filter((event) => event.type === "data" && event.ptyId === terminalId && !event.replay).map((event) => event.chunk).join("").includes("REMOTE-OUTPUT-79"), 10_000);
    assert.equal(await host.getPid(terminalId), originalPid);
    const hostBytes = Buffer.from(localEvents
      .filter((event) => event.type === "data" && event.ptyId === terminalId && !event.replay)
      .map((event) => event.chunk).join(""), "utf8");

    const second = makeClient();
    const replayed = [];
    if (kind !== "ssh-parent") second.client.on("output", (event) => { if (event.terminalId === terminalId) replayed.push(event); });
    const attached = await second.client.attach(terminalId, resumeAt);
    if (kind === "ssh-parent") {
      // Register after awaiting attach: coalesced attach+replay output must not
      // be lost before the caller can install its listener.
      second.client.on("output", (event) => { if (event.terminalId === terminalId) replayed.push(event); });
    }
    assert.equal(attached.truncated, false);
    assert.equal(attached.fromOffset, resumeAt);
    const expected = hostBytes.subarray(resumeAt, attached.endOffset);
    await waitFor(() => Buffer.byteLength(replayed.map((event) => event.data).join(""), "utf8") >= expected.length, 5_000);
    const replayBuffer = Buffer.from(replayed.map((event) => event.data).join(""), "utf8").subarray(0, expected.length);
    assert.deepEqual(replayBuffer, expected, `${kind} bridge gap should replay byte-for-byte`);
    assert.equal(await host.getPid(terminalId), originalPid);
    assert.equal((await second.client.list()).find((item) => item.terminalId === terminalId)?.state, "running");
    const exitNotice = new Promise((resolve) => second.client.once("exit", resolve));
    await second.client.exit(terminalId);
    const ended = await exitNotice;
    assert.equal(ended.terminalId, terminalId);
    assert.equal((await second.client.list()).find((item) => item.terminalId === terminalId)?.state, "exited");
    await waitForAsync(async () => (await host.getPid(terminalId)) === null, 5_000);
    assert.equal(await host.getPid(terminalId), null);
  };

  await exerciseAbruptDisconnect("bridge");
  await exerciseAbruptDisconnect("ssh-parent");

  const graceful = makeClient();
  const gracefulSpawn = await graceful.client.spawnTerminal(project.slug, "test", 80, 24);
  await graceful.client.attach(gracefulSpawn.terminalId, 0);
  const gracefulPid = await host.getPid(gracefulSpawn.terminalId);
  assert.ok(gracefulPid > 1);
  await graceful.client.detach();
  assert.equal(await host.getPid(gracefulSpawn.terminalId), gracefulPid);
  const observer = makeClient();
  assert.equal((await observer.client.list()).find((item) => item.terminalId === gracefulSpawn.terminalId)?.state, "running");
  await observer.client.attach(gracefulSpawn.terminalId, 0);
  const gracefulExit = new Promise((resolve) => observer.client.once("exit", resolve));
  await observer.client.exit(gracefulSpawn.terminalId);
  const gracefulExitEvent = await gracefulExit;
  assert.equal(gracefulExitEvent.terminalId, gracefulSpawn.terminalId);
  assert.equal(gracefulExitEvent.killed, true);
  assert.equal(gracefulExitEvent.exitCode, undefined);
  await waitForAsync(async () => (await host.getPid(gracefulSpawn.terminalId)) === null, 5_000);
  assert.equal(await host.getPid(gracefulSpawn.terminalId), null);

  const savedProject = (await listProjects()).find((item) => item.slug === project.slug);
  assert.deepEqual(savedProject.tabs.map((tab) => tab.id), ["remote-session-1", "remote-session-2", gracefulSpawn.terminalId]);
  assert.deepEqual(openedProjects, [projectDir, projectDir, projectDir]);
  assert.deepEqual([...sessionsPersisted], ["remote-session-1", "remote-session-2", gracefulSpawn.terminalId]);

  const failedSpawnClient = makeClient();
  const projectDirectory = project.directory;
  project.directory = join(root, "directory-that-does-not-exist");
  await assert.rejects(failedSpawnClient.client.spawnTerminal(project.slug, "test", 80, 24), /directory does not exist/i);
  project.directory = projectDirectory;
  assert.equal(sessionsPersisted.size, 3);
  assert.equal((await failedSpawnClient.client.list()).find((item) => item.state === "failed")?.failureReason?.length > 0, true);

  // Fill the real local PTY host to its shared limit, then verify the remote
  // request is refused before the persistence/spawn callback can add a tab.
  const localIds = [];
  try {
    for (let index = 0; index < MAX_PTY_PANES; index += 1) {
      const id = `local-cap-${index}`;
      await host.spawn({ ptyId: id, projectSlug: project.slug, presetId: "test", command: "exec sleep 60", cwd: projectDir, cols: 80, rows: 24 });
      localIds.push(id);
    }
    assert.equal((await host.hostStatus()).ptyCount, MAX_PTY_PANES);
    const atCapacity = makeClient();
    await assert.rejects(atCapacity.client.spawnTerminal(project.slug, "test", 80, 24), /at most 128 terminals at once/);
    assert.equal(sessionsPersisted.size, 3);
    assert.equal((await host.hostStatus()).ptyCount, MAX_PTY_PANES);
    assert.equal((await atCapacity.client.list()).some((item) => item.state === "running"), false);
  } finally {
    for (const batch of Array.from({ length: Math.ceil(localIds.length / 16) }, (_, index) => localIds.slice(index * 16, index * 16 + 16))) {
      await Promise.all(batch.map((id) => host.kill(id).catch(() => {})));
    }
  }
});
