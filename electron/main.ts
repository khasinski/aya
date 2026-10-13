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
  type MenuItemConstructorOptions,
} from "electron";
import { autoUpdater } from "electron-updater";
import { installWindowZoom } from "./zoom";
import {
  accessSync,
  constants as fsConstants,
  promises as fs,
  readFileSync,
  statSync,
} from "node:fs";
import { deflateSync } from "node:zlib";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import * as path from "node:path";
import { getOrCreateProject, listProjects, listProjectState, saveProjectState } from "./config";
import { bundledAyaCliPath, bundledDistElectronHelperPath } from "./cli-path";
import { isShellCommand, withCliFirst } from "./pane-command";
import { defaultInstallAyaCliPath, renderCliShim } from "./cli-shim";
import {
  type AyaCopy,
  ayaShimTargets,
  chooseCliInstallDir,
  describeCliStatus,
  insideAsarArchive,
  offPathNote,
  planCliInstall,
} from "./cli-install";
import { startConfigWatcher } from "./config-watcher";
import { noteUserAnswer, onStatusPushed, outstandingWaiting } from "./agent-status";
import { deliverTeamMessage, paneOutputMarks, settledAfterSubmit, startControlServer, type ControlStatusSink, type TurnProbe } from "./control";
import { confirmOpen, deliverOpenProject, replayOpensOnLoad } from "./open-delivery";
import { createWindowSource } from "./window-for-open";
import { createCliAdoptionStore } from "./cli-adoption";
import { TMP_SUFFIX } from "./atomic-write";
import { dropCodexBriefSections, rewriteIfChanged } from "./codex-brief";
import {
  briefText,
  antigravityBriefFile,
  withOwnedBrief,
  withoutOwnedBrief,
} from "./agent-brief";
import { paneTeamRole } from "./team-files";
import { pathExists } from "./path-exists";
import {
  fileLaunchRecords,
  loginShellEnv,
  removePaneBrief,
  roleNoteReport,
  sweepPaneBriefs,
  withAgentBrief,
  type PaneBriefDeps,
  type RoleRef,
} from "./pane-brief";
import { closePane, createSpawnGate } from "./spawn-gate";
import { oneAtATime } from "./keyed-queue";
import {
  appleChat,
  type ChatOptions,
  type ChatResult,
  APPLE_HELPER_STDOUT_MAX_BYTES,
  OLLAMA_BASE_URL,
  providerChat,
  RECOMMENDED_OLLAMA_MODEL,
} from "./intelligence-chat";
import { withLaunchHolds, withSpawnHolds, type TeamControlDeps } from "./team-control";
import { roleLaunchCheck } from "./launch-config";
import { launchBlockOf, launchHoldOf, launchNoteOf } from "./launch-mode";
import { reachedAyaPanes } from "./reached-aya";
import { debugPane, watchDebugSwitch } from "./team-debug";
import { userShell } from "./shell";
import { registerTeamIpc } from "./team-ipc";
import { askWindowToOpenPanes, newPaneId, RendererRequests, paneAliveOf, presetAgent, teamPaneDeps, type PaneHost } from "./team-panes";
import { confirmRestart, type RelaunchDeps } from "./relaunch-notes";
import { restartStaleHost, updateInstaller } from "./update-quit";
import { notePathRepaired, presetInstalled } from "./command-probe";
import type { TeamRunner } from "./team-runner";
import { startRemoteServer } from "./remote-server";
import { headCommit, workingTreeState } from "./git";
import {
  AYA_HOME,
  CLI_ADOPTION_FILE,
  CONTROL_SOCKET_PATH,
  DIAGNOSTICS_LOG_FILE,
  EXECUTABLE_FILE_MODE,
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
import {
  diagnoseRelaunch,
  readPendingUpdate,
  markPendingUpdate,
  markPendingUpdateSync,
  clearPendingUpdate,
  cleanShipItCache,
  shouldCleanShipItCache,
} from "./update-recovery";
import { watchOmarchyTheme } from "./omarchy";
import { isInternalNavigationUrl, parseExternalUrl } from "./navigation";
import { listPresets, type AgentKind } from "./presets";
import { expandUserPath } from "./usage";
import { DEFAULT_CODEX_HOME } from "./usage-codex";
import { usageHookStatus } from "./usage-hook";
import { refreshStatusHookScript, migrateStatusHookCommand } from "./status-hook";
import { refreshStatusCodexHookScript } from "./status-hook-codex";
import { searchHarnessSessions } from "./harness-search";
import {
  LOCAL_SUMMARY_MAX_LINES,
  normalizeLocalSummaryError,
  SUMMARY_TEXT_MAX_CHARS,
} from "./local-summary-errors";
import { repairProcessPath, resolveLoginShellPath } from "./shell-path";
import { paneReadText } from "./pane-render";
import { PTY_HOST_EXIT_WAIT_MS, PtyHostClient, waitForExit } from "./pty-host-client";
import { homeSocketProblems } from "./socket-path";
import { PTY_HOST_SCRIPT_NAME } from "./pty-host-staleness";
import { liveHostRecords, reapStaleHostRecords } from "./pty-host-registry";
import { gatherHostHealth, probeSocketPid, type HostHealth } from "./pty-host-health";
import { COMMAND_PROBE_TIMEOUT_MS, HOOK_VIA, PTY_HOST_NOT_CONNECTED, PTY_HOST_UNKNOWN_REQUEST } from "./constants";
import { sweepLegacyAyaProcesses } from "./pty-host-sweep";
import { requirePositiveInt, requireString, validateSpawnRequest } from "./validation";
import { withSharedDirCommand } from "./agent-session";
import { loadWindowState, trackWindowState } from "./window-state";
import { WindowProjectSlices } from "./window-slices";
import {
  loadWebConfig,
  saveWebConfig,
  webInterfaceAddresses,
  webServerUrls,
  type WebConfig,
} from "./web-config";
import { captureIpcHandlers } from "./web-ipc";
import { registerEnvIpc } from "./ipc/env-ipc";
import { registerWindowIpc } from "./ipc/window-ipc";
import { registerSystemIpc } from "./ipc/system-ipc";
import { registerUsageIpc } from "./ipc/usage-ipc";
import { registerSettingsIpc } from "./ipc/settings-ipc";
import { registerRemoteIpc } from "./ipc/remote-ipc";
import { registerProjectsIpc } from "./ipc/projects-ipc";
import { registerAyaWebIpc } from "./ipc/aya-web-ipc";
import { startWebServer, type WebServerHandle } from "./web-server";
import { parseSummaryResponse, summaryPrompt } from "./summary-prompt";
import { restartDialog } from "./native-ui-text";
import type {
  AyaIntelligenceConfig,
  CliStatus,
  ControlStatusUpdate,
  DiagnosticsReport,
  LocalSummaryRequest,
  SpawnRequest,
  LocalSummaryResult,
  OllamaStatus,
  ProjectCollectionState,
  UpdateStatus,
  WebServerStatus,
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
// Minimum dimensions of the main application window (px)
const WINDOW_MIN_WIDTH = 800;
const WINDOW_MIN_HEIGHT = 500;
// Theme colors shared between About-dialog CSS and BrowserWindow chrome
const COLOR_DARK_BG = "#0d1117";
const COLOR_LIGHT_TEXT = "#f0f6fc";
// About dialog window dimensions (square, px)
const ABOUT_DIALOG_SIZE = 360;
// About dialog icon dimensions (square, px)
const ABOUT_ICON_SIZE = 128;
const STALE_MENU_DOT_PX = 16;
const STALE_MENU_DOT_SCALE_FACTOR = 2;
const LOCAL_SUMMARY_TIMEOUT_MS = 20_000;
// Cascade offset for a window opened from another window (File > New Window,
// tab tear-out), so it doesn't cover its parent exactly.
const NEW_WINDOW_CASCADE_OFFSET_PX = 28;
const TEAR_OUT_CURSOR_OFFSET_X_PX = 80;
const TEAR_OUT_CURSOR_OFFSET_Y_PX = 20;
// Heal nudges after a GPU death: the typical relaunch window, then a safety net
// (a no-op once the WebGL context is live again).
const GPU_HEAL_NUDGE_DELAYS_MS = [1200, 3000];

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
  starting: () => !bootProjectsLoaded,
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
// Restarts that stop the panes' background tasks and monitors warn first, and the resumed team agents are told.
const relaunchDeps: RelaunchDeps = {
  file: path.join(AYA_HOME, "relaunch-notes.json"),
  panes: async (ids) => (await listProjects()).flatMap((p) => p.tabs).filter((t) => !ids || ids.includes(t.id)).map(({ id, name }) => ({ id, name })),
  agentOf: paneAgent,
  screen: paneScreen,
  pid: (terminalId) => ptyHost.getPid(terminalId),
  command: async (terminalId) => {
    const launch = await ptyHost.launch(terminalId);
    return typeof launch === "object" && launch !== null ? launch.command : null;
  },
};
/** A native yes/no before a restart that stops background work; `yes` names the restart. */
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
    return askWindowToOpenPanes(windowId === null ? null : BrowserWindow.fromId(windowId), paneOpens, projectSlug, panes, !bootProjectsLoaded);
  },
  newPaneId,
  expectRoles: (roles) => {
    for (const { ptyId, team, role } of roles) pendingPaneRoles.set(ptyId, { team, role });
    return () => roles.forEach(({ ptyId }) => pendingPaneRoles.delete(ptyId));
  },
};
const UPDATE_AUTO_CHECK_DELAY_MS = 12_000;
// Summarizer sampling knobs, shared by BOTH backends (OpenAI-compatible and
// Ollama) - the two request builders must stay in sync.
const SUMMARY_TEMPERATURE = 0.2;
const SUMMARY_MAX_TOKENS = 64;
// Bound captured `ollama pull` stderr so a chatty child can't balloon memory.
const OLLAMA_PULL_STDERR_MAX_BYTES = 8192;
// Max accepted Ollama model-name length (IPC input-validation cap).
const OLLAMA_MODEL_NAME_MAX_LEN = 120;
const OLLAMA_MODEL_NAME_RE = new RegExp(`^[A-Za-z0-9._:/-]{1,${OLLAMA_MODEL_NAME_MAX_LEN}}$`);
// Cap of $PATH entries returned to the renderer diagnostics view.
const MAX_PATH_ENTRIES_RETURNED = 40;
// Delay before re-probing a host that answered the version handshake with
// null - long enough for a slow cold spawn to finish listening.
const STALE_HOST_REPROBE_DELAY_MS = 1_000;
// macOS needs a moment after fullscreen transitions before the window hack
// can be re-applied.
const MACOS_FULLSCREEN_HACK_DELAY_MS = 250;
// Delay before the Phase-2 legacy sweep (stray pre-registry hosts + orphaned
// terminal children of dead hosts). Off the startup path: nothing it targets
// can interfere with the fresh session, so first paint never pays for it.
const LEGACY_SWEEP_DELAY_MS = 5_000;
let updateStatus: UpdateStatus = {
  phase: "idle",
  supported: false,
  currentVersion: "0.0.0",
};
let updateEventsConfigured = false;
let updateCheckInFlight: Promise<UpdateStatus> | null = null;
// True from the moment we hand off to ShipIt until we quit (#78). A second
// install click must not spawn a second ShipIt - overlapping install requests
// are a suspected cause of the silent-rollback failure.
const updateLatch = { installing: false };
// Sticky #78 warning: the phase it used to live in is replaced by the startup
// auto-check 12 s later, so it is merged in separately and cleared on apply.
let rollbackNotice: string | null = null;
// Where to send a user whose auto-update silently failed (#78).
const RELEASES_URL = "https://github.com/khasinski/aya/releases/latest";
let macosWindowHack:
  | {
      apply(handle: Buffer): void;
    }
  | null
  | undefined;

