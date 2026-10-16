// Electron main process. Creates the window, wires IPC handlers to the PTY
// host and the project config layer.

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  shell,
  systemPreferences,
  type BrowserWindowConstructorOptions,
} from "electron";
import { autoUpdater } from "electron-updater";
import { installApplicationMenu, setStaleMenuIcon } from "./app-menu";
import { showAyaAboutPanel } from "./about-panel";
import { statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getOrCreateProject, listProjects, listProjectState, saveProjectState } from "./config";
import { bundledAyaCliPath } from "./cli-path";
import { isShellCommand, withCliFirst } from "./pane-command";
import { createCliSetup, findExecutableOnPath, pathEntries } from "./cli-setup";
import { startConfigWatcher } from "./config-watcher";
import { noteUserAnswer, onStatusPushed, outstandingWaiting } from "./agent-status";
import { deliverTeamMessage, paneOutputMarks, settledAfterSubmit, startControlServer, type ControlStatusSink, type TurnProbe } from "./control";
import { confirmOpen, dispatchOpenProject, findDirInArgv, logOpenFailure } from "./open-delivery";
import { createAyaWindows } from "./windows";
import { createCliAdoptionStore } from "./cli-adoption";
import { dropCodexBriefSections, rewriteIfChanged } from "./codex-brief";
import { syncAntigravityBrief } from "./agent-brief";
import { pathExists } from "./path-exists";
import {
  createPaneBriefDeps,
  loginShellEnv,
  removePaneBrief,
  roleNoteReport,
  sweepPaneBriefs,
  withAgentBrief,
} from "./pane-brief";
import { createSpawnGate } from "./spawn-gate";
import {
  appleChat,
  type ChatOptions,
  providerChat,
} from "./intelligence-chat";
import { withLaunchHolds, withSpawnHolds, type TeamControlDeps } from "./team-control";
import { roleLaunchCheck } from "./launch-config";
import { launchBlockOf, launchHoldOf, launchNoteOf } from "./launch-mode";
import { reachedAyaPanes } from "./reached-aya";
import { debugPane, watchDebugSwitch } from "./team-debug";
import { userShell } from "./shell";
import { registerTeamIpc } from "./ipc/team-ipc";
import { askWindowToOpenPanes, newPaneId, RendererRequests, paneAliveOf, presetAgent, teamPaneDeps, type PaneHost } from "./team-panes";
import { confirmPaneRestart, confirmRestart, confirmStoppingProcesses, type RelaunchDeps } from "./relaunch-notes";
import { foregroundCommand } from "./foreground-command";
import { createUpdates, UPDATE_AUTO_CHECK_DELAY_MS } from "./updates";
import { notePathRepaired, presetInstalled } from "./command-probe";
import type { TeamRunner } from "./team-runner";
import { startRemoteServer } from "./remote-server";
import { headCommit, workingTreeState } from "./git";
import {
  AYA_HOME,
  CLI_ADOPTION_FILE,
  CONTROL_SOCKET_PATH,
  DIAGNOSTICS_LOG_FILE,
  IS_DEV,
  IS_E2E_HEADLESS,
  IS_E2E_PTY_SHUTDOWN,
  SPAWN_PREP_DELAY_MS,
  PTY_HOST_SOCKET_PATH,
  REMOTE_SOCKET_PATH,
  REACHED_AYA_FILE,
  PANE_LAUNCH_ROLES_FILE,
  AGENT_BRIEF_FILES_FILE,
} from "./paths";
import { createPtyLog } from "./pty-log";
import { createGpuDeathHandler, diagnosticsReport } from "./diagnostics";
import { watchOmarchyTheme } from "./omarchy";
import { openExternalUrl } from "./navigation";
import { listPresets, type AgentKind } from "./presets";
import { expandUserPath } from "./usage";
import { DEFAULT_CODEX_HOME } from "./usage-codex";
import { refreshUsageHookScript, usageHookStatus } from "./usage-hook";
import { refreshStatusHookScript, migrateStatusHookCommand } from "./status-hook";
import { refreshStatusCodexHookScript } from "./status-hook-codex";
import { repairProcessPath, resolveLoginShellPath } from "./shell-path";
import { paneReadText } from "./pane-render";
import { PtyHostClient, waitForExit } from "./pty-host-client";
import { homeSocketProblems } from "./socket-path";
import { PTY_HOST_SCRIPT_NAME } from "./pty-host-staleness";
import { liveHostRecords, reapStaleHostRecords } from "./pty-host-registry";
import { createPtyHostHealth, probeSocketPid } from "./pty-host-health";
import { HOOK_VIA } from "./constants";
import { sweepLegacyAyaProcesses } from "./pty-host-sweep";
import { withSharedDirCommand } from "./agent-session";
import { loadWindowState, trackWindowState } from "./window-state";
import { createWindowProjectState } from "./window-slices";
import { loadWebConfig, saveWebConfig } from "./web-config";
import { captureIpcHandlers } from "./ipc/web-capture";
import { registerEnvIpc } from "./ipc/env-ipc";
import { registerWindowIpc } from "./ipc/window-ipc";
import { registerSystemIpc } from "./ipc/system-ipc";
import { registerUsageIpc } from "./ipc/usage-ipc";
import { registerSettingsIpc } from "./ipc/settings-ipc";
import { registerRemoteIpc } from "./ipc/remote-ipc";
import { registerProjectsIpc } from "./ipc/projects-ipc";
import { createAyaWeb, registerAyaWebIpc } from "./ipc/aya-web-ipc";
import { registerPtyIpc } from "./ipc/pty-ipc";
import { startWebServer } from "./web-server";
import {
  appleHelperPath,
  normalizeAyaIntelligenceConfig,
  ollamaStatus,
  pullOllamaModel,
  summarizeLocal,
  validateLocalSummaryRequest,
  validateOllamaModelName,
} from "./aya-intelligence";
import { restartDialog } from "./native-ui-text";
import type {
  ControlStatusUpdate,
  SpawnRequest,
} from "./types";

