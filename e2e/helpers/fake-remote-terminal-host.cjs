const fs = require("node:fs");
const path = require("node:path");

const home = process.env.AYA_HOME;
const socket = process.env.AYA_REMOTE_SOCKET;
const projectDir = process.env.AYA_REMOTE_TEST_PROJECT;
const hostScript = process.env.AYA_REMOTE_TEST_PTY_HOST;
const stateFile = process.env.AYA_REMOTE_TEST_STATE;
const mainPidFile = process.env.AYA_REMOTE_TEST_MAIN_PID_FILE;
const mode = process.env.AYA_REMOTE_TEST_MODE;
const projectFile = path.join(home, "projects", "e2e-proj.json");
const configuredPresets = (() => {
  try {
    const value = JSON.parse(process.env.AYA_REMOTE_TEST_PRESETS || "[]");
    return Array.isArray(value) && value.length > 0 ? value : null;
  } catch {
    return null;
  }
})();
const presets = configuredPresets || [{ id: "shell", name: "Shell", icon: "$", color: "", command: "cat" }];
fs.mkdirSync(path.dirname(projectFile), { recursive: true, mode: 0o700 });
if (!fs.existsSync(projectFile)) fs.writeFileSync(projectFile, JSON.stringify({ slug: "e2e-proj", name: "e2e", directory: projectDir, tabs: [] }), { mode: 0o600 });

const { startRemoteServerOn } = require("../../dist-electron/remote-server.js");
const { PtyHostClient } = require("../../dist-electron/pty-host-client.js");
const { RemotePtySessions } = require("../../dist-electron/remote-pty-sessions.js");
const { restoreRemoteTerminalSessions } = require("../../dist-electron/remote-session-restore.js");
const { ownerProcessStartIdentity } = require("../../dist-electron/pty-owner-client.js");
const { MAX_PTY_PANES } = require("../../dist-electron/pty-pane-limits.js");

let host;
let sessions;
let stopServer = async () => {};
let serverOpen = false;
let mainGeneration = 1;
const terminalIds = new Set();
const readProject = () => JSON.parse(fs.readFileSync(projectFile, "utf8"));
async function writeState() {
  if (!host || !stateFile) return;
  const terminals = [];
  for (const terminalId of terminalIds) terminals.push({ terminalId, pid: await host.getPid(terminalId), size: await host.getSize(terminalId) });
  fs.writeFileSync(stateFile, JSON.stringify(terminals));
}
function makeSessions() {
  const project = readProject();
  return new RemotePtySessions({
    listProjects: async () => [project],
    listPresets: async () => presets,
    ensureCapacity: async () => {
      const status = await host.hostStatus();
      if (status.ptyCount >= MAX_PTY_PANES) throw new Error(`Aya can run at most ${MAX_PTY_PANES} terminals at once.`);
    },
    spawn: (terminalId, selectedProject, selectedPreset, cols, rows) => host.spawn({
      ptyId: terminalId, projectSlug: selectedProject.slug, presetId: selectedPreset.id,
      command: selectedPreset.command, cwd: selectedProject.directory, cols, rows,
    }),
    onSpawned: async (terminalId, selectedProject, selectedPreset) => {
      terminalIds.add(terminalId);
      const current = readProject();
      if (!current.tabs.some(tab => tab.id === terminalId)) current.tabs.push({ id: terminalId, presetId: selectedPreset.id, name: `Remote ${selectedPreset.name}`, remoteTerminal: true });
      fs.writeFileSync(projectFile, JSON.stringify(current), { mode: 0o600 });
      await writeState();
    },
    write: (terminalId, data) => host.write(terminalId, data),
    resize: async (terminalId, cols, rows) => { await host.resize(terminalId, cols, rows); await writeState(); },
    exit: async (terminalId) => { await host.kill(terminalId); await writeState(); },
    isRunning: async (identity) => {
      if (!identity) return null;
      try { process.kill(identity.pid, 0); return true; }
      catch (error) { return error?.code === "ESRCH" ? false : null; }
    },
  });
}
const serverOptions = () => ({
  appVersion: "e2e",
  host: { id: "fakehost", name: "Fake remote host", platform: process.platform, user: "e2e" },
  getSnapshot: async () => {
    const project = readProject();
    return { projects: [project], projectState: { version: 1, order: [project.slug], open: [project.slug], recent: [project.slug] }, presets };
  },
  createProject: async (name, directory) => ({ slug: name, name, directory, tabs: [] }),
  ...(sessions ? { terminalSessions: sessions } : {}),
});
function startServer() { stopServer = startRemoteServerOn(socket, serverOptions()); serverOpen = true; }

if (mode === "v2") {
  host = new PtyHostClient(hostScript);
  sessions = makeSessions();
  host.attachWebContents(sessions);
}
startServer();
if (mainPidFile) fs.writeFileSync(mainPidFile, String(process.pid), { mode: 0o600 });
process.stdout.write("READY\n");

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  if (serverOpen) await stopServer();
  if (host) {
    try { await host.shutdown(); } catch {}
    host.dispose();
  }
  process.exit(0);
}
async function restartMainRegistry() {
  if (mode !== "v2") return;
  if (serverOpen) await stopServer();
  host.detachWebContents(sessions);
  sessions = makeSessions();
  await restoreRemoteTerminalSessions({
    sessions,
    listProjects: async () => [readProject()],
    getPid: (terminalId) => host.getPid(terminalId),
    getOutput: (terminalId) => host.getRemoteOutput(terminalId),
    processStartIdentity: ownerProcessStartIdentity,
    isAlive: (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== "ESRCH"; } },
    attach: () => host.attachWebContents(sessions),
  });
  mainGeneration += 1;
  // Keep the old-main endpoint unavailable long enough for the remote client
  // to observe a dropped bridge and schedule its first bounded retry.
  await new Promise(resolve => setTimeout(resolve, 1_500));
  startServer();
  await writeState();
}
process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
process.on("SIGUSR1", () => {
  const terminalId = [...terminalIds].at(-1);
  if (terminalId) void host.write(terminalId, "GAP_FROM_HOST\n").then(writeState);
});
process.on("SIGUSR2", () => { void restartMainRegistry(); });
process.on("SIGUSR3", () => { if (serverOpen) { stopServer(); serverOpen = false; } });
process.on("SIGCONT", () => { if (!serverOpen) startServer(); });