function applyMacOsWindowHack(win: BrowserWindow): void {
  if (process.platform !== "darwin" || win.isDestroyed()) return;
  if (macosWindowHack === undefined) {
    try {
      macosWindowHack = require(path.join(__dirname, "macos-window-hack.node")) as {
        apply(handle: Buffer): void;
      };
    } catch (error) {
      macosWindowHack = null;
      if (IS_DEV) console.warn("macOS window hack unavailable", error);
    }
  }
  if (!macosWindowHack) return;
  try {
    macosWindowHack.apply(win.getNativeWindowHandle());
  } catch (error) {
    if (IS_DEV) console.warn("macOS window hack failed", error);
  }
}

function isAyaFullScreen(win: BrowserWindow): boolean {
  return win.isFullScreen();
}

function setAyaFullScreen(win: BrowserWindow, value: boolean): void {
  if (win.isDestroyed()) return;
  win.setFullScreen(value);
  win.webContents.send("app:fullscreen", isAyaFullScreen(win));
}

function toggleAyaFullScreen(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;
  setAyaFullScreen(win, !isAyaFullScreen(win));
}

function unavailableLocalSummary(error?: string): LocalSummaryResult {
  const normalized = normalizeLocalSummaryError(error);
  return {
    available: false,
    useful: false,
    summary: "",
    ...(normalized ? { error: normalized } : {}),
  };
}

function normalizeAyaIntelligenceConfig(
  value: unknown,
): AyaIntelligenceConfig | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const input = value as Record<string, unknown>;
  const provider =
    input.provider === "ollama" || input.provider === "openai"
      ? input.provider
      : "apple";
  return {
    provider,
    ollamaModel:
      typeof input.ollamaModel === "string" && input.ollamaModel.trim()
        ? input.ollamaModel.trim()
        : RECOMMENDED_OLLAMA_MODEL,
    openAiBaseUrl:
      typeof input.openAiBaseUrl === "string" ? input.openAiBaseUrl.trim() : "",
    openAiApiKey:
      typeof input.openAiApiKey === "string" ? input.openAiApiKey.trim() : "",
    openAiModel:
      typeof input.openAiModel === "string" ? input.openAiModel.trim() : "",
  };
}

function validateLocalSummaryRequest(value: unknown): LocalSummaryRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("local-summary:summarize.req must be an object");
  }
  const req = value as Record<string, unknown>;
  const kind = req.kind === "project" ? "project" : "terminal";
  if (!Array.isArray(req.lines)) {
    throw new Error("local-summary:summarize.lines must be an array");
  }
  const lines = req.lines
    .filter((line): line is string => typeof line === "string")
    .slice(-LOCAL_SUMMARY_MAX_LINES);
  return {
    kind,
    lines,
    ...(req.intelligence
      ? { intelligence: normalizeAyaIntelligenceConfig(req.intelligence) }
      : {}),
  };
}

/** The bundled Apple Foundation Models helper (no e2e override). */
function appleHelperPath(): string {
  return bundledDistElectronHelperPath(__dirname, "aya-local-summary");
}