const DEV_SERVER_URL = "http://localhost:5183";
const RENDERER_DIST_DIR = path.join(__dirname, "..", "dist");
const RENDERER_INDEX_PATH = path.join(RENDERER_DIST_DIR, "index.html");
const WINDOW_TITLE = IS_DEV ? "Aya Dev" : "Aya";

// Per-harness count of panes that ever called `aya` (#117); shown in
// Settings -> Diagnostics.
const cliAdoption = createCliAdoptionStore(CLI_ADOPTION_FILE);
// Maximum number of entries returned by path completion
// Maximum number of keyboard-navigable projects (Cmd/Ctrl+1..9)
const MAX_KEYBOARD_PROJECTS = 9;
// Theme colors shared between About-dialog CSS and BrowserWindow chrome
const COLOR_DARK_BG = "#0d1117";
const COLOR_LIGHT_TEXT = "#f0f6fc";

import {PlannedUpdate} from "./pty-planned-update";
import {HandoverDisplays} from "./pty-handover-display";

const PTY_HOST_SCRIPT = path.join(__dirname, PTY_HOST_SCRIPT_NAME);
const ptyHost = new PtyHostClient(PTY_HOST_SCRIPT);
const spawnGate = createSpawnGate();
const paneRunning = async (ptyId: string) => (await ptyHost.getSize(ptyId)) !== null;
const teamHold = settledAfterSubmit((terminalId, pasted) => ptyHost.holdReason(terminalId, pasted));
const outputMarks = paneOutputMarks();
ptyHost.attachWebContents(outputMarks.sink);
const turnProbe: TurnProbe = {
  hold: (terminalId, pasted) => ptyHost.holdReason(terminalId, pasted),
  outputMark: outputMarks.mark,
  outputPaused: outputMarks.outputPaused,
};
/** The host's hold, except that a pane still being prepared here is starting, not gone. */
const startingHold = withSpawnHolds((terminalId) => teamHold(terminalId), (terminalId) => spawnGate.spawning(terminalId));
/** Panes whose process called aya (not through a hook): proof that settles an unknown verdict. */
const reachedAya = reachedAyaPanes({
  panePid: (terminalId) => ptyHost.getPid(terminalId),
  file: REACHED_AYA_FILE,
  onReached: (terminalId) => void debugPane(teamDeps, terminalId, "launch", { verdict: "reached" }),
});
async function launchNote(terminalId: string): Promise<string | null> {
  return launchNoteOf(await ptyHost.launch(terminalId), await reachedAya.has(terminalId));
}
// One set of team deps for the team runner and the control server's aya team.
const teamDeps: TeamControlDeps = {
  teamHome: AYA_HOME,
  listProjects: () => listProjects(),
  deliver: (terminalId, text, cancelled, entered, pasting) =>
    deliverTeamMessage((id, data) => ptyHost.write(id, data), terminalId, text, teamHold, cancelled, turnProbe, entered, pasting),
  holdReason: withLaunchHolds(startingHold, async (terminalId) => launchHoldOf(await ptyHost.launch(terminalId))),
  busy: (terminalId) => ptyHost.paneBusy(terminalId),
  roleNoteReport: (project, team, assignments) => roleNoteReport(project, team, assignments, paneBriefDeps),
  launchNote,
  screen: paneScreen,
  agentOf: paneAgent,
  headCommit,
  treeState: workingTreeState,
  starting: () => !windowProjects.bootProjectsLoaded,
};
/** A pane's rendered text, as `aya pane read` gets it; null when it is not running. */
async function paneScreen(terminalId: string): Promise<string | null> {
  const size = await ptyHost.getSize(terminalId);
  return size ? paneReadText(await ptyHost.getBuffer(terminalId), size) : null;
}
/** The agent a pane runs, from its tab's preset. */
async function paneAgent(terminalId: string): Promise<AgentKind | undefined> {
  const tab = (await listProjects()).flatMap((p) => p.tabs).find((t) => t.id === terminalId);
  const preset = tab && (await listPresets()).find((p) => p.id === tab.presetId);
  return preset ? presetAgent(preset) : undefined;
}
// Restarts that stop a turn, a shell's command or background tasks warn first, and the resumed team agents are told.
const relaunchDeps: RelaunchDeps = {
  disconnected: id => ptyHost.paneDisconnected(id),
  file: path.join(AYA_HOME, "relaunch-notes.json"),
  panes: async (ids) => (await listProjects()).flatMap((p) => p.tabs).filter((t) => !ids || ids.includes(t.id)).map(({ id, name }) => ({ id, name })),
  agentOf: paneAgent,
  screen: paneScreen,
  pid: (terminalId) => ptyHost.getPid(terminalId),
  command: async (terminalId) => {
    const launch = await ptyHost.launch(terminalId);
    return typeof launch === "object" && launch !== null ? launch.command : null;
  },
  busy: (terminalId) => ptyHost.paneBusy(terminalId),
  foreground: async (terminalId) => {
    const pid = await ptyHost.getPid(terminalId);
    return typeof pid === "number" ? foregroundCommand(pid) : null;
  },
};
/** A native yes/no before a restart that stops work in panes; `yes` names the restart. */
async function askRestart(yes: string, text: string): Promise<boolean> {
  const options = restartDialog(yes, text);
  const parent = focusedAyaWindow();
  return (await (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options))).response === 0;
}
const confirmLosingWork = (action: string, yes: string, ids?: readonly string[]) => confirmRestart(relaunchDeps, action, (text) => askRestart(yes, text), ids);
const paneOpens = new RendererRequests();
// aya team open and the Teams window's Apply panes open panes through this.
const teamPaneHost: PaneHost = {
  listPresets,
  presetInstalled,
  roleLaunch: (preset, project) =>
    roleLaunchCheck(preset.command, project?.directory ?? os.homedir(), process.env, CONTROL_SOCKET_PATH, userShell()),
  launchBlock: async (terminalId) => launchBlockOf(await ptyHost.launch(terminalId)),
  launchNote,
  // A pane still in its spawn preflight has no PTY yet but is live all the same.
  paneAlive: paneAliveOf((terminalId) => ptyHost.getSize(terminalId), startingHold),
  // The window that shows the project adds the tabs; main picked their ids.
  openPanes: (projectSlug, panes) => {
    const windowId = windowSlices.windowOf(projectSlug);
    return askWindowToOpenPanes(windowId === null ? null : BrowserWindow.fromId(windowId), paneOpens, projectSlug, panes, !windowProjects.bootProjectsLoaded);
  },
  newPaneId,
  expectRoles: (roles) => expectPaneRoles(roles),
};
// Delay before the Phase-2 legacy sweep (stray pre-registry hosts + orphaned
// terminal children of dead hosts). Off the startup path: nothing it targets
// can interfere with the fresh session, so first paint never pays for it.
const LEGACY_SWEEP_DELAY_MS = 5_000;
const windowProjects = createWindowProjectState({ listProjectState, saveProjectState, quitting: () => appQuitting });
const windows = createAyaWindows({
  BrowserWindow,
  ptyHost,
  platform: process.platform,
  mainDirname: __dirname,
  windowTitle: WINDOW_TITLE,
  darkBackground: COLOR_DARK_BG,
  isDev: IS_DEV,
  isE2eHeadless: IS_E2E_HEADLESS,
  devServerUrl: DEV_SERVER_URL,
  rendererIndexPath: RENDERER_INDEX_PATH,
  maxKeyboardProjects: MAX_KEYBOARD_PROJECTS,
  loadWindowState,
  trackWindowState,
  startConfigWatcher,
  openExternalUrl: (raw) => openExternalUrl(raw, { shell }),
  claimBootWindow: windowProjects.claimBootWindow,
  releaseWindowSlices: windowProjects.releaseWindowSlices,
  quitting: () => appQuitting,
});
const { ayaWindows, focusedAyaWindow, eachAyaWindow, createWindow, openNewWindow, createWindowOnce, windowForOpen, isAyaFullScreen, setAyaFullScreen, toggleAyaFullScreen } = windows;
const { windowSlices, projectStateForWindow } = windowProjects;
const handoverDisplays=new HandoverDisplays(async id=>{
  const project=(await listProjects()).find(p=>p.tabs.some(tab=>tab.id===id));
  const windowId=project?windowSlices.windowOf(project.slug):null;
  return windowId===null?null:BrowserWindow.fromId(windowId)?.webContents??null;
},(event,fields)=>diagnosticsLog.append(event,fields),(id,generation,token)=>ptyHost.acknowledgeHandoverDisplay(id,generation,token));
ptyHost.enableCrashRecovery({
  restored:panes=>handoverDisplays.installRecovery(panes),
  log:(event,fields)=>diagnosticsLog.append(event,fields),
});
const plannedUpdate=new PlannedUpdate({
  host:ptyHost,displays:handoverDisplays,
  livePaneIds:async()=>{const panes=await relaunchDeps.panes();const live=await Promise.all(panes.map(async p=>await relaunchDeps.pid(p.id).catch(()=>undefined)!==null?p.id:null));return live.filter((id):id is string=>id!==null);},
  expected:()=>ptyHost.expectedHostIdentity(EXPECTED_HOST_VERSION),
  confirmStop:(ids,action)=>confirmStoppingProcesses(relaunchDeps,action,text=>askRestart("Restart terminals",text),ids),
  log:(event,fields)=>diagnosticsLog.append(event,fields),
});


