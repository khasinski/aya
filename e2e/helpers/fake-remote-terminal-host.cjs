const fs = require("node:fs");
const path = require("node:path");

const home = process.env.AYA_HOME;
const socket = process.env.AYA_REMOTE_SOCKET;
const projectDir = process.env.AYA_REMOTE_TEST_PROJECT;
const hostScript = process.env.AYA_REMOTE_TEST_PTY_HOST;
const stateFile = process.env.AYA_REMOTE_TEST_STATE;
const mode = process.env.AYA_REMOTE_TEST_MODE;
const project = { slug: "e2e-proj", name: "e2e", directory: projectDir, tabs: [] };
const preset = { id: "shell", name: "Shell", icon: "$", color: "", command: "cat" };
fs.mkdirSync(path.join(home, "projects"), { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(home, "projects", "e2e-proj.json"), JSON.stringify(project), { mode: 0o600 });

const { startRemoteServerOn } = require("../../dist-electron/remote-server.js");
const { PtyHostClient } = require("../../dist-electron/pty-host-client.js");
const { RemotePtySessions } = require("../../dist-electron/remote-pty-sessions.js");
const { MAX_PTY_PANES } = require("../../dist-electron/pty-pane-limits.js");

let host;
let sessions;
const terminalIds = new Set();
async function writeState() {
  if (!host || !stateFile) return;
  const terminals = [];
  for (const terminalId of terminalIds) {
    terminals.push({ terminalId, pid: await host.getPid(terminalId), size: await host.getSize(terminalId) });
  }
  fs.writeFileSync(stateFile, JSON.stringify(terminals));
}
if (mode === "v2") {
  host = new PtyHostClient(hostScript);
  sessions = new RemotePtySessions({
    listProjects: async () => [project],
    listPresets: async () => [preset],
    ensureCapacity: async () => {
      const status = await host.hostStatus();
      if (status.ptyCount >= MAX_PTY_PANES) throw new Error(`Aya can run at most ${MAX_PTY_PANES} terminals at once.`);
    },
    spawn: (terminalId, selectedProject, selectedPreset, cols, rows) => host.spawn({
      ptyId: terminalId,
      projectSlug: selectedProject.slug,
      presetId: selectedPreset.id,
      command: selectedPreset.command,
      cwd: selectedProject.directory,
      cols,
      rows,
    }),
    onSpawned: async (terminalId) => { terminalIds.add(terminalId); await writeState(); },
    write: (terminalId, data) => host.write(terminalId, data),
    resize: async (terminalId, cols, rows) => { await host.resize(terminalId, cols, rows); await writeState(); },
    exit: async (terminalId) => { await host.kill(terminalId); await writeState(); },
    isRunning: async (identity) => {
      if (!identity) return null;
      try { process.kill(identity.pid, 0); return true; }
      catch (error) { return error?.code === "ESRCH" ? false : null; }
    },
  });
  host.attachWebContents(sessions);
}

const stopServer = startRemoteServerOn(socket, {
  appVersion: "e2e",
  host: { id: "fakehost", name: "Fake remote host", platform: process.platform, user: "e2e" },
  getSnapshot: async () => ({
    projects: [project],
    projectState: { version: 1, order: [project.slug], open: [project.slug], recent: [project.slug] },
    presets: [preset],
  }),
  createProject: async (name, directory) => ({ slug: name, name, directory, tabs: [] }),
  ...(sessions ? { terminalSessions: sessions } : {}),
});

process.stdout.write("READY\n");
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  stopServer();
  if (host) {
    try { await host.shutdown(); } catch {}
    host.dispose();
  }
  process.exit(0);
}
process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
