import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
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
const { waitFor } = await import("./helpers/pty-host.mjs");

const hostScript = resolve("dist-electron/pty-host.js");
const terminalId = "remote-session-1";
const project = { slug: "project", name: "Project", directory: projectDir, tabs: [] };
const command = "i=0; while [ $i -lt 80 ]; do printf 'REMOTE-OUTPUT-%02d\\n' $i; i=$((i+1)); sleep 0.05; done; exec cat";

test("remote stdio bridge detaches and reattaches to a live PTY with bounded replay", { timeout: 30_000 }, async (t) => {
  const host = new PtyHostClient(hostScript);
  const localEvents = [];
  const localSink = { isDestroyed: () => false, send: (_channel, event) => localEvents.push(event) };
  host.attachWebContents(localSink);
  const sessions = new RemotePtySessions({
    listProjects: async () => [project],
    listPresets: async () => [{ id: "test", name: "Test", icon: "$", color: "", command }],
    spawn: (id, selectedProject, preset, cols, rows) => host.spawn({
      ptyId: id, projectSlug: selectedProject.slug, presetId: preset.id,
      command: preset.command, cwd: selectedProject.directory, cols, rows,
    }),
    write: (id, data) => host.write(id, data),
    resize: (id, cols, rows) => host.resize(id, cols, rows),
    exit: (id) => host.kill(id),
    newId: () => terminalId,
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
  const makeClient = () => {
    const bridge = spawn(resolve("bin/aya"), ["remote", "--stdio"], { env: { ...process.env, AYA_REMOTE_SOCKET: process.env.AYA_REMOTE_SOCKET }, stdio: ["pipe", "pipe", "pipe"] });
    const client = new RemoteTerminalClient(bridge);
    clients.push(client);
    return client;
  };
  t.after(async () => {
    stopServer();
    for (const client of clients) await client.detach().catch(() => {});
    try { await host.kill(terminalId); } catch {}
    try { await host.shutdown(); } catch {}
    host.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  const first = makeClient();
  const firstOutput = [];
  let offset = 0;
  first.on("output", (event) => {
    if (event.terminalId !== terminalId) return;
    firstOutput.push(event.data);
    offset = Math.max(offset, event.offset + Buffer.byteLength(event.data, "utf8"));
  });
  const spawned = await first.spawnTerminal(project.slug, "test", 80, 24);
  assert.equal(spawned.terminalId, terminalId);
  await first.attach(terminalId, 0);
  await waitFor(() => firstOutput.join("").includes("REMOTE-OUTPUT-02"), 10_000);
  const resumeAt = offset;
  await first.detach();

  // The client bridge is gone, but output continues into the host-side replay
  // ring and the ordinary host process remains alive.
  await waitFor(() => localEvents.filter((event) => event.type === "data" && event.ptyId === terminalId).map((event) => event.chunk).join("").includes("REMOTE-OUTPUT-20"), 10_000);
  const pidWhileDetached = await host.getPid(terminalId);
  assert.ok(pidWhileDetached > 1);

  const second = makeClient();
  const replayed = [];
  const exits = [];
  second.on("output", (event) => { if (event.terminalId === terminalId) replayed.push(event); });
  second.on("exit", (event) => exits.push(event));
  const attached = await second.attach(terminalId, resumeAt);
  assert.equal(attached.truncated, false);
  assert.equal(attached.fromOffset, resumeAt);
  await waitFor(() => replayed.map((event) => event.data).join("").includes("REMOTE-OUTPUT-20"), 5_000);
  assert.equal(await host.getPid(terminalId), pidWhileDetached);
  assert.equal((await second.list()).find((item) => item.terminalId === terminalId)?.state, "running");

  await second.exit(terminalId);
  await waitFor(() => exits.some((event) => event.terminalId === terminalId), 5_000);
  assert.equal((await second.list()).find((item) => item.terminalId === terminalId)?.state, "exited");
});