const { cliStatus, installCli, healDeadCliShims } = createCliSetup({
  app,
  mainDirname: __dirname,
  isDev: IS_DEV,
});

const antigravityBriefDeps = { listPresets, home: () => os.homedir(), rewrite: rewriteIfChanged };

const { paneBriefDeps, expectRoles: expectPaneRoles } = createPaneBriefDeps({
  ayaHome: AYA_HOME,
  defaultCodexHome: DEFAULT_CODEX_HOME,
  expand: expandUserPath,
  listPresets: () => listPresets(),
  listProjects: () => listProjects(),
  recordsFile: PANE_LAUNCH_ROLES_FILE,
  starts: (spawn) => ptyHost.willStart(spawn),
  running: paneRunning,
});

const { EXPECTED_HOST_VERSION, handleStaleHost, hostHealth, restartHostFromWindow, stopOtherHostsFromWindow,
  staleHostDetected, keepStaleHost } = createPtyHostHealth({
  app,
  mainDirname: __dirname,
  ptyHost,
  relaunchDeps,
  askRestart,
  confirmLosingWork,
  focusedAyaWindow,
  dialog,
  Menu,
  nativeImage,
  setStaleMenuIcon: () => setStaleMenuIcon(applicationMenuDeps),
  socketExists: () => pathExists(PTY_HOST_SOCKET_PATH),
  probeSocket: () => probeSocketPid(PTY_HOST_SOCKET_PATH),
  liveRecords: () => liveHostRecords(PTY_HOST_SCRIPT),
  kill: (pid, signal) => process.kill(pid, signal),
  waitForExit,
});

