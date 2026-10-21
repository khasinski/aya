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

test("remote bridges can die abruptly and reattach with the exact output gap", { timeout: 120_000 }, async (t) => {
  const host = new PtyHostClient(hostScript);
  const localEvents = [];
  const localSink = { isDestroyed: () => false, send: (_channel, event) => localEvents.push(event) };
  host.attachWebContents(localSink);
  let nextTerminalId = 0;
  const sessions = new RemotePtySessions({
    listProjects: async () => [project],
    listPresets: async () => [{ id: "test", name: "Test", icon: "$", color: "", command }],
    ensureCapacity: async () => {
      const status = await host.hostStatus();
      if (status.ptyCount >= MAX_PTY_PANES) throw new Error(`Aya can run at most ${MAX_PTY_PANES} terminals at once. Close a terminal you no longer need, then try again.`);
    },
    spawn: (id, selectedProject, preset, cols, rows) => host.spawn({
      ptyId: id, projectSlug: selectedProject.slug, presetId: preset.id,
      command: preset.command, cwd: selectedProject.directory, cols, rows,
    }),
    onSpawned: async (id) => { sessionsPersisted.add(id); },
    write: (id, data) => host.write(id, data),
    resize: (id, cols, rows) => host.resize(id, cols, rows),
    exit: (id) => host.kill(id),
    newId: () => `remote-session-${++nextTerminalId}`,
  });
  const sessionsPersisted = new Set();
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
    second.client.on("output", (event) => { if (event.terminalId === terminalId) replayed.push(event); });
    const attached = await second.client.attach(terminalId, resumeAt);
    assert.equal(attached.truncated, false);
    assert.equal(attached.fromOffset, resumeAt);
    const expected = hostBytes.subarray(resumeAt, attached.endOffset);
    await waitFor(() => Buffer.byteLength(replayed.map((event) => event.data).join(""), "utf8") >= expected.length, 5_000);
    const replayBuffer = Buffer.from(replayed.map((event) => event.data).join(""), "utf8").subarray(0, expected.length);
    assert.deepEqual(replayBuffer, expected, `${kind} bridge gap should replay byte-for-byte`);
    assert.equal(await host.getPid(terminalId), originalPid);
    assert.equal((await second.client.list()).find((item) => item.terminalId === terminalId)?.state, "running");
    await second.client.exit(terminalId);
  };

  await exerciseAbruptDisconnect("bridge");
  await exerciseAbruptDisconnect("ssh-parent");

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
    assert.equal(sessionsPersisted.size, 2);
    assert.equal((await host.hostStatus()).ptyCount, MAX_PTY_PANES);
    assert.equal((await atCapacity.client.list()).some((item) => item.state === "running"), false);
  } finally {
    for (const batch of Array.from({ length: Math.ceil(localIds.length / 16) }, (_, index) => localIds.slice(index * 16, index * 16 + 16))) {
      await Promise.all(batch.map((id) => host.kill(id).catch(() => {})));
    }
  }
});