async function summarizeWithApple(
  req: LocalSummaryRequest,
): Promise<LocalSummaryResult> {
  if (process.platform !== "darwin") return unavailableLocalSummary("unsupported-platform");
  const helper = appleHelperPath();
  try {
    await fs.access(helper, fsConstants.X_OK);
  } catch {
    return unavailableLocalSummary("helper-missing");
  }

  return new Promise((resolve) => {
    const child = spawn(helper, [], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve(unavailableLocalSummary("timeout"));
    }, LOCAL_SUMMARY_TIMEOUT_MS);

    const finish = (result: LocalSummaryResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < APPLE_HELPER_STDOUT_MAX_BYTES) stdout += chunk;
    });
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < APPLE_HELPER_STDOUT_MAX_BYTES) stderr += chunk;
    });
    child.on("error", (error) => finish(unavailableLocalSummary(error.message)));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(unavailableLocalSummary(stderr.trim() || `helper-exit-${code}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as Partial<LocalSummaryResult>;
        const summary =
          typeof parsed.summary === "string"
            ? parsed.summary.replace(/\s+/g, " ").trim().slice(0, SUMMARY_TEXT_MAX_CHARS)
            : "";
        finish({
          available: parsed.available === true,
          useful: parsed.useful === true && summary.length > 0,
          summary: parsed.useful === true ? summary : "",
          ...(typeof parsed.error === "string" && parsed.error
            ? { error: normalizeLocalSummaryError(parsed.error) }
            : {}),
        });
      } catch {
        finish(unavailableLocalSummary("invalid-helper-json"));
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(req));
  });
}

const SUMMARY_SYSTEM = "You summarize terminal output for a developer tool. Return JSON only.";
const SUMMARY_CHAT = {
  temperature: SUMMARY_TEMPERATURE,
  maxTokens: SUMMARY_MAX_TOKENS,
  timeoutMs: LOCAL_SUMMARY_TIMEOUT_MS,
};

function summaryFromChat(result: ChatResult): LocalSummaryResult {
  if (!result.ok) return unavailableLocalSummary(result.error);
  if (!result.content) return { available: true, useful: false, summary: "" };
  return parseSummaryResponse(result.content);
}

async function summarizeLocal(
  req: LocalSummaryRequest,
): Promise<LocalSummaryResult> {
  const intelligence = req.intelligence;
  if (!intelligence || intelligence.provider === "apple") {
    return summarizeWithApple(req);
  }
  return summaryFromChat(await providerChat(intelligence, SUMMARY_SYSTEM, summaryPrompt(req), SUMMARY_CHAT));
}

async function ollamaStatus(
  recommendedModel = RECOMMENDED_OLLAMA_MODEL,
): Promise<OllamaStatus> {
  const executable = findExecutableOnPath("ollama");
  if (!executable) {
    return {
      installed: false,
      running: false,
      path: null,
      models: [],
      recommendedModel,
      recommendedModelInstalled: false,
      message: "Ollama is not installed or not on PATH.",
    };
  }
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(COMMAND_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return {
        installed: true,
        running: false,
        path: executable,
        models: [],
        recommendedModel,
        recommendedModelInstalled: false,
        message: `Ollama API returned HTTP ${response.status}.`,
      };
    }
    const json = (await response.json()) as {
      models?: Array<{ name?: unknown; model?: unknown }>;
    };
    const models = (Array.isArray(json.models) ? json.models : [])
      .map((model) =>
        typeof model.name === "string"
          ? model.name
          : typeof model.model === "string"
            ? model.model
            : "",
      )
      .filter(Boolean);
    return {
      installed: true,
      running: true,
      path: executable,
      models,
      recommendedModel,
      recommendedModelInstalled: models.includes(recommendedModel),
    };
  } catch (err) {
    return {
      installed: true,
      running: false,
      path: executable,
      models: [],
      recommendedModel,
      recommendedModelInstalled: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function validateOllamaModelName(value: unknown): string {
  const model = requireString(value, "intelligence:pull-ollama-model.model").trim();
  if (!OLLAMA_MODEL_NAME_RE.test(model)) {
    throw new Error("Ollama model name contains unsupported characters.");
  }
  return model;
}

async function pullOllamaModel(model: string): Promise<OllamaStatus> {
  const executable = findExecutableOnPath("ollama");
  if (!executable) throw new Error("Ollama is not installed or not on PATH.");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ["pull", model], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < OLLAMA_PULL_STDERR_MAX_BYTES) stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `ollama pull exited ${code}`));
    });
  });
  return ollamaStatus(model);
}

function pathEntries(): string[] {
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    // Relative entries (`node_modules/.bin`, `.`) depend on the cwd, so an
    // `aya` found or written there means nothing to a shell elsewhere.
    .filter((entry) => entry.trim().length > 0 && path.isAbsolute(entry));
}

function findExecutableOnPath(name: string): string | null {
  for (const entry of pathEntries()) {
    const candidate = path.join(entry, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

async function anyExecutable(paths: string[]): Promise<boolean> {
  for (const p of paths) {
    try {
      await fs.access(p, fsConstants.X_OK);
      return true;
    } catch {
      // try the next candidate
    }
  }
  return false;
}

/** A missing dir counts when its nearest existing ancestor is writable, since
 *  install creates it (a fresh ~/.local/bin). */
function isWritableDir(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false;
    accessSync(dir, fsConstants.W_OK);
    return true;
  } catch (err) {
    const parent = path.dirname(dir);
    return (
      (err as NodeJS.ErrnoException).code === "ENOENT" &&
      parent !== dir &&
      isWritableDir(parent)
    );
  }
}

/** Something at `target` that Reinstall must not write through: a symlink, or
 *  a file that is not our shim. */
async function foreignFileAt(target: string): Promise<boolean> {
  try {
    if ((await fs.lstat(target)).isSymbolicLink()) return true;
    return ayaShimTargets(await fs.readFile(target, "utf-8")).length === 0;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** Every `aya` on PATH, in PATH order - not just the one a shell runs, so a
 *  dead copy waiting below it is visible too (#115). */
async function ayaCopiesOnPath(): Promise<AyaCopy[]> {
  const copies: AyaCopy[] = [];
  const seen = new Set<string>();
  for (const entry of pathEntries()) {
    const candidate = path.join(entry, "aya");
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      accessSync(candidate, fsConstants.X_OK);
    } catch {
      continue;
    }
    // A symlink (e.g. into a dotfiles repo) is the user's arrangement: listed,
    // but never ours to rewrite, repair or remove (#120 review).
    let symlink = false;
    try {
      symlink = (await fs.lstat(candidate)).isSymbolicLink();
    } catch {
      // vanished between access and lstat: treat as a plain file
    }
    let targets: string[] = [];
    try {
      targets = ayaShimTargets(await fs.readFile(candidate, "utf-8"));
    } catch {
      // unreadable: treat as not ours
    }
    // A shim can be on PATH yet dead: it bakes an absolute path into Aya.app,
    // and moving/renaming the app kills it (follow-up on #42).
    const ours = targets.length > 0 && !symlink;
    copies.push({
      path: candidate,
      ours,
      broken:
        ours &&
        !(await anyExecutable(
          targets.filter((target) => !insideAsarArchive(target)),
        )),
    });
  }
  return copies;
}

function cliInstallDir() {
  return chooseCliInstallDir(pathEntries(), os.homedir(), isWritableDir);
}

async function cliStatus(): Promise<CliStatus> {
  const copies = await ayaCopiesOnPath();
  const choice = cliInstallDir();
  const active = copies[0] ?? null;
  const message = describeCliStatus(copies, choice);
  return {
    installed: active !== null,
    path: active?.path ?? null,
    installDir: choice.dir,
    installable: true,
    copies,
    ...(message ? { message } : {}),
  };
}

function freshCliShim(): string {
  return renderCliShim(
    bundledAyaCliPath(__dirname),
    defaultInstallAyaCliPath(process.platform),
  );
}

async function writeCliShim(target: string, script: string): Promise<void> {
  // Temp file + rename: a failed write can't leave a truncated, dead shim, and
  // rename replaces the entry itself instead of writing through a link.
  const tmp = `${target}.aya-${process.pid}${TMP_SUFFIX}`;
  try {
    await fs.writeFile(tmp, script, { mode: EXECUTABLE_FILE_MODE });
    await fs.chmod(tmp, EXECUTABLE_FILE_MODE);
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

async function installCli(): Promise<CliStatus> {
  const choice = cliInstallDir();
  const installDir = choice.dir;
  const source = bundledAyaCliPath(__dirname);
  // Refuse to install a shim that cannot work. The asar path bug (#39) made
  // Install report success while the written shim exec'd a file inside the
  // archive; verifying the exec bit up front turns any future packaging
  // regression into a visible error instead of a silently broken CLI.
  try {
    await fs.access(source, fsConstants.X_OK);
  } catch {
    return {
      installed: false,
      path: null,
      installDir,
      installable: false,
      message: `Bundled aya CLI is not executable at ${source}`,
    };
  }
  const target = path.join(installDir, "aya");
  if (await foreignFileAt(target)) {
    return {
      ...(await cliStatus()),
      message: `${target} exists and was not installed by Aya - move it away, then click Reinstall.`,
    };
  }
  await fs.mkdir(installDir, { recursive: true });
  const script = freshCliShim();
  await writeCliShim(target, script);
  // Aya Dev writes a shim aimed at this checkout; spreading it to the user's
  // other copies would repoint their production `aya` (#120 review).
  const plan = IS_DEV
    ? { rewrite: [] as string[], remove: [] as string[] }
    : planCliInstall(await ayaCopiesOnPath(), target);
  const failed: string[] = [];
  for (const copy of plan.rewrite) {
    await writeCliShim(copy, script).catch(() => failed.push(copy));
  }
  for (const copy of plan.remove) {
    await fs.rm(copy, { force: true }).catch(() => failed.push(copy));
  }
  const status = await cliStatus();
  const installedMessage = `Installed at ${target}${offPathNote(choice)}`;
  return {
    ...status,
    message: failed.length
      ? `${installedMessage}. Could not update ${failed.join(", ")}.`
      : choice.onPath
        ? (status.message ?? installedMessage)
        : installedMessage,
  };
}

/** One Aya-owned rules file for every antigravity preset: present while any
 *  of them opts in, deleted once none does (or none is left). */
async function syncAntigravityBrief(): Promise<void> {
  const presets = (await listPresets()).filter((p) => p.agent === "antigravity");
  const file = antigravityBriefFile(os.homedir());
  const on = presets.some((p) => p.agentBrief === true);
  await rewriteIfChanged(file, (c) =>
    on ? withOwnedBrief(c, briefText(true)) : withoutOwnedBrief(c),
  ).catch((err) => console.warn(`[aya] could not sync the aya brief at ${file}:`, err));
}

/** Roles of panes that `team open` is about to open: they spawn before the role is saved. */
const pendingPaneRoles = new Map<string, RoleRef>();
const paneBriefDeps: PaneBriefDeps = {
  ayaHome: AYA_HOME,
  defaultCodexHome: DEFAULT_CODEX_HOME,
  expand: expandUserPath,
  shellEnv: loginShellEnv,
  listPresets: () => listPresets(),
  paneRole: async (spawn) => {
    const pending = pendingPaneRoles.get(spawn.ptyId);
    if (pending) return pending;
    const project = (await listProjects()).find((p) => p.slug === spawn.projectSlug);
    return project ? paneTeamRole(AYA_HOME, project, spawn.ptyId) : null;
  },
  records: fileLaunchRecords(PANE_LAUNCH_ROLES_FILE),
  starts: (spawn) => ptyHost.willStart(spawn),
  running: paneRunning,
};

/** Rewrites dead shims at startup for users who never reopen Settings (#115).
 *  Packaged only: in dev the fresh shim would aim at this checkout. */
async function healDeadCliShims(): Promise<void> {
  if (IS_DEV || !app.isPackaged) return;
  // An AppImage mounts under a fresh /tmp/.mount_* each launch: a "repaired"
  // shim would aim at a path that dies when the app quits.
  if (process.env.APPIMAGE) return;
  try {
    await fs.access(bundledAyaCliPath(__dirname), fsConstants.X_OK);
  } catch {
    return;
  }
  const script = freshCliShim();
  for (const copy of await ayaCopiesOnPath()) {
    if (!copy.broken) continue;
    try {
      await writeCliShim(copy.path, script);
      console.log(`[aya] repaired dead aya shim at ${copy.path}`);
    } catch (err) {
      console.warn(`[aya] could not repair dead aya shim at ${copy.path}:`, err);
    }
  }
}

/** The version of the host the client WOULD spawn, from package.json as the host reads it: app.getVersion()
 *  is Electron's own outside a packaged app, and that mismatch killed a current host on every dev/e2e boot. */
const EXPECTED_HOST_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"),
    ) as { version?: string };
    if (typeof pkg.version === "string") return pkg.version;
  } catch {
    // fall through to app.getVersion() - correct in packaged builds
  }
  return app.getVersion();
})();

async function diagnosticsReport(): Promise<DiagnosticsReport> {
  const [presets, projects, projectState, usageHook, cli, health, adoption] =
    await Promise.all([
      listPresets(),
      listProjects(),
      listProjectState(),
      usageHookStatus(),
      cliStatus(),
      hostHealth(),
      cliAdoption.summary(),
    ]);
  return {
    generatedAt: new Date().toISOString(),
    app: {
      version: app.getVersion(),
      mode: IS_DEV ? "development" : "production",
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      cwd: process.cwd(),
    },
    paths: {
      ayaHome: AYA_HOME,
      controlSocket: CONTROL_SOCKET_PATH,
      remoteSocket: REMOTE_SOCKET_PATH,
      ptyHostSocket: PTY_HOST_SOCKET_PATH,
      controlSocketExists: await pathExists(CONTROL_SOCKET_PATH),
      remoteSocketExists: await pathExists(REMOTE_SOCKET_PATH),
      ptyHostSocketExists: await pathExists(PTY_HOST_SOCKET_PATH),
    },
    shell: {
      shell: process.env.SHELL ?? null,
      pathEntries: pathEntries().slice(0, MAX_PATH_ENTRIES_RETURNED),
    },
    cli,
    cliAdoption: adoption,
    ptyHost: {
      expected: health.expected,
      actual: health.identity,
      ptyCount: health.ptyCount,
      stale: health.stale,
      pid: health.pid,
      socket: health.socket,
      otherHosts: health.otherHosts,
      warnings: health.warnings,
    },
    presets: presets.map((preset) => ({
      id: preset.id,
      name: preset.name,
      agent: preset.agent,
      command: preset.command,
      ...(preset.configDir ? { configDir: preset.configDir } : {}),
      ...(typeof preset.autoResume === "boolean"
        ? { autoResume: preset.autoResume }
        : {}),
      ...(typeof preset.unsafeMode === "boolean"
        ? { unsafeMode: preset.unsafeMode }
        : {}),
      ...(preset.agentBrief ? { agentBrief: true } : {}),
    })),
    projects: {
      total: projects.length,
      open: projectState.open.length,
      recent: projectState.recent.length,
      remote: projects.filter((project) => !!project.remote).length,
    },
    usage: {
      claudeAccounts: presets.filter((preset) => preset.agent === "claude").length,
      codexAccounts: presets.filter((preset) => preset.agent === "codex").length,
      hookInstalled: usageHook.installed,
      hookScriptPath: usageHook.scriptPath,
    },
  };
}

function updatesSupportedMessage(): string {
  if (IS_DEV || !app.isPackaged) return "Updates are disabled in development builds.";
  if (process.platform === "darwin") return "";
  if (process.platform === "linux") {
    return process.env.APPIMAGE
      ? ""
      : "Automatic install is only available for the AppImage build on Linux.";
  }
  return "Automatic updates are not supported on this platform.";
}

function updateStatusBase(): Pick<
  UpdateStatus,
  "supported" | "currentVersion" | "rollbackNotice"
> {
  return {
    supported: updatesSupportedMessage() === "",
    currentVersion: app.getVersion(),
    // Merged into every status write so it survives the 12 s auto-check.
    ...(rollbackNotice ? { rollbackNotice } : {}),
  };
}

function setUpdateStatus(
  next: Omit<UpdateStatus, "supported" | "currentVersion">,
  // Kept for call-site compat; updates are app-wide, so the status is
  // broadcast to every live window regardless of which one was passed.
  _win: BrowserWindow | null = null,
): UpdateStatus {
  updateStatus = {
    ...updateStatusBase(),
    ...next,
  };
  eachAyaWindow((win) => {
    win.webContents.send("updates:status", updateStatus);
  });
  return updateStatus;
}

function getUpdateStatus(): UpdateStatus {
  if (updatesSupportedMessage()) {
    return {
      ...updateStatusBase(),
      phase: "unsupported",
      message: updatesSupportedMessage(),
    };
  }
  return {
    ...updateStatus,
    ...updateStatusBase(),
  };
}

function updateVersion(info: unknown): string | undefined {
  return typeof info === "object" &&
    info !== null &&
    typeof (info as { version?: unknown }).version === "string"
    ? (info as { version: string }).version
    : undefined;
}

/** A requested update against the version we came back as (#78): a silent ShipIt rollback looks like success,
 *  so its state is cleaned, the update marked errored, and the user pointed at the releases page. */
async function reconcilePendingUpdate(win: BrowserWindow | null): Promise<void> {
  const pending = await readPendingUpdate();
  const diagnosis = diagnoseRelaunch(pending, app.getVersion());
  if (diagnosis === "none") return;
  await clearPendingUpdate();
  updateLatch.installing = false;
  if (diagnosis === "applied") {
    rollbackNotice = null; // an install landed; retire any earlier warning
    return; // it worked; stay quiet
  }
  // Rolled back: the install silently failed and we relaunched the old bundle.
  diagnosticsLog.append("update-rolled-back", {
    target: pending?.targetVersion,
    current: app.getVersion(),
    attempts: pending?.attempts,
  });
  // The notice is cheap and true either way; the recursive wipe can land under
  // a live install, so it waits for a repeat failure.
  if (shouldCleanShipItCache(pending)) await cleanShipItCache();
  rollbackNotice = `The update to ${pending?.targetVersion} didn't install - still on ${app.getVersion()}. Try the DMG from the releases page.`;
  setUpdateStatus({
    phase: "error",
    message: rollbackNotice,
  });
  const message = `Update to ${pending?.targetVersion} didn't apply`;
  const detail = `Aya is still on ${app.getVersion()}. The in-app update failed to install and rolled back to the current version. You can install the latest release manually.`;
  const opts: Electron.MessageBoxOptions = {
    type: "warning",
    buttons: ["Open releases page", "Later"],
    defaultId: 0,
    cancelId: 1,
    message,
    detail,
  };
  const choice =
    win && !win.isDestroyed()
      ? await dialog.showMessageBox(win, opts)
      : await dialog.showMessageBox(opts);
  if (choice.response === 0) await shell.openExternal(RELEASES_URL);
}

function configureAutoUpdates(win: BrowserWindow): void {
  if (updateEventsConfigured) return;
  updateEventsConfigured = true;
  updateStatus = getUpdateStatus();
  if (!updateStatus.supported) return;

  autoUpdater.autoDownload = true;
  // Never on a quit by itself: an ordinary quit checks the panes' background work first (before-quit).
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on("checking-for-update", () => {
    setUpdateStatus({ phase: "checking", message: "Checking for updates." }, win);
  });
  autoUpdater.on("update-available", (info) => {
    setUpdateStatus(
      {
        phase: "available",
        availableVersion: updateVersion(info),
        message: "Update found. Downloading in the background.",
        checkedAt: new Date().toISOString(),
      },
      win,
    );
  });
  autoUpdater.on("update-not-available", (info) => {
    setUpdateStatus(
      {
        phase: "not-available",
        availableVersion: updateVersion(info),
        message: "Aya is up to date.",
        checkedAt: new Date().toISOString(),
      },
      win,
    );
  });
  autoUpdater.on("download-progress", (progress) => {
    setUpdateStatus(
      {
        phase: "downloading",
        percent:
          typeof progress.percent === "number"
            ? Math.max(0, Math.min(100, progress.percent))
            : undefined,
        message: "Downloading update.",
      },
      win,
    );
  });
  autoUpdater.on("update-downloaded", (info) => {
    const downloadedVersion = updateVersion(info);
    setUpdateStatus(
      {
        phase: "downloaded",
        downloadedVersion,
        message: downloadedVersion
          ? `Aya ${downloadedVersion} is ready to install.`
          : "Update is ready to install.",
      },
      win,
    );
    if (Notification.isSupported()) {
      new Notification({
        title: "Aya update ready",
        body: "Restart Aya to install the update.",
      }).show();
    }
  });
  autoUpdater.on("error", (error) => {
    // quitAndInstall reports a failed handoff HERE rather than throwing, so this
    // is the only place an async install failure can release the latch. The
    // marker is deliberately kept: `error` also fires for unrelated checks, and
    // deleting it there would cost the whole #78 detector.
    updateLatch.installing = false;
    setUpdateStatus({
      phase: "error",
      message: error instanceof Error ? error.message : String(error),
      checkedAt: new Date().toISOString(),
    });
  });
}

async function checkForUpdates(): Promise<UpdateStatus> {
  if (updatesSupportedMessage()) return getUpdateStatus();
  if (updateCheckInFlight) return updateCheckInFlight;
  updateCheckInFlight = (async () => {
    try {
      setUpdateStatus({ phase: "checking", message: "Checking for updates." });
      await autoUpdater.checkForUpdates();
      return getUpdateStatus();
    } catch (err) {
      return setUpdateStatus({
        phase: "error",
        message: err instanceof Error ? err.message : String(err),
        checkedAt: new Date().toISOString(),
      });
    } finally {
      updateCheckInFlight = null;
    }
  })();
  return updateCheckInFlight;
}

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

function devAboutIconPath(): string {
  return devIconPath();
}

async function openExternalUrl(raw: string): Promise<void> {
  const parsed = parseExternalUrl(raw);
  if (!parsed) throw new Error("Unsupported external URL.");
  if (parsed.protocol === "file:") {
    const error = await shell.openPath(fileURLToPath(parsed));
    if (error) throw new Error(error);
    return;
  }
  await shell.openExternal(parsed.toString());
}

/** The first positional argv value that is an existing directory (`aya /path/to/project`); in dev argv
 *  includes Electron's own args. */
function findDirInArgv(argv: readonly string[]): string | null {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a || a.startsWith("-")) continue;
    // Skip arguments that obviously aren't user-supplied paths.
    if (a.endsWith("main.js") || a.includes("node_modules/electron")) continue;
    if (a === ".") {
      // Relative-to-cwd. We get a sensible cwd from `second-instance`'s
      // workingDirectory arg; the initial argv case handles "." via
      // process.cwd().
      try {
        return path.resolve(process.cwd());
      } catch {
        continue;
      }
    }
    try {
      const resolved = path.resolve(a);
      if (statSync(resolved).isDirectory()) return resolved;
    } catch {
      // Not a real directory - keep searching.
      continue;
    }
  }
  return null;
}