function configureAppIdentity(): void {
  // Keep macOS menu/about/notification surfaces aligned. Dev runs inside
  // Electron.app, so some OS chrome can still reflect the host bundle, but
  // setting the app identity both before and after ready gives Electron every
  // chance to expose Aya instead.
  app.setName(WINDOW_TITLE);
  process.title = WINDOW_TITLE;
  app.setAboutPanelOptions({
    applicationName: WINDOW_TITLE,
    applicationVersion: app.getVersion(),
  });
}

configureAppIdentity();

// Before the single-instance lock: a home whose sockets cannot bind would
// otherwise run on as an app nothing can reach.
const socketProblems = homeSocketProblems(AYA_HOME);
if (socketProblems.fatal) {
  console.error(`Aya: ${socketProblems.fatal}`);
  if (!IS_E2E_HEADLESS) dialog.showErrorBox("Aya cannot start", socketProblems.fatal);
  app.exit(1);
}
if (socketProblems.remote) console.error(`Aya: ${socketProblems.remote}`);

// Only one Aya instance per config dir. A second launch (e.g. `open -a Aya
// /path/to/project` or the `aya` CLI shim) sends its argv to the first
// instance via the `second-instance` event, which the renderer turns into
// a project switch / open.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// DevTools probes a few CDP domains that Electron doesn't implement
// (notably `Autofill.enable` / `Autofill.setAddresses`) and logs the
// "method not found" responses to stderr. There's no public API to disable
// the probe or filter the event, so we patch stderr to drop those specific
// lines in dev. Production builds aren't affected.
if (IS_DEV) {
  const originalWrite = process.stderr.write.bind(process.stderr);
  const isAutofillNoise = (chunk: unknown): boolean => {
    const str =
      typeof chunk === "string"
        ? chunk
        : chunk instanceof Buffer
          ? chunk.toString("utf8")
          : "";
    return /Request Autofill\.[A-Za-z]+ failed/.test(str);
  };
  // The Node typings have multiple overloads for write(); we forward all
  // possible argument shapes through to the original implementation.
  (process.stderr as NodeJS.WriteStream).write = ((
    chunk: unknown,
    encodingOrCb?: unknown,
    cb?: unknown,
  ) => {
    if (isAutofillNoise(chunk)) {
      if (typeof encodingOrCb === "function") (encodingOrCb as () => void)();
      if (typeof cb === "function") (cb as () => void)();
      return true;
    }
    return (originalWrite as unknown as (...args: unknown[]) => boolean)(
      chunk,
      encodingOrCb,
      cb,
    );
  }) as NodeJS.WriteStream["write"];
}

/** The repo's build/ icon, for dev; a packaged app's dock icon comes from the bundle. */
function devIconPath(): string {
  return path.join(__dirname, "..", "build", "icon.png");
}

function dispatchShortcut(action: string): void {
  const target = focusedAyaWindow();
  if (!target || target.isDestroyed()) return;
  target.webContents.send("shortcut", action);
}

const aboutPanelDeps = {
  app,
  isDev: IS_DEV,
  platform: process.platform,
  windowTitle: WINDOW_TITLE,
  darkBackground: COLOR_DARK_BG,
  lightText: COLOR_LIGHT_TEXT,
  focusedAyaWindow,
  createWindow: (options: BrowserWindowConstructorOptions) => new BrowserWindow(options),
  devIconPath,
};

// Deferred Phase-2 legacy-sweep timer; cancelled on quit so a mid-teardown
// sweep can't spawn a host or probe processes while the app is exiting.
let legacySweepTimer: NodeJS.Timeout | null = null;
// Set in before-quit: an already-fired sweep callback checks it and bails
// (clearTimeout can't stop a callback that is already running).
let appQuitting = false;
// A round typing at quit holds the quit this long at most for its Enter, while the pty host is still connected.
const TEAM_QUIT_SETTLE_MS = 2_000;
let teamsAtQuit: TeamRunner | null = null;
let teamsStopped = false;

const ayaWeb = createAyaWeb({
  app,
  ptyHost,
  isDev: IS_DEV,
  distDir: RENDERER_DIST_DIR,
  loadWebConfig,
  saveWebConfig,
  startWebServer,
  networkInterfaces: () => os.networkInterfaces(),
});

const applicationMenuDeps = {
  restartTerminals:restartHostFromWindow,
  app,
  Menu,
  nativeImage,
  platform: process.platform,
  windowTitle: WINDOW_TITLE,
  maxKeyboardProjects: MAX_KEYBOARD_PROJECTS,
  staleHostDetected,
  confirmLosingWork,
  ptyHost,
  showAyaAboutPanel: () => showAyaAboutPanel(aboutPanelDeps),
  dispatchShortcut,
  openNewWindow,
  focusedAyaWindow,
  toggleAyaFullScreen,
  configureAppIdentity,
};

const updates = createUpdates({
  app,
  autoUpdater: () => autoUpdater,
  isDev: IS_DEV,
  platform: process.platform,
  env: process.env,
  eachAyaWindow,
  diagnosticsLog: { append: (event, fields) => diagnosticsLog.append(event, fields) },
  dialog,
  shell,
  notifications: {
    isSupported: () => Notification.isSupported(),
    create: (options) => new Notification(options),
  },
  relaunchDeps,
  askRestart,
  preparePlannedUpdate:()=>plannedUpdate.prepare(),
  abortPlannedUpdate:()=>plannedUpdate.abort(),
});

function registerIpc(): TeamRunner {
  handoverDisplays.register(ipcMain);
  // Aya Web reuses these handlers over WebSocket - record every registration
  // (must run before the first ipcMain.handle below).
  captureIpcHandlers(ipcMain);
  // Multi-window: registered once for the whole app, so handlers that act on
  // "the window" resolve the calling renderer's BrowserWindow instead of a
  // captured reference.
  const senderWindow = (
    e: Electron.IpcMainInvokeEvent,
  ): BrowserWindow | null => BrowserWindow.fromWebContents(e.sender);
  /** A chat with the configured Aya Intelligence; no config means Apple, the default. */
  const intelligenceChat = (config: unknown, opts: ChatOptions) => {
    const intelligence = normalizeAyaIntelligenceConfig(config) ?? normalizeAyaIntelligenceConfig({})!;
    return async (system: string, user: string) => {
      const result =
        intelligence.provider === "apple"
          ? await appleChat(
              // e2e swaps in a stand-in: the real model is slow and not on every Mac.
              process.env.AYA_E2E_APPLE_HELPER || appleHelperPath(),
              system,
              user,
              opts,
            )
          : await providerChat(intelligence, system, user, opts);
      if (!result.ok) throw new Error(`Aya Intelligence did not answer (${result.error})`);
      return result.content;
    };
  };
  const teamRunner = registerTeamIpc({
    ipcMain,
    onBeforeQuit: (teardown) => app.once("before-quit", teardown),
    team: teamDeps,
    paneHost: teamPaneHost,
    intelligenceChat,
    relaunch: relaunchDeps,
    answerPaneOpen: (requestId, error) => paneOpens.answer(requestId, error),
  });
  const prepareSpawn = async (validated: SpawnRequest): Promise<SpawnRequest> => {
    if (SPAWN_PREP_DELAY_MS) await new Promise((done) => setTimeout(done, SPAWN_PREP_DELAY_MS));
    const request = await withSharedDirCommand(validated);
    // A broken presets.json must not stop panes from spawning.
    const briefed = await withAgentBrief(request, paneBriefDeps).catch((err) => {
      console.warn("[aya] aya brief skipped:", err);
      return request;
    });
    // Aya Dev: agents get this branch's aya, not an older installed one that
    // the shell's rc files put first. Shell panes stay plain shells.
    return IS_DEV && !isShellCommand(briefed.command)
      ? { ...briefed, command: withCliFirst(briefed.command, path.dirname(bundledAyaCliPath(__dirname))) }
      : briefed;
  };
  const sendSpawn = async (spawn: SpawnRequest) => {
    await ptyHost.spawn(spawn);
    void cliAdoption
      .launched({
        terminalId: spawn.ptyId,
        agent: spawn.agent,
        presetId: spawn.presetId,
      })
      .catch(() => {});
    return true;
  };
  registerPtyIpc({
    ipcMain,
    host: ptyHost,
    gate: spawnGate,
    prepareSpawn,
    sendSpawn,
    forgetBrief: (ptyId) => removePaneBrief(AYA_HOME, ptyId),
    forgetDisplay: (ptyId) => handoverDisplays.forget(ptyId),
    hasDisplay: (ptyId) => handoverDisplays.has(ptyId),
    noteTyping: async (ptyId, text) => {
      // The user's Enter answers a pane that asked for them (aya status waiting): the windows drop the status.
      const answered = await noteUserAnswer(ptyId, text, () => ptyHost.holdReason(ptyId));
      if (answered) broadcastStatus(answered);
    },
    confirmRestartPane: async (ptyId) => {
      const name = (await relaunchDeps.panes([ptyId]).catch(() => []))[0]?.name ?? "this pane";
      return confirmPaneRestart(() => confirmLosingWork(`Restarting ${name}`, "Restart", [ptyId]), (text) => askRestart("Restart", text), name);
    },
    restartHost: restartHostFromWindow,
    retryRecovery:()=>ptyHost.retryCrashRecovery(),
    stopOtherHosts: stopOtherHostsFromWindow,
    waiting: outstandingWaiting,
  });

  registerProjectsIpc({
    ipcMain,
    senderWindow,
    stateForWindow: projectStateForWindow,
    mergeSave: (state, windowId, disk) => windowSlices.mergeSave(state, windowId, disk),
  });
  registerRemoteIpc({ ipcMain, ayaHome: AYA_HOME });
  // A question from before the restart that the pane's session no longer confirms: the windows mark it.
  onStatusPushed(broadcastStatus);
  registerUsageIpc(ipcMain);
  const intelligenceDeps = { findExecutableOnPath };
  registerSettingsIpc({
    ipcMain,
    senderWindow,
    dialog,
    home: () => app.getPath("home"),
    presetsSaved: () => syncAntigravityBrief(antigravityBriefDeps),
    intelligence: {
      summarize: (req) => summarizeLocal(intelligenceDeps, validateLocalSummaryRequest(req)),
      ollamaStatus: (model) => ollamaStatus(intelligenceDeps, model),
      pullOllamaModel: (model) => pullOllamaModel(intelligenceDeps, validateOllamaModelName(model)),
    },
  });

  registerWindowIpc({
    ipcMain,
    senderWindow,
    windows: () => ayaWindows,
    activeProjectOf: (id) => windowSlices.activeProjectOf(id),
    openNewWindow,
    openProjectIn: (win, dir) => void dispatchOpenProject({ window: win }, dir).catch(logOpenFailure(dir)),
    confirmOpen,
    isFullScreen: isAyaFullScreen,
    setFullScreen: setAyaFullScreen,
  });
  registerEnvIpc({
    ipcMain,
    senderWindow,
    dialog,
    shell,
    clipboard,
    home: () => app.getPath("home"),
    openExternalUrl: (raw) => openExternalUrl(raw, { shell }),
  });
  registerSystemIpc({
    ipcMain,
    senderWindow,
    platform: process.platform,
    notifications: {
      isSupported: () => Notification.isSupported(),
      create: (options) => new Notification(options),
    },
    shell,
    systemPreferences,
    dock: app.dock,
    cliStatus,
    installCli,
    diagnosticsReport: () => diagnosticsReport({
      app,
      isDev: IS_DEV,
      ayaHome: AYA_HOME,
      controlSocketPath: CONTROL_SOCKET_PATH,
      remoteSocketPath: REMOTE_SOCKET_PATH,
      ptyHostSocketPath: PTY_HOST_SOCKET_PATH,
      listPresets,
      listProjects,
      listProjectState,
      usageHookStatus,
      cliStatus,
      hostHealth,
      cliAdoption,
      pathExists,
      pathEntries,
    }),
    updateStatus: updates.getUpdateStatus,
    checkForUpdates: updates.checkForUpdates,
    installUpdate: () => updates.install(),
  });

  // --- Aya Web (experimental) ---
  registerAyaWebIpc({
    ipcMain,
    inQueue: ayaWeb.inWebQueue,
    config: ayaWeb.config,
    save: ayaWeb.save,
    apply: ayaWeb.applyWebServerState,
    status: ayaWeb.webStatus,
  });
  return teamRunner;
}