/** An "open this project" request (another process, or our own argv) for the renderer, which switches to,
 *  creates, or ignores the project. */
function dispatchOpenProject(
  win: BrowserWindow | null,
  dir: string | null,
): Promise<void> {
  if (!win || !dir) return Promise.resolve();
  return deliverOpenProject(win, dir);
}

function logOpenFailure(dir: string | null): (err: unknown) => void {
  return (err) => console.warn(`[aya] could not open ${dir}:`, err);
}

function dispatchShortcut(action: string): void {
  const target = focusedAyaWindow();
  if (!target || target.isDestroyed()) return;
  target.webContents.send("shortcut", action);
}

function showAyaAboutPanel(): void {
  if (!IS_DEV && process.platform === "darwin") {
    app.showAboutPanel();
    return;
  }
  const parent = focusedAyaWindow() ?? undefined;
  const about = new BrowserWindow({
    width: ABOUT_DIALOG_SIZE,
    height: ABOUT_DIALOG_SIZE,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    parent,
    modal: !!parent,
    title: `About ${WINDOW_TITLE}`,
    backgroundColor: COLOR_DARK_BG,
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  about.setMenu(null);
  let iconUrl = "";
  try {
    const png = readFileSync(devAboutIconPath());
    iconUrl = `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    // Empty src keeps the dialog usable even if the icon asset is missing.
  }
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      * { box-sizing: border-box; }
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
        color: ${COLOR_LIGHT_TEXT};
        background: ${COLOR_DARK_BG};
      }
      body {
        display: flex;
        align-items: center;
        justify-content: center;
      }
      main {
        width: 100%;
        padding: 28px 28px 24px;
        text-align: center;
      }
      img {
        display: block;
        width: ${ABOUT_ICON_SIZE}px;
        height: ${ABOUT_ICON_SIZE}px;
        margin: 0 auto 18px;
      }
      h1 {
        margin: 0;
        font-size: 22px;
        font-weight: 650;
        letter-spacing: 0;
      }
      p {
        margin: 7px 0 0;
        font-size: 13px;
        color: #8b949e;
      }
      button {
        margin-top: 24px;
        min-width: 78px;
        height: 30px;
        border: 1px solid #30363d;
        border-radius: 6px;
        color: ${COLOR_LIGHT_TEXT};
        background: #161b22;
        font: inherit;
        font-size: 13px;
      }
      button:hover { background: #21262d; }
    </style>
  </head>
  <body>
    <main>
      <img src="${iconUrl}" alt="">
      <h1>${WINDOW_TITLE}</h1>
      <p>Version ${app.getVersion()}</p>
      <button autofocus onclick="window.close()">OK</button>
    </main>
  </body>
</html>`;
  about.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  about.once("ready-to-show", () => about.show());
}

// Set to true when a stale PTY host is detected on launch (#28). The Restart
// Aya menu item reads this flag so it can kill the stale host before relaunching.
let staleHostDetected = false;
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
// The install an ordinary quit started holds the quit this long at most before it quits without it.
const QUIT_INSTALL_SETTLE_MS = 15_000;

// --- Aya Web (experimental): browser access over HTTP + WebSocket ---
let webConfig: WebConfig | null = null;
let webServer: WebServerHandle | null = null;
// Last start failure (e.g. port already in use) - surfaced in Settings.
let webServerError: string | null = null;
// Every load, change and (re)start of Aya Web runs one after another. Settings exists in each window and in Aya
// Web itself; two changes at once read the same config, and the later save dropped the other change, or a disable
// that ran while an enable was still starting found no server to stop and the server came up anyway.
let webQueue: Promise<unknown> = Promise.resolve();
function inWebQueue<T>(change: () => Promise<T>): Promise<T> {
  const run = webQueue.then(change);
  webQueue = run.catch(() => undefined);
  return run;
}
// Virtual PTY-event sink: fans "pty:event" out to the web clients exactly
// like a window's webContents. Registered while the server runs.
const webPtySink = {
  isDestroyed: () => false,
  send: (channel: "pty:event", event: unknown) => {
    webServer?.broadcast(channel, event);
  },
};

/** (Re)apply the current web config: stop the running server, then start a
 *  fresh one when enabled. Start failures are recorded, never thrown. */
async function applyWebServerState(): Promise<void> {
  if (webServer) {
    ptyHost.detachWebContents(webPtySink);
    const closing = webServer;
    webServer = null;
    await closing.close();
  }
  webServerError = null;
  const config = webConfig;
  if (!config || !config.enabled) return;
  try {
    webServer = await startWebServer({
      appVersion: app.getVersion(),
      isDev: IS_DEV,
      distDir: RENDERER_DIST_DIR,
      getConfig: () => webConfig ?? config,
    });
    ptyHost.attachWebContents(webPtySink);
  } catch (err) {
    webServerError = err instanceof Error ? err.message : String(err);
  }
}

function webStatus(): WebServerStatus {
  const config = webConfig;
  if (!config) {
    return {
      enabled: false,
      running: false,
      port: 0,
      host: "",
      user: "",
      generatedPassword: null,
      urls: [],
      addresses: [],
      clients: 0,
      error: webServerError,
    };
  }
  const interfaces = os.networkInterfaces();
  return {
    enabled: config.enabled,
    running: webServer !== null,
    port: config.port,
    host: config.host,
    user: config.user,
    generatedPassword: config.generatedPassword ?? null,
    urls: webServerUrls(config, interfaces),
    addresses: webInterfaceAddresses(interfaces),
    clients: webServer?.clientCount() ?? 0,
    error: webServerError,
  };
}

/** Build a minimal RGBA PNG containing a filled circle.
 *  Uses only Node built-ins (zlib deflate + manual PNG framing). */
function makeCirclePng(size: number, r: number, g: number, b: number): Buffer {
  const cx = size / 2;
  const cy = size / 2;
  const r2 = (size / 2 - 1) ** 2; // squared radius (1px inset so circle doesn't clip)
  const rows: number[] = [];
  for (let y = 0; y < size; y++) {
    rows.push(0); // PNG filter byte: None
    for (let x = 0; x < size; x++) {
      const inside = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r2;
      rows.push(r, g, b, inside ? 255 : 0);
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const t = Buffer.from(type, "ascii");
    let c = 0xffffffff;
    for (const byte of Buffer.concat([t, data])) {
      c ^= byte;
      for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // color type: RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.from(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function installApplicationMenu(): void {
  configureAppIdentity();
  const restartItem: MenuItemConstructorOptions = {
    id: "restart-aya",
    label: `Restart ${WINDOW_TITLE}`,
    click: async () => {
      // Only a stale host is restarted with Aya; a current one keeps its panes running.
      if (staleHostDetected && !(await confirmLosingWork(`Restarting ${WINDOW_TITLE}`, "Restart").catch(() => true))) return;
      try {
        if (staleHostDetected) await ptyHost.restart();
      } catch {
        // best-effort; stale host may already be gone
      }
      app.relaunch();
      app.quit();
    },
  };
  const appMenu: MenuItemConstructorOptions = {
    label: WINDOW_TITLE,
    submenu: [
      {
        label: `About ${WINDOW_TITLE}`,
        click: showAyaAboutPanel,
      },
      { type: "separator" },
      {
        label: "Settings...",
        accelerator: "CmdOrCtrl+,",
        click: () => dispatchShortcut("open-settings"),
      },
      restartItem,
      { type: "separator" },
      { role: "services" },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { role: "quit" },
    ],
  };

  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [appMenu] : []),
    {
      label: "File",
      submenu: [
        {
          label: "New Shell",
          accelerator: "CmdOrCtrl+T",
          click: () => dispatchShortcut("new-shell"),
        },
        {
          label: "New Window",
          accelerator: "CmdOrCtrl+Shift+N",
          click: () => void openNewWindow(),
        },
        {
          label: "Close Terminal",
          accelerator: "CmdOrCtrl+W",
          click: () => dispatchShortcut("close-tab"),
        },
        ...(process.platform === "darwin"
          ? []
          : [
              { type: "separator" as const },
              restartItem,
            ]),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Search",
          accelerator: "CmdOrCtrl+K",
          click: () => dispatchShortcut("search"),
        },
        {
          label: "Find in Terminal",
          accelerator: "CmdOrCtrl+F",
          click: () => dispatchShortcut("find-in-pane"),
        },
        { type: "separator" },
        {
          label: "Previous Terminal",
          accelerator: "CmdOrCtrl+[",
          click: () => dispatchShortcut("prev-tab"),
        },
        {
          label: "Next Terminal",
          accelerator: "CmdOrCtrl+]",
          click: () => dispatchShortcut("next-tab"),
        },
        { type: "separator" },
        {
          label: "Focus Pane Left",
          accelerator: "CmdOrCtrl+Alt+Left",
          click: () => dispatchShortcut("focus-pane-left"),
        },
        {
          label: "Focus Pane Right",
          accelerator: "CmdOrCtrl+Alt+Right",
          click: () => dispatchShortcut("focus-pane-right"),
        },
        {
          label: "Focus Pane Up",
          accelerator: "CmdOrCtrl+Alt+Up",
          click: () => dispatchShortcut("focus-pane-up"),
        },
        {
          label: "Focus Pane Down",
          accelerator: "CmdOrCtrl+Alt+Down",
          click: () => dispatchShortcut("focus-pane-down"),
        },
        {
          label: "Split Pane Right",
          accelerator: "CmdOrCtrl+Alt+\\",
          click: () => dispatchShortcut("split-pane-right"),
        },
        {
          label: "Split Pane Below",
          accelerator: "CmdOrCtrl+Alt+-",
          click: () => dispatchShortcut("split-pane-below"),
        },
        { type: "separator" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        {
          label: "Toggle Full Screen",
          accelerator:
            process.platform === "darwin" ? "Ctrl+Command+F" : "F11",
          click: () => toggleAyaFullScreen(focusedAyaWindow()),
        },
      ],
    },
    {
      label: "Project",
      submenu: Array.from({ length: MAX_KEYBOARD_PROJECTS }, (_, i) => ({
        label: `Select Project ${i + 1}`,
        accelerator: `CmdOrCtrl+${i + 1}`,
        click: () => dispatchShortcut(`project-${i + 1}`),
      })),
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(process.platform === "darwin"
          ? [
              { type: "separator" as const },
              { role: "front" as const },
              { type: "separator" as const },
              { role: "window" as const },
            ]
          : [{ role: "close" as const }]),
      ],
    },
  ];

  if (process.platform !== "darwin") {
    template.push({
      label: "Help",
      submenu: [
        {
          label: `About ${WINDOW_TITLE}`,
          click: showAyaAboutPanel,
        },
      ],
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

interface WindowGeometry {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isFullScreen: boolean;
  isMaximized: boolean;
}

/** An extra, empty window cascaded from the focused one, or under the cursor for a tab tear-out; it owns no
 *  projects until one is opened or moved into it (see projectStateForWindow). */
async function openNewWindow(at?: {
  x: number;
  y: number;
}): Promise<BrowserWindow> {
  const anchor = focusedAyaWindow();
  const size = anchor
    ? anchor.getBounds()
    : { ...(await loadWindowState()), x: undefined, y: undefined };
  const position = at
    ? // Nudge so the cursor lands on the new window's tab strip, not its corner.
      { x: Math.max(0, at.x - TEAR_OUT_CURSOR_OFFSET_X_PX), y: Math.max(0, at.y - TEAR_OUT_CURSOR_OFFSET_Y_PX) }
    : anchor
      ? {
          x: anchor.getBounds().x + NEW_WINDOW_CASCADE_OFFSET_PX,
          y: anchor.getBounds().y + NEW_WINDOW_CASCADE_OFFSET_PX,
        }
      : { x: size.x, y: size.y };
  return createWindow({
    x: position.x,
    y: position.y,
    width: size.width,
    height: size.height,
    isFullScreen: false,
    isMaximized: false,
  });
}

function createWindow(initial: WindowGeometry): BrowserWindow {
  const win = new BrowserWindow({
    x: initial.x,
    y: initial.y,
    width: initial.width,
    height: initial.height,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    title: WINDOW_TITLE,
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hidden" as const }
      : {}),
    ...(process.platform === "linux"
      ? { frame: false, roundedCorners: false }
      : {}),
    backgroundColor: COLOR_DARK_BG,
    show: false,
    webPreferences: {
      // One file from vite.preload.config.mts: a sandboxed preload cannot require its own modules.
      preload: path.join(__dirname, "preload.bundle.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // node-pty runs only in the pty-host, so the window needs no Node: a script injected into it
      // gets Chromium's sandbox, not the user's rights.
      sandbox: true,
      // In headless e2e the window is never shown, so Chromium would throttle
      // requestAnimationFrame and xterm's render loop would never paint - the
      // tests that read rendered rows then time out. Keep the hidden test
      // window fully active. Production keeps the default (throttle when
      // backgrounded to save power).
      ...(IS_E2E_HEADLESS ? { backgroundThrottling: false } : {}),
    },
  });

  if (process.platform === "darwin") {
    win.setWindowButtonVisibility(false);
    applyMacOsWindowHack(win);
  }

  if (initial.isMaximized) win.maximize();
  if (initial.isFullScreen) setAyaFullScreen(win, true);

  // Persist geometry changes; the helper handles debouncing + final flush.
  // Only the boot window drives the saved single-window geometry; secondary
  // windows are session-only (a restart collapses back to one window).
  if (ayaWindows.size === 0) trackWindowState(win);

  // Multi-window registry: PTY events broadcast to every live window, and
  // `mainWindow` follows focus so outside actions have a target.
  ayaWindows.add(win);
  mainWindow = win;
  if (bootWindowId === null) bootWindowId = win.id;
  const windowId = win.id;
  // Captured now: the webContents getter throws after 'closed'.
  const windowWebContents = win.webContents;
  win.on("focus", () => {
    mainWindow = win;
  });
  ptyHost.attachWebContents(windowWebContents);

  // Watch ~/.aya/ for edits to snippets/presets/themes made outside the app
  // and reload that slice in the renderer. Stopped when the window closes.
  const stopConfigWatcher = startConfigWatcher(win);

  win.once("ready-to-show", () => {
    if (!IS_E2E_HEADLESS) win.show();
  });
  win.on("closed", () => {
    // De-register FIRST: if any cleanup below ever throws, a dead window must
    // not linger in the registry (it would show up as a phantom "Move to
    // window…" target).
    ayaWindows.delete(win);
    // Keep the module-level ref in sync so second-instance handlers don't
    // try to focus a destroyed window.
    if (mainWindow === win) {
      mainWindow = [...ayaWindows].at(-1) ?? null;
    }
    ptyHost.detachWebContents(windowWebContents);
    stopConfigWatcher();
    // The closed window's projects fall back to recent; PTYs keep running in
    // the detached host (same contract as an app restart).
    void releaseWindowSlices(windowId);
  });

  // Notify the renderer when fullscreen state changes so the topbar can drop
  // its left padding (which is there to clear the traffic-light buttons -
  // those buttons hide in fullscreen).
  const sendFullScreen = (isFs: boolean) => {
    if (!win.isDestroyed()) win.webContents.send("app:fullscreen", isFs);
  };
  const sendMaximized = (isMaximized: boolean) => {
    if (!win.isDestroyed()) win.webContents.send("app:maximized", isMaximized);
  };
  win.on("enter-full-screen", () => {
    sendFullScreen(true);
    applyMacOsWindowHack(win);
    setTimeout(() => applyMacOsWindowHack(win), MACOS_FULLSCREEN_HACK_DELAY_MS);
  });
  win.on("leave-full-screen", () => {
    sendFullScreen(false);
    applyMacOsWindowHack(win);
  });
  win.on("maximize", () => sendMaximized(true));
  win.on("unmaximize", () => sendMaximized(false));
  // Initial broadcast once the renderer is ready (also useful if a future
  // restart preserves fullscreen state).
  replayOpensOnLoad(win);
  win.webContents.once("did-finish-load", () => {
    sendFullScreen(isAyaFullScreen(win));
    sendMaximized(win.isMaximized());
    applyMacOsWindowHack(win);
  });

  // External links must never navigate Aya's BrowserWindow. xterm's web-links
  // addon normally calls our IPC handler, but Chromium/Electron can still see
  // window.open or direct navigation paths depending on timing and modifier
  // keys. Catch both centrally and hand safe external URLs to the OS.
  const handleExternalNavigation = (
    event: { preventDefault(): void },
    url: string,
  ) => {
    if (
      isInternalNavigationUrl(url, {
        isDev: IS_DEV,
        devServerUrl: DEV_SERVER_URL,
        appIndexPath: RENDERER_INDEX_PATH,
      })
    ) {
      return;
    }
    event.preventDefault();
    if (parseExternalUrl(url)) void openExternalUrl(url);
  };

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (parseExternalUrl(url)) void openExternalUrl(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    handleExternalNavigation(event, url);
  });
  (
    win.webContents as typeof win.webContents & {
      on(
        channel: "will-frame-navigate",
        listener: (
          event: { preventDefault(): void },
          details: { url: string },
        ) => void,
      ): void;
    }
  ).on(
    "will-frame-navigate",
    (event: { preventDefault(): void }, details: { url: string }) => {
      handleExternalNavigation(event, details.url);
    },
  );

  // Intercept keyboard shortcuts at the BrowserWindow level so they fire
  // even while xterm.js has focus (otherwise xterm would forward them to the
  // PTY). Calling event.preventDefault() prevents both the page and the
  // default menu from receiving the keystroke.
  installWindowZoom(win.webContents);
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const isMac = process.platform === "darwin";
    const mod = isMac ? input.meta : input.control;
    if (!mod) return;
    if (input.alt && !input.shift) {
      let action: string | null = null;
      if (input.key === "ArrowLeft") action = "focus-pane-left";
      else if (input.key === "ArrowRight") action = "focus-pane-right";
      else if (input.key === "ArrowUp") action = "focus-pane-up";
      else if (input.key === "ArrowDown") action = "focus-pane-down";
      else if (input.key === "\\" || input.code === "Backslash") {
        action = "split-pane-right";
      } else if (input.key === "-") {
        action = "split-pane-below";
      }
      if (!action) return;
      event.preventDefault();
      if (!win.isDestroyed()) win.webContents.send("shortcut", action);
      return;
    }
    // Don't trigger our shortcuts if extra modifiers we don't bind are held -
    // e.g. Cmd+Shift+T should NOT fire our Cmd+T action.
    if (input.shift || input.alt) return;
    const key = input.key.toLowerCase();
    if (key === "r") {
      event.preventDefault();
      return;
    }
    let action: string | null = null;
    if (key === "t") action = "new-shell";
    else if (key === "w") action = "close-tab";
    else if (key === ",") action = "open-settings";
    else if (key === "[") action = "prev-tab";
    else if (key === "]") action = "next-tab";
    else if (key === "f") action = "find-in-pane";
    else if (key === "k") action = "search";
    else if (key.length === 1 && key >= "1" && key <= String(MAX_KEYBOARD_PROJECTS)) {
      action = `project-${key}`;
    }
    if (!action) return;
    event.preventDefault();
    if (!win.isDestroyed()) win.webContents.send("shortcut", action);
  });

  if (IS_DEV) {
    win.loadURL(DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(RENDERER_INDEX_PATH);
  }

  return win;
}

/** On launch, reap a stale PTY host (#28) even with live terminals, asking first when a pane shows background work
 *  (a no keeps it, with Restart Aya's red dot). Best-effort; a pre-#73 host may orphan a signal-ignoring child once. */
async function handleStaleHost(): Promise<void> {
  try {
    let health = await hostHealth();
    // A running host this Aya cannot reach (no socket, or another host on it): its terminals show nowhere, and the
    // first pane would start another host and resume every agent a second time. Asked, like any stop of work.
    if (health.otherHosts.length > 0 && (await askStopOtherHosts(health.otherHosts.length, "Aya found"))) {
      await stopHosts(health.otherHosts.map((host) => host.pid));
      health = await hostHealth();
    }
    if (health.identity === null && health.stale) {
      // identity null is ALSO returned for transient client-side failures (e.g.
      // a >5s cold-spawn socket wait). Acting on it immediately would shut down
      // the freshly-spawned, current-version host. Re-probe once after a short
      // delay: a genuinely ancient host fails the version request consistently,
      // while a slow spawn answers with a matching identity the second time.
      await new Promise((resolve) => setTimeout(resolve, STALE_HOST_REPROBE_DELAY_MS));
      health = await hostHealth();
    }
    if (!health.stale) return;
    // The update is in, but the panes' background work still runs on the old host: ask, unless Restart to update did.
    let exited = true;
    if (
      !(await restartStaleHost(relaunchDeps, (text) => askRestart("Restart terminals", text), async () => {
        exited = await ptyHost.restart();
      }))
    ) {
      showStaleHost(true);
      return;
    }
    // restart() swallows request errors by design (an old host may not honor
    // "shutdown"), so returning is NOT proof the host died. Verify: re-probe the
    // socket; a fresh current-version host (or none yet) means success, the SAME
    // stale identity answering again means the reap failed.
    // hostHealth() keeps the red dot on when the reap didn't take, and an old host still running past the wait keeps
    // it too, so the user can retry. The menu may not be installed yet (this runs before createWindow), so the
    // caller applies the icon from the flag after installApplicationMenu.
    await hostHealth();
    if (!exited) showStaleHost(true);
  } catch {
    // best-effort; a host that can't be queried is handled on next use
  }
}

/** Restart to update (asks before stopping background work) and an ordinary quit's update (installs only past no
 *  background work, else leaves it for Restart to update). Markers are written for diagnoseRelaunch (#78). */
const updates = updateInstaller({
  status: getUpdateStatus,
  relaunch: relaunchDeps,
  ask: (text) => askRestart("Restart to update", text),
  latch: updateLatch,
  mark: markPendingUpdate,
  markSync: markPendingUpdateSync,
  clearMark: clearPendingUpdate,
  // Lazy: electron-updater builds its platform updater on first touch, which must not happen at module load.
  updater: {
    get autoRunAppAfterInstall() { return autoUpdater.autoRunAppAfterInstall; },
    set autoRunAppAfterInstall(value: boolean) { autoUpdater.autoRunAppAfterInstall = value; },
    quitAndInstall: (isSilent, isForceRunAfter) => autoUpdater.quitAndInstall(isSilent, isForceRunAfter),
  },
  quit: () => app.quit(),
  failed: (message) => setUpdateStatus({ phase: "error", message }),
  settleMs: QUIT_INSTALL_SETTLE_MS,
});

/** The terminal host's state, the one account behind Aya's launch check, the Restart Aya red dot and Diagnostics. */
async function hostHealth(): Promise<HostHealth> {
  const health = await gatherHostHealth({
    expected: ptyHost.expectedHostIdentity(EXPECTED_HOST_VERSION),
    connected: () => ptyHost.isConnected(),
    status: () => ptyHost.hostStatus(),
    socketExists: () => pathExists(PTY_HOST_SOCKET_PATH),
    probeSocket: () => probeSocketPid(PTY_HOST_SOCKET_PATH),
    liveRecords: () => liveHostRecords(PTY_HOST_SCRIPT),
  });
  showStaleHost(health.stale);
  return health;
}

/** Asks before ending the terminals of hosts this Aya does not use. */
async function askStopOtherHosts(count: number, who: string): Promise<boolean> {
  const hosts = count === 1 ? "another terminal host" : `${count} other terminal hosts`;
  const options = {
    type: "warning" as const,
    buttons: ["Stop", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: count === 1 ? "Stop the other terminal host?" : `Stop ${count} other terminal hosts?`,
    detail: `${who} ${hosts} still running from before. Their terminals show in no window, and Aya would resume those agents again in its own host. Stopping ends them.`,
  };
  const parent = focusedAyaWindow();
  return (await (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options))).response === 0;
}

/** SIGTERM, so each host's own shutdown ends its terminals and removes its registry record; answers once they are
 *  gone, so a refreshed report no longer lists them. */
async function stopHosts(pids: number[]): Promise<number[]> {
  // Checked again right before the signal: a host may have exited, and its pid passed on, while Aya asked.
  const stillHosts = new Set(liveHostRecords(PTY_HOST_SCRIPT).map((rec) => rec.pid));
  const stopped: number[] = [];
  for (const pid of pids.filter((p) => stillHosts.has(p))) {
    try {
      process.kill(pid, "SIGTERM");
      stopped.push(pid);
    } catch {
      // already gone
    }
  }
  await Promise.all(stopped.map((pid) => waitForExit(pid, PTY_HOST_EXIT_WAIT_MS)));
  return stopped;
}

/** The red dot on Restart Aya follows the host's state: on while it is stale, off once it is not. */
function showStaleHost(stale: boolean): void {
  staleHostDetected = stale;
  if (stale) {
    setStaleMenuIcon();
    return;
  }
  const item = Menu.getApplicationMenu()?.getMenuItemById("restart-aya");
  if (item) item.icon = nativeImage.createEmpty();
}

/** Red dot on the "Restart Aya" menu item - the manual reap affordance (#52).
 *  No-op until the application menu is installed. */
function setStaleMenuIcon(): void {
  const item = Menu.getApplicationMenu()?.getMenuItemById("restart-aya");
  if (item) {
    // 16x16 px red dot at scaleFactor 2 = 8pt logical - renders as a
    // small colored circle to the left of the label (standard macOS pattern).
    item.icon = nativeImage.createFromBuffer(
      makeCirclePng(STALE_MENU_DOT_PX, 255, 59, 48), // red (macOS systemRed #ff3b30)
      { scaleFactor: STALE_MENU_DOT_SCALE_FACTOR },
    );
  }
}

function registerIpc(): TeamRunner {
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
  });
  ipcMain.handle("teams:panes-opened", (_e, requestId: unknown, error: unknown) =>
    paneOpens.answer(requireString(requestId, "teams:panes-opened.requestId"), error),
  );
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
  ipcMain.handle("pty:spawn", (_e, req: unknown) => {
    const validated = validateSpawnRequest(req);
    return spawnGate.spawn(validated.ptyId, () => prepareSpawn(validated), sendSpawn).then(async (sent) => {
      // Closed while preparing: the brief files it wrote after the close are no one's.
      if (sent === undefined && !spawnGate.spawning(validated.ptyId)) await removePaneBrief(AYA_HOME, validated.ptyId).catch(() => {});
    });
  });
  // One write per pane at a time: the Enter that answers a waiting agent asks the host about the screen first, and
  // the keys typed right after it must not overtake it.
  const paneWrites = oneAtATime();
  ipcMain.handle("pty:write", (_e, ptyId: unknown, data: unknown) => {
    const id = requireString(ptyId, "pty:write.ptyId");
    const text = requireString(data, "pty:write.data");
    return paneWrites(id, async () => {
      await spawnGate.afterSpawn(id);
      // The user's Enter answers a pane that asked for them (aya status waiting): the windows drop the status.
      const answered = await noteUserAnswer(id, text, () => ptyHost.holdReason(id));
      if (answered) broadcastStatus(answered);
      return ptyHost.write(id, text);
    });
  });
  ipcMain.handle(
    "pty:resize",
    async (_e, ptyId: unknown, cols: unknown, rows: unknown) =>
      ptyHost.resize(
        requireString(ptyId, "pty:resize.ptyId"),
        requirePositiveInt(cols, "pty:resize.cols"),
        requirePositiveInt(rows, "pty:resize.rows"),
      ),
  );
  ipcMain.handle("pty:confirm-restart", async (_e, ptyId: unknown) => {
    const id = requireString(ptyId, "pty:confirm-restart.ptyId");
    const name = (await relaunchDeps.panes([id]))[0]?.name ?? "this pane";
    return confirmLosingWork(`Restarting ${name}`, "Restart", [id]);
  });
  ipcMain.handle("pty:kill", async (_e, ptyId: unknown) => {
    const id = requireString(ptyId, "pty:kill.ptyId");
    await removePaneBrief(AYA_HOME, id).catch(() => {});
    return closePane(spawnGate, id, { hasPane: paneRunning, kill: (ptyId) => ptyHost.kill(ptyId) });
  });
  ipcMain.handle("pty:buffer", async (_e, ptyId: unknown) => {
    try {
      return await ptyHost.getBuffer(requireString(ptyId, "pty:buffer.ptyId"));
    } catch (err) {
      if (
        err instanceof Error &&
        [PTY_HOST_UNKNOWN_REQUEST, PTY_HOST_NOT_CONNECTED].some((m) => err.message.includes(m))
      ) {
        return "";
      }
      throw err;
    }
  });
  // Live cwd of a terminal's process (null when unavailable) - the client
  // already turns an old host's "unknown request" into null.
  ipcMain.handle("pty:cwd", async (_e, ptyId: unknown) =>
    ptyHost.getCwd(requireString(ptyId, "pty:cwd.ptyId")),
  );
  ipcMain.handle("pty:search", async (_e, query: unknown) =>
    ptyHost.search(requireString(query, "pty:search.query")),
  );
  ipcMain.handle("harness:search", async (_e, req: unknown) => {
    if (typeof req !== "object" || req === null) {
      throw new Error("harness:search: request must be an object");
    }
    const r = req as Record<string, unknown>;
    const agent = requireString(r.agent, "harness:search.agent");
    if (agent !== "claude" && agent !== "codex") {
      throw new Error("harness:search.agent must be 'claude' or 'codex'");
    }
    return searchHarnessSessions({
      agent,
      cwd: requireString(r.cwd, "harness:search.cwd"),
      configDir:
        r.configDir === undefined
          ? undefined
          : requireString(r.configDir, "harness:search.configDir"),
      command: r.command === undefined ? undefined : requireString(r.command, "harness:search.command"),
      query: requireString(r.query, "harness:search.query"),
    });
  });
  ipcMain.handle("pty-host:restart", async () => {
    // Thrown, not returned: the window then leaves the panes as they are.
    if (!(await confirmLosingWork("Restarting the PTY host", "Restart"))) throw new Error("restart cancelled");
    const exited = await ptyHost.restart();
    // The red dot follows what the host now is: off for a current host, still on if the restart did not take.
    await hostHealth();
    if (!exited) {
      showStaleHost(true);
      // Thrown, so the window does not mark its panes stopped while their processes may still run.
      throw new Error(
        `The old terminal host did not exit within ${PTY_HOST_EXIT_WAIT_MS / 1000} s; its terminals may still run. Settings > Diagnostics lists it, with Stop other hosts.`,
      );
    }
  });
  // Hosts Aya does not use and that are not on the socket, re-verified now: their terminals show in no window.
  // Asked here, not in the window: Aya Web reaches this handler too.
  ipcMain.handle("pty-host:stop-others", async () => {
    const health = await hostHealth();
    if (health.otherHosts.length === 0) return [];
    if (!(await askStopOtherHosts(health.otherHosts.length, "Settings found"))) return [];
    return stopHosts(health.otherHosts.map((host) => host.pid));
  });

  registerProjectsIpc({
    ipcMain,
    senderWindow,
    stateForWindow: projectStateForWindow,
    mergeSave: (state, windowId, disk) => windowSlices.mergeSave(state, windowId, disk),
  });
  registerRemoteIpc({ ipcMain, ayaHome: AYA_HOME });
  ipcMain.handle("agent:waiting", () => outstandingWaiting());
  // A question from before the restart that the pane's session no longer confirms: the windows mark it.
  onStatusPushed(broadcastStatus);
  registerUsageIpc(ipcMain);
  registerSettingsIpc({
    ipcMain,
    senderWindow,
    dialog,
    home: () => app.getPath("home"),
    presetsSaved: syncAntigravityBrief,
    intelligence: {
      summarize: (req) => summarizeLocal(validateLocalSummaryRequest(req)),
      ollamaStatus: (model) => ollamaStatus(model),
      pullOllamaModel: (model) => pullOllamaModel(validateOllamaModelName(model)),
    },
  });

  registerWindowIpc({
    ipcMain,
    senderWindow,
    windows: () => ayaWindows,
    activeProjectOf: (id) => windowSlices.activeProjectOf(id),
    openNewWindow,
    openProjectIn: (win, dir) => void dispatchOpenProject(win, dir).catch(logOpenFailure(dir)),
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
    openExternalUrl,
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
    diagnosticsReport,
    updateStatus: getUpdateStatus,
    checkForUpdates,
    installUpdate: () => updates.install(),
  });

  // --- Aya Web (experimental) ---
  registerAyaWebIpc({
    ipcMain,
    inQueue: inWebQueue,
    config: async () => (webConfig ??= await loadWebConfig()),
    save: async (next) => {
      await saveWebConfig(next);
      webConfig = next;
    },
    apply: applyWebServerState,
    status: webStatus,
  });
  return teamRunner;
}

// Multi-window: every live Aya window, in creation order. `mainWindow` tracks
// the last-focused live window so second-instance / app:open-file / menu
// actions have a sensible target when no Aya window has OS focus.
const ayaWindows = new Set<BrowserWindow>();
let mainWindow: BrowserWindow | null = null;

/** The window an outside action (menu, CLI open, notification) should hit:
 *  the OS-focused Aya window, else the last-focused live one. */
function focusedAyaWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && ayaWindows.has(focused)) return focused;
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

/** macOS keeps running with every window closed; outside opens and `activate`
 *  share this, so however they interleave only one window is created. */
const { createOnce: createWindowOnce, forOpen: windowForOpen } = createWindowSource(focusedAyaWindow, async () => {
  mainWindow = createWindow(await loadWindowState());
  return mainWindow;
}, () => appQuitting);

/** Set once startup has created its own first window. */
let startupWindowCreated = false;

/** second-instance / open-file: focus the open's window and deliver `dir`; with every window closed a new one is
 *  made, except before startup made its first (that would make two). */
async function openFromOutside(dir: string | null): Promise<void> {
  const target = startupWindowCreated ? await windowForOpen() : focusedAyaWindow();
  if (target) {
    if (target.isMinimized()) target.restore();
    target.focus();
  }
  await dispatchOpenProject(target, dir);
}

/** Every window, and Aya Web's clients through a window-like sink (harness status dots must work in the browser too). */
function statusSinks(): ControlStatusSink[] {
  const web = { isDestroyed: () => false, webContents: { send: (channel: "control:status", update: unknown) => void webServer?.broadcast(channel, update) } };
  return [...[...ayaWindows].filter((w) => !w.isDestroyed()), web];
}

function broadcastStatus(update: ControlStatusUpdate): void {
  for (const sink of statusSinks()) sink.webContents.send("control:status", update);
}

function eachAyaWindow(fn: (win: BrowserWindow) => void): void {
  for (const win of ayaWindows) {
    if (!win.isDestroyed()) fn(win);
  }
}

// Per-window project slices (multi-window, session-only) - semantics live in
// window-slices.ts; main only wires window ids and the disk write.
const windowSlices = new WindowProjectSlices();
let bootWindowId: number | null = null;
/** The boot window has been handed the project list: from here a missing project is really not open. */
let bootProjectsLoaded = false;

function projectStateForWindow(
  state: ProjectCollectionState,
  windowId: number,
): ProjectCollectionState {
  const slice = windowSlices.stateForWindow(state, windowId, windowId === bootWindowId);
  if (windowId === bootWindowId) bootProjectsLoaded = true;
  return slice;
}

/** A window died: its projects fall out of `open` into recent; their PTYs keep running in the detached host. */
async function releaseWindowSlices(windowId: number): Promise<void> {
  const released = windowSlices.release(windowId);
  if (released.length === 0 || appQuitting) return;
  try {
    const disk = await listProjectState();
    const openUnion = windowSlices.openUnion();
    const recent = [
      ...released.filter((s) => !openUnion.includes(s)),
      ...disk.recent.filter((s) => !released.includes(s)),
    ];
    await saveProjectState({ ...disk, open: openUnion, recent });
  } catch {
    // best effort - a failed trim only means the projects reopen on restart
  }
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
  void syncAntigravityBrief();
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
  // updates. A same-build host is kept (survive-restart, #28); a version-
  // mismatched one is force-killed by pid (fail-closed, verified via its
  // recorded start time). Pre-registry hosts have no record and are NOT covered
  // here (Phase-2 sweep); the one currently holding the socket is handled by
  // handleStaleHost after the window loads. Placement: deliberately BEFORE
  // createWindow so a recorded stale host is dead before anything can connect
  // to it; the common-path cost is one `ps -p` fork for the kept host (the
  // system-wide snapshot only runs when a kill actually happens).
  let keptCompatibleHosts: number[] = [];
  try {
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
  await handleStaleHost();

  const savedState = await loadWindowState();
  mainWindow = createWindow(savedState);
  startupWindowCreated = true;
  const teamRunner = registerIpc();
  teamsAtQuit = teamRunner;
  configureAutoUpdates(mainWindow);
  // Before checking for a NEW update, surface a PREVIOUS one that silently
  // failed to install and rolled back (#78).
  void reconcilePendingUpdate(mainWindow);
  // Live-follow Omarchy theme switches: re-broadcast so the renderer re-skins.
  const stopOmarchyWatch = watchOmarchyTheme(() => {
    eachAyaWindow((win) => win.webContents.send("omarchy:changed"));
  });
  app.once("before-quit", stopOmarchyWatch);
  if (getUpdateStatus().supported) {
    setTimeout(() => {
      void checkForUpdates();
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
      await dispatchOpenProject(target, directory);
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
  // Aya Web (experimental): start the browser-access server when enabled.
  // Off the critical path - a bad config or busy port must not block boot;
  // the failure lands in webServerError and shows up in Settings.
  void inWebQueue(async () => {
    // Settings may have loaded or changed the config already; that one stands.
    if (!webConfig) webConfig = await loadWebConfig();
    await applyWebServerState();
  })
    .catch((err: unknown) => {
      webServerError = err instanceof Error ? err.message : String(err);
    });
  installApplicationMenu();

  // The stale-host reconcile ran before the window (see above); the menu did
  // not exist yet, so apply the red "Restart Aya" affordance now if needed.
  if (staleHostDetected) setStaleMenuIcon();

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
  dispatchOpenProject(mainWindow, initialDir).catch(logOpenFailure(initialDir));

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
  for (const timer of gpuHealTimers) clearTimeout(timer);
  gpuHealTimers.clear();
  if (IS_E2E_PTY_SHUTDOWN) {
    void ptyHost.shutdown().catch(() => {
      // Test-only cleanup. Normal app runs intentionally keep PTYs alive.
    });
  }
  // After the shutdown above is sent: a request from a closing window must not
  // start a host this quitting app will never connect to.
  ptyHost.dispose();
});

// GPU-helper deaths (#79). The OS can quietly kill the GPU process under memory
// pressure (jetsam); every GPU-composited surface of the window then goes white
// until Chromium relaunches it (~1-2s). No renderer code can shorten that
// window, so we do two things: (1) log the death with its reason so a future
// white-flash report is correlated instantly instead of via `ps` archaeology
// (the `reason` field confirms or refutes the memory-pressure theory), and (2)
// once the replacement GPU process should be up, nudge renderers to re-run
// their existing WebGL/PTY repair path - belt-and-suspenders over Chromium's
// own repaint.
const diagnosticsLog = createPtyLog(DIAGNOSTICS_LOG_FILE);
// Live heal timers: a burst of deaths must not accumulate them.
const gpuHealTimers = new Set<NodeJS.Timeout>();
app.on("child-process-gone", (_event, details) => {
  if (details.type !== "GPU") return;
  // Do not log a clean exit (usually shutdown), but DO heal: a graceful
  // mid-session GPU restart reports clean-exit and still drops WebGL contexts.
  if (details.reason !== "clean-exit") {
    diagnosticsLog.append("gpu-process-gone", {
      reason: details.reason, // killed | crashed | oom | ...
      exitCode: details.exitCode,
    });
  }
  for (const delay of GPU_HEAL_NUDGE_DELAYS_MS) {
    const timer = setTimeout(() => {
      gpuHealTimers.delete(timer);
      if (appQuitting) return;
      eachAyaWindow((win) => win.webContents.send("gpu:relaunched"));
    }, delay);
    gpuHealTimers.add(timer);
  }
});