/** second-instance / open-file: focus the open's window and deliver `dir`; with every window closed a new one is
 *  made, except before startup made its first (that would make two). */
async function openFromOutside(dir: string | null): Promise<void> {
  const target = windows.startupWindowCreated ? await windowForOpen() : focusedAyaWindow();
  if (target) {
    if (target.isMinimized()) target.restore();
    target.focus();
  }
  await dispatchOpenProject({ window: target }, dir);
}

/** Every window, and Aya Web's clients through a window-like sink (harness status dots must work in the browser too). */
function statusSinks(): ControlStatusSink[] {
  const web = { isDestroyed: () => false, webContents: { send: (channel: "control:status", update: unknown) => ayaWeb.broadcast(channel, update) } };
  return [...[...ayaWindows].filter((w) => !w.isDestroyed()), web];
}

function broadcastStatus(update: ControlStatusUpdate): void {
  for (const sink of statusSinks()) sink.webContents.send("control:status", update);
}

// Triggered when a second `Aya` launch happens while we're already running
// (the single-instance lock above redirects argv here). Focus the window and
// forward any directory argument to the renderer.
app.on("second-instance", (_e, argv, workingDir) => {
  const dir = findDirInArgv(argv) ?? workingDir ?? null;
  openFromOutside(dir).catch(logOpenFailure(dir));
});

// macOS sends open-file for `open -a Aya /path` (when invoked without --args).
app.on("open-file", (event, filePath) => {
  event.preventDefault();
  let isDirectory = false;
  try {
    isDirectory = statSync(filePath).isDirectory();
  } catch {
    // ignore
  }
  openFromOutside(isDirectory ? filePath : null).catch(logOpenFailure(filePath));
});

app.whenReady().then(async () => {
  app.once("before-quit", watchDebugSwitch(AYA_HOME));
  configureAppIdentity();

  // A GUI-launched app inherits launchd's minimal PATH: take the login shell's before the first harness scan and the
  // PTY host's spawn (it inherits this env). Bounded by the probe timeout; only a repaired PATH makes a miss "not installed".
  await repairProcessPath(async () => {
    const resolved = await resolveLoginShellPath();
    notePathRepaired(resolved !== null);
    return resolved;
  });
  // Codex gets the brief at launch now; AGENTS.md files earlier versions wrote lose it once.
  void dropCodexBriefSections(AGENT_BRIEF_FILES_FILE);
  // Presets can change on disk without a save through Settings.
  void syncAntigravityBrief(antigravityBriefDeps);
  // Needs the repaired PATH to see the user's shims; not awaited - it only
  // touches files and nothing below depends on it.
  void healDeadCliShims();
  void listProjects().then((projects) => sweepPaneBriefs(paneBriefDeps, projects)).catch(() => {});
  // Asked ahead of the first opencode pane, which waits for the answer.
  void listPresets()
    .then((presets) => void (presets.some((p) => p.agent === "opencode") && loginShellEnv()))
    .catch(() => {});
  // Installed status-hook scripts from older builds lack the AYA_VIA=hook tag
  // and would count as agent adoption; refresh them in place (never install).
  void refreshStatusHookScript().catch(() => {});
  void migrateStatusHookCommand().catch(() => {});
  void refreshStatusCodexHookScript().catch(() => {});
  // An installed usage hook from an older build copies the shared account file, which a parallel hook can replace
  // mid-copy; refresh it in place too (never install).
  void refreshUsageHookScript().catch(() => {});

  // In dev, replace Electron's default dock icon with ours so the running
  // instance is visually distinguishable. In packaged builds the bundle's
  // icon handles this, so we skip.
  if (IS_DEV && process.platform === "darwin" && app.dock) {
    try {
      const icon = nativeImage.createFromPath(devIconPath());
      if (!icon.isEmpty()) app.dock.setIcon(icon);
    } catch {
      // Non-fatal - just means we keep Electron's default dock icon.
    }
  }

  // Reap stale detached PTY hosts (and their whole process groups) that THIS
  // registry recorded - i.e. hosts from this build onward left behind by future
  // updates. A matching PTY-content host is kept (survive-restart, #28); a
  // mismatched one is force-killed by pid (fail-closed, verified via its
  // recorded start time). Pre-registry hosts have no record and are NOT covered
  // here (Phase-2 sweep); the one currently holding the socket is handled by
  // handleStaleHost after the window loads. Placement: deliberately BEFORE
  // createWindow so a recorded stale host is dead before anything can connect
  // to it; the common-path cost is one `ps -p` fork for the kept host (the
  // system-wide snapshot only runs when a kill actually happens).
  const keepPlannedHost=await plannedUpdate.resume() === "kept";
  let keptCompatibleHosts: number[] = [];
  if(!keepPlannedHost)try {
    // The host on the socket runs the panes the user sees: handleStaleHost below asks before it stops their work.
    const socketHost = (await pathExists(PTY_HOST_SOCKET_PATH)) ? (await ptyHost.hostStatus()).pid : undefined;
    const summary = reapStaleHostRecords(
      ptyHost.expectedHostIdentity(EXPECTED_HOST_VERSION),
      PTY_HOST_SCRIPT,
      undefined,
      undefined,
      socketHost,
    );
    keptCompatibleHosts = summary.keptCompatible;
    if (summary.reaped.length > 0) {
      console.log(
        `[aya] reaped ${summary.reaped.length} stale pty-host(s) + ${summary.killedDescendants.length} descendant(s):`,
        summary.reaped,
      );
    }
    if (summary.gc.length > 0 || summary.skipped.length > 0) {
      console.log(
        `[aya] pty-host registry: gc'd ${summary.gc.length} dead record(s), skipped ${summary.skipped.length} (indeterminate/probe-failed)`,
      );
    }
  } catch {
    // best effort - never block startup on reconciliation
  }

  // Reconcile the SOCKET-connected host too, still before the window exists:
  // once the renderer loads it immediately spawns terminals, and a spawn that
  // raced this check could land on the stale host and be killed by the reap
  // (losing the user's first terminal). Fast path: no socket file, no host to
  // reconcile - don't pay a probe (which would spawn a host early) on a cold
  // start. The red fallback icon is applied after installApplicationMenu.
  // Unconditionally now: with no socket file, hostHealth() starts no host, and a host still running without its
  // socket (2026-10-13) is exactly the one this must catch before the first pane starts another.
  if(keepPlannedHost)keepStaleHost();else await handleStaleHost();

  const savedState = await loadWindowState();
  windows.mainWindow = createWindow(savedState);
  windows.startupWindowCreated = true;
  const teamRunner = registerIpc();
  teamsAtQuit = teamRunner;
  updates.configureAutoUpdates(windows.mainWindow);
  // Before checking for a NEW update, surface a PREVIOUS one that silently
  // failed to install and rolled back (#78).
  void updates.reconcilePendingUpdate(windows.mainWindow);
  // Live-follow Omarchy theme switches: re-broadcast so the renderer re-skins.
  const stopOmarchyWatch = watchOmarchyTheme(() => {
    eachAyaWindow((win) => win.webContents.send("omarchy:changed"));
  });
  app.once("before-quit", stopOmarchyWatch);
  if (updates.getUpdateStatus().supported) {
    setTimeout(() => {
      void updates.checkForUpdates();
    }, UPDATE_AUTO_CHECK_DELAY_MS);
  }
  startControlServer({
    getWindow: () => focusedAyaWindow(),
    // Pane read/send resolve their target against the on-disk project configs
    // and act through the pty host, so they work regardless of which window
    // (if any) currently owns the target project.
    listProjects: () => listProjects(),
    panePid: (terminalId) => ptyHost.getPid(terminalId),
    // Rendered here, not in the pty host: up to ~50 ms per 1 MB would stall every
    // pane's output there.
    readPane: async (terminalId) => {
      const [buffer, size] = await Promise.all([
        ptyHost.getBuffer(terminalId),
        ptyHost.getSize(terminalId),
      ]);
      return paneReadText(buffer, size);
    },
    // Returned, not fire-and-forget: the boolean is how pane-send learns the
    // pane was dead, and dropping it made host rejections unhandled.
    writePane: (terminalId, data) => ptyHost.write(terminalId, data),
    paneHold: (terminalId) => ptyHost.holdReason(terminalId),
    team: teamDeps,
    teamRunner,
    teamPanes: teamPaneDeps(teamDeps, teamPaneHost, teamRunner),
    onRequest: (request, caller) => {
      // Aya's own automatic-status hooks call `aya status` from inside every
      // Claude/Codex pane; counting them would read as ~100% adoption (#121).
      if (!caller.terminalId || caller.via === HOOK_VIA) return;
      void cliAdoption
        .called({
          terminalId: caller.terminalId,
          presetId: caller.presetId,
          command: request.type,
        })
        .catch(() => {});
      // Awaited by the server: a quick command's process may be gone once it has its answer.
      return reachedAya.called(caller);
    },
    getWindows: statusSinks,
    openProject: async (directory) => {
      const target = await windowForOpen();
      if (target.isMinimized()) target.restore();
      target.focus();
      await dispatchOpenProject({ window: target }, directory);
    },
  });
  if (!socketProblems.remote) startRemoteServer({
    appVersion: app.getVersion(),
    getSnapshot: async () => ({
      projects: await listProjects(),
      projectState: await listProjectState(),
      presets: await listPresets(),
    }),
    // Open-or-create: the remote "open project" flow sends project:create even
    // for an existing project, so this must return the existing one rather than
    // fail on the "already exists" guard.
    createProject: (name, directory) => getOrCreateProject(name, directory),
  });
  ayaWeb.start();
  installApplicationMenu(applicationMenuDeps);

  // The stale-host reconcile ran before the window (see above); the menu did
  // not exist yet, so apply the red "Restart Aya" affordance now if needed.
  if (staleHostDetected()) setStaleMenuIcon(applicationMenuDeps);

  // Phase-2 legacy sweep, deferred off the startup path: clean up what the
  // registry structurally can't reach - pre-registry stray hosts (no record
  // file, e.g. left behind by builds before the registry existed) and orphaned
  // terminal children whose host already died. Deferred because none of these
  // can interfere with the fresh session (a stray host holds no socket, a dead
  // -leader orphan has no owner), so first paint shouldn't pay for the probes.
  legacySweepTimer = setTimeout(() => {
    legacySweepTimer = null;
    void (async () => {
      try {
        // A quit that races the timer can't un-schedule an already-running
        // callback - bail if teardown began (the flag is set in before-quit).
        if (appQuitting) return;
        // The current socket host must never be swept. Fail-closed twice over:
        // no socket file -> don't consult the client at all (hostStatus would
        // SPAWN a host as a side effect) and run without the stray-host pass;
        // socket present but the host reports no pid (pre-registry host) ->
        // also skip the stray-host pass, since we can't positively exclude it.
        // S2 is unaffected either way - a live host's children are never in a
        // dead-leader group.
        let strayHosts = false;
        const exclude = new Set<number>(keptCompatibleHosts);
        if (await pathExists(PTY_HOST_SOCKET_PATH)) {
          const status = await ptyHost.hostStatus();
          if (typeof status.pid === "number") {
            exclude.add(status.pid);
            strayHosts = true;
          } else {
            console.log(
              "[aya] legacy sweep: socket host has no pid handshake - skipping stray-host pass",
            );
          }
        }
        const summary = sweepLegacyAyaProcesses(exclude, undefined, { strayHosts });
        if (summary.sweptHosts.length > 0 || summary.sweptOrphans.length > 0) {
          console.log(
            `[aya] legacy sweep: killed ${summary.sweptHosts.length} stray host group(s) ${JSON.stringify(summary.sweptHosts)} + ${summary.sweptOrphans.length} orphaned terminal process(es)`,
          );
        }
        if (summary.truncated > 0) {
          console.log(
            `[aya] legacy sweep: ${summary.truncated} orphan candidate(s) beyond the probe cap - retried next launch`,
          );
        }
      } catch {
        // best effort - never destabilize a running session over cleanup
      }
    })();
  }, LEGACY_SWEEP_DELAY_MS);

  // Honor an initial directory argument on first launch - the renderer
  // applies the same switch-or-create logic as for second-instance.
  const initialDir = findDirInArgv(process.argv);
  dispatchOpenProject({ window: windows.mainWindow }, initialDir).catch(logOpenFailure(initialDir));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length > 0) return;
    createWindowOnce().catch((err) => console.warn("[aya] could not create a window:", err));
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (!teamsStopped && teamsAtQuit) {
    teamsStopped = true;
    const typing = teamsAtQuit.stopAll();
    if (typing) {
      event.preventDefault();
      void Promise.race([typing, new Promise((resolve) => setTimeout(resolve, TEAM_QUIT_SETTLE_MS))]).finally(() => app.quit());
      return;
    }
  }
  if (updates.beforeQuit(event)) return;
  appQuitting = true;
  try {
    cliAdoption.flush();
  } catch {
    // quitting anyway
  }
  if (legacySweepTimer) {
    clearTimeout(legacySweepTimer);
    legacySweepTimer = null;
  }
  gpuDeathHandler.clearHealTimers();
  if (IS_E2E_PTY_SHUTDOWN) {
    void ptyHost.shutdown().catch(() => {
      // Test-only cleanup. Normal app runs intentionally keep PTYs alive.
    });
  }
  // After the shutdown above is sent: a request from a closing window must not
  // start a host this quitting app will never connect to.
  ptyHost.dispose();
});

const diagnosticsLog = createPtyLog(DIAGNOSTICS_LOG_FILE);
const gpuDeathHandler = createGpuDeathHandler({
  diagnosticsLog,
  appQuitting: () => appQuitting,
  eachAyaWindow,
});
app.on("child-process-gone", (_event, details) => gpuDeathHandler.childProcessGone(details));
