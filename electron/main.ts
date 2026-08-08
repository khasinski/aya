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
import {
  createProject,
  createRemoteProject,
  getOrCreateProject,
  deleteProject,
  expandPath,
  listProjects,
  listProjectState,
  saveProjectState,
  updateProject,
} from "./config";
import { bundledAyaCliPath, bundledDistElectronHelperPath } from "./cli-path";
import {
  defaultInstallAyaCliPath,
  parseShimTargets,
  renderCliShim,
} from "./cli-shim";
import { startConfigWatcher } from "./config-watcher";
import { isHostStale } from "./pty-host-staleness";
import { startControlServer } from "./control";
import { startRemoteServer } from "./remote-server";
import {
  createRemoteDirectory,
  createRemoteProjectOnHost,
  checkRemoteHealth,
  listRemotePresets,
  listRemoteDirectory,
} from "./remote-client";
import { getGitChangedFiles, getGitDiff, getGitInfo, listWorktrees } from "./git";
import { getGitHubLink, isGitHubCliAvailable } from "./github";
import {
  AYA_HOME,
  CONTROL_SOCKET_PATH,
  IS_DEV,
  IS_E2E_HEADLESS,
  IS_E2E_PTY_SHUTDOWN,
  PTY_HOST_SOCKET_PATH,
  REMOTE_SOCKET_PATH,
} from "./paths";
import { scanHarnesses } from "./harnesses";
import { isInternalNavigationUrl, parseExternalUrl } from "./navigation";
import { createWorktree, removeWorktree } from "./git";
import { listPresets, savePresets } from "./presets";
import { listSnippets, saveSnippets } from "./snippets";
import { expandUserPath, readClaudeUsageAccounts } from "./usage";
import { DEFAULT_CODEX_HOME, readCodexUsageAccountsFromSources } from "./usage-codex";
import {
  usageHookStatus,
  installUsageHook,
  uninstallUsageHook,
} from "./usage-hook";
import { searchHarnessSessions } from "./harness-search";
import { listMonitoredSessions } from "./session-monitor";
import { normalizeLocalSummaryError, SUMMARY_TEXT_MAX_CHARS } from "./local-summary-errors";
import { readRepoProjectConfig } from "./project-local";
import { repairProcessPath } from "./shell-path";
import { PtyHostClient } from "./pty-host-client";
import { reapStaleHostRecords } from "./pty-host-registry";
import { COMMAND_PROBE_TIMEOUT_MS } from "./constants";
import { sweepLegacyAyaProcesses } from "./pty-host-sweep";
import {
  requirePositiveInt,
  requireString,
  validateSnippetArray,
  validatePresetArray,
  validateProjectCollectionState,
  optionalTrimmed,
  requireRecord,
  validateProjectConfig,
  validateSpawnRequest,
  validateThemesFile,
} from "./validation";
import { loadWindowState, trackWindowState } from "./window-state";
import { resolveDropTarget, WindowProjectSlices } from "./window-slices";
import {
  generateWebPassword,
  loadWebConfig,
  normalizeWebPort,
  saveWebConfig,
  webCredentials,
  type WebConfig,
} from "./web-config";
import { captureIpcHandlers } from "./web-ipc";
import { startWebServer, type WebServerHandle } from "./web-server";
import type {
  AyaIntelligenceConfig,
  CliStatus,
  DiagnosticsReport,
  LocalSummaryRequest,
  LocalSummaryResult,
  OllamaStatus,
  ProjectCollectionState,
  UpdateStatus,
  WebServerStatus,
} from "./types";

const DEV_SERVER_URL = "http://localhost:5183";
const WINDOW_TITLE = IS_DEV ? "Aya Dev" : "Aya";

// Filesystem mode for the installed CLI executable (rwxr-xr-x)
const CLI_EXECUTABLE_MODE = 0o755;
// Maximum number of entries returned by path completion
const MAX_PATH_COMPLETION_ENTRIES = 100;
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
const LOCAL_SUMMARY_TIMEOUT_MS = 20_000;
const LOCAL_SUMMARY_MAX_LINES = 30;
const LOCAL_SUMMARY_MAX_STDOUT_BYTES = 32 * 1024;
const RECOMMENDED_OLLAMA_MODEL = "gemma4:e4b";

const ptyHost = new PtyHostClient(path.join(__dirname, "pty-host.js"));
const UPDATE_AUTO_CHECK_DELAY_MS = 12_000;
// Local Ollama daemon endpoint (fixed default port) - chat + tags probes.
const OLLAMA_BASE_URL = "http://localhost:11434";
// Summarizer sampling knobs, shared by BOTH backends (OpenAI-compatible and
// Ollama) - the two request builders must stay in sync.
const SUMMARY_TEMPERATURE = 0.2;
const SUMMARY_MAX_TOKENS = 64;
// Title fallback caps (first-line words / chars) for the local summary.
const SUMMARY_TITLE_MAX_WORDS = 8;
const SUMMARY_TITLE_MAX_CHARS = 80;
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

async function summarizeWithApple(
  req: LocalSummaryRequest,
): Promise<LocalSummaryResult> {
  if (process.platform !== "darwin") return unavailableLocalSummary("unsupported-platform");
  const helper = bundledDistElectronHelperPath(__dirname, "aya-local-summary");
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
      if (stdout.length < LOCAL_SUMMARY_MAX_STDOUT_BYTES) stdout += chunk;
    });
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < LOCAL_SUMMARY_MAX_STDOUT_BYTES) stderr += chunk;
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

function cleanSummary(value: string): string {
  const oneLine = value
    .replace(/\s+/g, " ")
    .replace(/^["'`]+|["'`.]+$/g, "")
    .trim();
  const words = oneLine.split(/\s+/).filter(Boolean).slice(0, SUMMARY_TITLE_MAX_WORDS).join(" ");
  return words.slice(0, SUMMARY_TITLE_MAX_CHARS);
}

function summaryPrompt(req: LocalSummaryRequest): string {
  const subject =
    req.kind === "project" ? "project activity" : "terminal output";
  return [
    `Summarize recent ${subject} for a compact app label.`,
    "Return strict JSON only, with shape:",
    '{"useful":true,"summary":"2-6 word label"}',
    "If the output is too noisy, generic, idle, or not meaningful, return:",
    '{"useful":false,"summary":""}',
    "Do not invent context. No full sentences. No punctuation. Max 6 words.",
    "",
    "Recent output:",
    req.lines.join("\n"),
  ].join("\n");
}

function openAiBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

function parseSummaryResponse(content: string): LocalSummaryResult {
  const trimmed = content.trim();
  const jsonText =
    trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]?.trim() ?? trimmed;
  try {
    const parsed = JSON.parse(jsonText) as Partial<LocalSummaryResult>;
    const summary =
      typeof parsed.summary === "string" ? cleanSummary(parsed.summary) : "";
    return {
      available: true,
      useful: parsed.useful === true && summary.length > 0,
      summary: parsed.useful === true ? summary : "",
    };
  } catch {
    const summary = cleanSummary(trimmed);
    return { available: true, useful: summary.length > 0, summary };
  }
}

async function summarizeWithOpenAiCompatible(args: {
  req: LocalSummaryRequest;
  baseUrl: string;
  apiKey?: string;
  model: string;
}): Promise<LocalSummaryResult> {
  const baseUrl = openAiBaseUrl(args.baseUrl);
  const model = args.model.trim();
  if (!baseUrl || !model) return unavailableLocalSummary("missing-api-config");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOCAL_SUMMARY_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(args.apiKey ? { Authorization: `Bearer ${args.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        temperature: SUMMARY_TEMPERATURE,
        max_tokens: SUMMARY_MAX_TOKENS,
        think: false,
        messages: [
          {
            role: "system",
            content:
              "You summarize terminal output for a developer tool. Return JSON only.",
          },
          { role: "user", content: summaryPrompt(args.req) },
        ],
      }),
    });
    if (!response.ok) {
      return unavailableLocalSummary(`api-http-${response.status}`);
    }
    const json = (await response.json()) as {
      choices?: Array<{
        message?: { content?: unknown; reasoning?: unknown };
        text?: unknown;
      }>;
    };
    const content =
      typeof json.choices?.[0]?.message?.content === "string"
        ? json.choices[0].message.content ||
          (typeof json.choices[0].message.reasoning === "string"
            ? json.choices[0].message.reasoning
            : "")
        : typeof json.choices?.[0]?.text === "string"
          ? json.choices[0].text
          : "";
    if (!content) return { available: true, useful: false, summary: "" };
    return parseSummaryResponse(content);
  } catch (err) {
    return unavailableLocalSummary(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timeout);
  }
}

async function summarizeWithOllama(
  req: LocalSummaryRequest,
  model: string,
): Promise<LocalSummaryResult> {
  const selectedModel = model.trim() || RECOMMENDED_OLLAMA_MODEL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOCAL_SUMMARY_TIMEOUT_MS);
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: selectedModel,
        stream: false,
        think: false,
        messages: [
          {
            role: "system",
            content:
              "You summarize terminal output for a developer tool. Return JSON only.",
          },
          { role: "user", content: summaryPrompt(req) },
        ],
        options: {
          temperature: SUMMARY_TEMPERATURE,
          num_predict: SUMMARY_MAX_TOKENS,
        },
      }),
    });
    if (!response.ok) {
      return unavailableLocalSummary(`ollama-http-${response.status}`);
    }
    const json = (await response.json()) as {
      message?: { content?: unknown };
    };
    const content =
      typeof json.message?.content === "string" ? json.message.content : "";
    if (!content) return { available: true, useful: false, summary: "" };
    return parseSummaryResponse(content);
  } catch (err) {
    return unavailableLocalSummary(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timeout);
  }
}

async function summarizeLocal(
  req: LocalSummaryRequest,
): Promise<LocalSummaryResult> {
  const intelligence = req.intelligence;
  if (!intelligence || intelligence.provider === "apple") {
    return summarizeWithApple(req);
  }
  if (intelligence.provider === "ollama") {
    return summarizeWithOllama(
      req,
      intelligence.ollamaModel || RECOMMENDED_OLLAMA_MODEL,
    );
  }
  return summarizeWithOpenAiCompatible({
    req,
    baseUrl: intelligence.openAiBaseUrl,
    apiKey: intelligence.openAiApiKey,
    model: intelligence.openAiModel,
  });
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
    .filter((entry) => entry.trim().length > 0);
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

function writableDirOnPath(): string | null {
  for (const entry of pathEntries()) {
    try {
      const stat = statSync(entry);
      if (!stat.isDirectory()) continue;
      accessSync(entry, fsConstants.W_OK);
      return entry;
    } catch {
      // keep looking
    }
  }
  return null;
}

async function cliStatus(): Promise<CliStatus> {
  const installed = findExecutableOnPath("aya");
  const installDir =
    writableDirOnPath() ?? path.join(os.homedir(), ".local", "bin");
  // A shim can be on PATH yet dead: it bakes an absolute path into Aya.app,
  // and moving/renaming the app kills it. Report that as "needs reinstall"
  // instead of a healthy "Installed at ..." (follow-up on #42).
  let broken = false;
  if (installed) {
    try {
      const targets = parseShimTargets(await fs.readFile(installed, "utf-8"));
      broken = targets.length > 0 && !(await anyExecutable(targets));
    } catch {
      // unreadable or not our script - leave it alone
    }
  }
  return {
    installed: installed !== null,
    path: installed,
    installDir,
    installable: true,
    ...(installed
      ? broken
        ? {
            message: `Installed at ${installed}, but it points at a moved or renamed Aya.app - click Reinstall to repair.`,
          }
        : {}
      : { message: `Install to ${path.join(installDir, "aya")}` }),
  };
}

async function installCli(): Promise<CliStatus> {
  const status = await cliStatus();
  const installDir = status.installDir;
  if (!installDir) {
    return {
      installed: false,
      path: null,
      installDir: null,
      installable: false,
      message: "No install directory available.",
    };
  }
  await fs.mkdir(installDir, { recursive: true });
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
  const script = renderCliShim(source, defaultInstallAyaCliPath(process.platform));
  await fs.writeFile(target, script, { mode: CLI_EXECUTABLE_MODE });
  await fs.chmod(target, CLI_EXECUTABLE_MODE);
  return {
    ...(await cliStatus()),
    path: target,
    installed: true,
    message: `Installed at ${target}`,
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Version of the build whose host the client WOULD spawn - read from the
 *  package.json next to dist-electron, exactly how the host computes its own
 *  identity (pty-host.ts computeHostIdentity). app.getVersion() is WRONG for
 *  this in any non-packaged launch (dev, e2e): there it reports Electron's
 *  own version, so the staleness probe compared e.g. "42.5.2" against the
 *  host's honest "0.7.8" and KILLED a perfectly current host on every boot -
 *  murdering all live consoles in dev, and in e2e racing the first spawns
 *  (tabs that landed on the first host died mid-test: a long-standing flake
 *  source). Snapshotted once - the build cannot change under a running app
 *  in a way this comparison should follow. */
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
  const [presets, projects, projectState, usageHook, cli, hostStatus] =
    await Promise.all([
      listPresets(),
      listProjects(),
      listProjectState(),
      usageHookStatus(),
      cliStatus(),
      ptyHost.hostStatus(),
    ]);
  const expected = ptyHost.expectedHostIdentity(EXPECTED_HOST_VERSION);
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
    ptyHost: {
      expected,
      actual: hostStatus.identity,
      ptyCount: hostStatus.ptyCount,
      stale: isHostStale(expected, hostStatus.identity),
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

function updateStatusBase(): Pick<UpdateStatus, "supported" | "currentVersion"> {
  return {
    supported: updatesSupportedMessage() === "",
    currentVersion: app.getVersion(),
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

function configureAutoUpdates(win: BrowserWindow): void {
  if (updateEventsConfigured) return;
  updateEventsConfigured = true;
  updateStatus = getUpdateStatus();
  if (!updateStatus.supported) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
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

/** Resolve the bundled icon. In dev we load straight from the repo's
 *  build/ folder; in production electron-builder embeds it in the .app and
 *  this code path is unused (the dock icon comes from the bundle). */
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

/** Walk argv (which includes electron's own args in dev) and return the
 *  first positional value that resolves to an existing directory. Used to
 *  honor `aya /path/to/project` invocations. */
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
      // Not a real directory — keep searching.
      continue;
    }
  }
  return null;
}

async function completeDirectoryPath(rawPrefix: string): Promise<string[]> {
  const raw = rawPrefix || "~/";
  const normalizedRaw = raw === "~" ? "~/" : raw;
  const endsWithSlash = normalizedRaw.endsWith("/");
  const expanded = expandPath(normalizedRaw);
  const lookupDir = endsWithSlash ? expanded : path.dirname(expanded);
  const namePrefix = endsWithSlash ? "" : path.basename(expanded);
  const rawDirPrefix = endsWithSlash
    ? normalizedRaw
    : normalizedRaw.slice(0, normalizedRaw.length - namePrefix.length);

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(lookupDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => {
      if (!namePrefix && entry.name.startsWith(".")) return false;
      return entry.name.startsWith(namePrefix);
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_PATH_COMPLETION_ENTRIES)
    .map((entry) => `${rawDirPrefix}${entry.name}/`);
}

/** Forward an "open this project" request from another process (or our own
 *  initial argv) to the renderer. The renderer figures out whether to switch
 *  to an existing project, create a new one, or no-op. */
function dispatchOpenProject(
  win: BrowserWindow | null,
  dir: string | null,
): void {
  if (!win || win.isDestroyed() || !dir) return;
  win.webContents.send("open-project", dir);
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

// --- Aya Web (experimental): browser access over HTTP + WebSocket ---
let webConfig: WebConfig | null = null;
let webServer: WebServerHandle | null = null;
// Last start failure (e.g. port already in use) — surfaced in Settings.
let webServerError: string | null = null;
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
      distDir: path.join(__dirname, "..", "dist"),
      getConfig: () => webConfig ?? config,
    });
    ptyHost.attachWebContents(webPtySink);
  } catch (err) {
    webServerError = err instanceof Error ? err.message : String(err);
  }
}

/** Reachable URLs for the settings UI: the pinned address, or every
 *  non-internal IPv4 when listening on all interfaces. */
function webServerUrls(config: WebConfig): string[] {
  if (config.host !== "0.0.0.0" && config.host !== "::") {
    return [`http://${config.host}:${config.port}`];
  }
  const hosts: string[] = [];
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === "IPv4" && !info.internal) hosts.push(info.address);
    }
  }
  if (hosts.length === 0) hosts.push("127.0.0.1");
  return hosts.map((host) => `http://${host}:${config.port}`);
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
      clients: 0,
      error: webServerError,
    };
  }
  return {
    enabled: config.enabled,
    running: webServer !== null,
    port: config.port,
    host: config.host,
    user: config.user,
    generatedPassword: config.generatedPassword ?? null,
    urls: webServerUrls(config),
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

// Cascade offset for a window opened from another window (File > New Window,
// tab tear-out), so it doesn't cover its parent exactly.
const NEW_WINDOW_CASCADE_OFFSET_PX = 28;

/** Open an additional (empty) Aya window, cascaded from the focused one - or,
 *  for a tab tear-out, positioned at the release point so the new window
 *  appears under the cursor like a Chrome tab drag. New windows own no
 *  projects until the user opens/moves one into them (their projects:state
 *  slice starts empty - see projectStateForWindow). */
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
      { x: Math.max(0, at.x - 80), y: Math.max(0, at.y - 20) }
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
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // node-pty needs the preload to have node access
      // In headless e2e the window is never shown, so Chromium would throttle
      // requestAnimationFrame and xterm's render loop would never paint — the
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
  // its left padding (which is there to clear the traffic-light buttons —
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
        appIndexPath: path.join(__dirname, "..", "dist", "index.html"),
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
    // Don't trigger our shortcuts if extra modifiers we don't bind are held —
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

  if (process.env.AYA_DEV === "1") {
    win.loadURL(DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  return win;
}

/** On launch, auto-reap a stale PTY host (#28), even with live terminals: an
 *  update ships new binaries, so the old host's terminals must restart anyway
 *  (Shift+Enter), and leaving it alive is exactly what accumulated orphaned
 *  hosts + processes. Best-effort: never blocks or crashes startup.
 *
 *  Honest limits: restart() only ASKS the socket-connected host to shut down -
 *  the old host runs ITS OWN shutdown code. Hosts from builds before the #73
 *  escalation SIGHUP their children and exit immediately, so a signal-ignoring
 *  child (claude --chrome) can still be orphaned once, at this first-update
 *  boundary; such hosts also predate the registry, so the by-pid reap can't
 *  cover them either. Cleaning those already-orphaned trees is the Phase-2
 *  sweep's job. Hosts from this build onward are covered on both paths. */
async function handleStaleHost(): Promise<void> {
  try {
    const expected = ptyHost.expectedHostIdentity(EXPECTED_HOST_VERSION);
    let { identity } = await ptyHost.hostStatus();
    if (identity === null) {
      // identity null is ALSO returned for transient client-side failures (e.g.
      // a >5s cold-spawn socket wait). Acting on it immediately would shut down
      // the freshly-spawned, current-version host. Re-probe once after a short
      // delay: a genuinely ancient host fails the version request consistently,
      // while a slow spawn answers with a matching identity the second time.
      await new Promise((resolve) => setTimeout(resolve, STALE_HOST_REPROBE_DELAY_MS));
      ({ identity } = await ptyHost.hostStatus());
    }
    if (!isHostStale(expected, identity)) return;
    await ptyHost.restart();
    // restart() swallows request errors by design (an old host may not honor
    // "shutdown"), so returning is NOT proof the host died. Verify: re-probe the
    // socket; a fresh current-version host (or none yet) means success, the SAME
    // stale identity answering again means the reap failed.
    const after = await ptyHost.hostStatus();
    if (!isHostStale(expected, after.identity)) return;
    // Reap didn't take - surface the manual affordance so the user can retry.
    // The menu may not be installed yet (this runs before createWindow), so the
    // caller applies the icon from the flag after installApplicationMenu.
    staleHostDetected = true;
    setStaleMenuIcon();
  } catch {
    // best-effort; a host that can't be queried is handled on next use
  }
}

/** Amber dot on the "Restart Aya" menu item - the manual reap affordance (#52).
 *  No-op until the application menu is installed. */
function setStaleMenuIcon(): void {
  const item = Menu.getApplicationMenu()?.getMenuItemById("restart-aya");
  if (item) {
    // 16x16 px amber dot at scaleFactor 2 = 8pt logical - renders as a
    // small colored circle to the left of the label (standard macOS pattern).
    item.icon = nativeImage.createFromBuffer(
      makeCirclePng(16, 224, 112, 0), // amber #e07000
      { scaleFactor: 2 },
    );
  }
}

function registerIpc(): void {
  // Aya Web reuses these handlers over WebSocket — record every registration
  // (must run before the first ipcMain.handle below).
  captureIpcHandlers(ipcMain);
  // Multi-window: registered once for the whole app, so handlers that act on
  // "the window" resolve the calling renderer's BrowserWindow instead of a
  // captured reference.
  const senderWindow = (
    e: Electron.IpcMainInvokeEvent,
  ): BrowserWindow | null => BrowserWindow.fromWebContents(e.sender);
  ipcMain.handle("pty:spawn", async (_e, req: unknown) => {
    await ptyHost.spawn(validateSpawnRequest(req));
  });
  ipcMain.handle("pty:write", async (_e, ptyId: unknown, data: unknown) =>
    ptyHost.write(
      requireString(ptyId, "pty:write.ptyId"),
      requireString(data, "pty:write.data"),
    ),
  );
  ipcMain.handle(
    "pty:resize",
    async (_e, ptyId: unknown, cols: unknown, rows: unknown) =>
      ptyHost.resize(
        requireString(ptyId, "pty:resize.ptyId"),
        requirePositiveInt(cols, "pty:resize.cols"),
        requirePositiveInt(rows, "pty:resize.rows"),
      ),
  );
  ipcMain.handle("pty:kill", async (_e, ptyId: unknown) =>
    ptyHost.kill(requireString(ptyId, "pty:kill.ptyId")),
  );
  ipcMain.handle("pty:buffer", async (_e, ptyId: unknown) => {
    try {
      return await ptyHost.getBuffer(requireString(ptyId, "pty:buffer.ptyId"));
    } catch (err) {
      if (
        err instanceof Error &&
        /unknown request|PTY host is not connected/i.test(err.message)
      ) {
        return "";
      }
      throw err;
    }
  });
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
      query: requireString(r.query, "harness:search.query"),
    });
  });
  ipcMain.handle("pty-host:restart", async () => {
    await ptyHost.restart();
    // Clear only on success: if restart() throws, the stale state is still
    // true and the amber icon must stay so the user can retry.
    staleHostDetected = false;
    const item = Menu.getApplicationMenu()?.getMenuItemById("restart-aya");
    if (item) item.icon = nativeImage.createEmpty();
  });

  ipcMain.handle("projects:list", async () => listProjects());
  ipcMain.handle("projects:state", async (e) => {
    const state = await listProjectState();
    const win = senderWindow(e);
    // Each window sees only its own open-project slice (multi-window). No
    // window (e.g. remote server path) gets the full on-disk state.
    return win ? projectStateForWindow(state, win.id) : state;
  });
  ipcMain.handle("projects:save-state", async (e, state: unknown) => {
    const valid = validateProjectCollectionState(state);
    const win = senderWindow(e);
    if (!win) return saveProjectState(valid);
    const disk = await listProjectState().catch(() => null);
    return saveProjectState(windowSlices.mergeSave(valid, win.id, disk));
  });
  // Multi-window: targets for "Move to window…" (every live window but the
  // caller, labeled by its last-saved active project).
  ipcMain.handle("windows:list-others", async (e) => {
    const self = senderWindow(e);
    return [...ayaWindows]
      .filter((w) => !w.isDestroyed() && w !== self)
      .map((w) => ({
        id: w.id,
        activeProject: windowSlices.activeProjectOf(w.id),
      }));
  });
  // Adopt a (released) project into another window - the source renderer drops
  // its local state first (WITHOUT killing PTYs), then calls this; the target
  // window runs the ordinary switch-or-create open flow and re-attaches to the
  // live PTYs exactly like after an app restart.
  // Where would a tab released at this screen point land? Pure hit-test over
  // the live windows' bounds; the source window wins overlaps (see
  // resolveDropTarget).
  ipcMain.handle(
    "windows:resolve-drop",
    async (e, x: unknown, y: unknown) => {
      if (typeof x !== "number" || typeof y !== "number") {
        throw new Error("windows:resolve-drop: x/y must be numbers");
      }
      const self = senderWindow(e);
      const candidates = [...ayaWindows]
        .filter((w) => !w.isDestroyed() && w.isVisible())
        .map((w) => ({ id: w.id, bounds: w.getBounds(), isSelf: w === self }));
      return resolveDropTarget(x, y, candidates);
    },
  );
  ipcMain.handle(
    "windows:adopt-project",
    async (_e, directory: unknown, target: unknown, at: unknown) => {
      const dir = requireString(directory, "windows:adopt-project.directory");
      const dropAt =
        at &&
        typeof at === "object" &&
        typeof (at as Record<string, unknown>).x === "number" &&
        typeof (at as Record<string, unknown>).y === "number"
          ? (at as { x: number; y: number })
          : undefined;
      let win: BrowserWindow | null = null;
      if (target === "new") {
        win = await openNewWindow(dropAt);
      } else if (typeof target === "number") {
        win =
          [...ayaWindows].find((w) => w.id === target && !w.isDestroyed()) ??
          null;
      }
      if (!win) throw new Error("windows:adopt-project: target window not found");
      if (win.isMinimized()) win.restore();
      win.focus();
      const targetWin = win;
      if (targetWin.webContents.isLoading()) {
        targetWin.webContents.once("did-finish-load", () =>
          dispatchOpenProject(targetWin, dir),
        );
      } else {
        dispatchOpenProject(targetWin, dir);
      }
    },
  );
  ipcMain.handle("projects:create", async (_e, name: unknown, dir: unknown) =>
    createProject(
      requireString(name, "projects:create.name"),
      requireString(dir, "projects:create.dir"),
    ),
  );
  ipcMain.handle("projects:create-remote", async (_e, req: unknown) => {
    if (typeof req !== "object" || req === null || Array.isArray(req)) {
      throw new Error("projects:create-remote.req must be an object");
    }
    const r = req as Record<string, unknown>;
    return createRemoteProject({
      name: requireString(r.name, "projects:create-remote.name"),
      directory: requireString(r.directory, "projects:create-remote.directory"),
      hostId: requireString(r.hostId, "projects:create-remote.hostId"),
      label: requireString(r.label, "projects:create-remote.label"),
      sshTarget: requireString(r.sshTarget, "projects:create-remote.sshTarget"),
    });
  });
  ipcMain.handle(
    "remote:list-directory",
    async (_e, sshTarget: unknown, directory: unknown) =>
      listRemoteDirectory(
        requireString(sshTarget, "remote:list-directory.sshTarget"),
        typeof directory === "string" ? directory : undefined,
      ),
  );
  ipcMain.handle(
    "remote:create-directory",
    async (_e, sshTarget: unknown, directory: unknown) =>
      createRemoteDirectory(
        requireString(sshTarget, "remote:create-directory.sshTarget"),
        requireString(directory, "remote:create-directory.directory"),
      ),
  );
  ipcMain.handle("remote:list-presets", async (_e, sshTarget: unknown) =>
    listRemotePresets(requireString(sshTarget, "remote:list-presets.sshTarget")),
  );
  ipcMain.handle("remote:health", async (_e, sshTarget: unknown) =>
    checkRemoteHealth(requireString(sshTarget, "remote:health.sshTarget")),
  );
  ipcMain.handle(
    "remote:create-project",
    async (_e, sshTarget: unknown, directory: unknown, name: unknown) =>
      createRemoteProjectOnHost(
        requireString(sshTarget, "remote:create-project.sshTarget"),
        requireString(directory, "remote:create-project.directory"),
        typeof name === "string" ? name : undefined,
      ),
  );
  ipcMain.handle("projects:update", async (_e, project: unknown) =>
    updateProject(validateProjectConfig(project)),
  );
  ipcMain.handle("projects:delete", async (_e, slug: unknown) =>
    deleteProject(requireString(slug, "projects:delete.slug")),
  );
  ipcMain.handle("projects:read-repo-config", async (_e, dir: unknown) =>
    readRepoProjectConfig(requireString(dir, "projects:read-repo-config.dir")),
  );

  ipcMain.handle("presets:list", async () => listPresets());
  ipcMain.handle("presets:save", async (_e, presets: unknown) =>
    savePresets(validatePresetArray(presets)),
  );
  ipcMain.handle("presets:scan-harnesses", async () => scanHarnesses());

  ipcMain.handle("snippets:list", async () => listSnippets());
  ipcMain.handle("snippets:save", async (_e, snippets: unknown) =>
    saveSnippets(validateSnippetArray(snippets)),
  );
  ipcMain.handle("local-summary:summarize", async (_e, req: unknown) =>
    summarizeLocal(validateLocalSummaryRequest(req)),
  );
  // Read-only: the account-wide usage snapshot a user hook writes (no fetch).
  ipcMain.handle("usage:get", async () => {
    const presets = await listPresets();
    return readClaudeUsageAccounts(
      presets
        .filter((p) => p.agent === "claude")
        .map((p) => ({
          id: p.id,
          label: p.name,
          configDir: p.configDir || "~/.claude",
        })),
    );
  });
  // Read-only: Codex usage, parsed from its own local rollout logs (Codex
  // writes its rate-limit % there, so no token/endpoint/hook is needed).
  ipcMain.handle("usage:get-codex", async () => {
    const presets = await listPresets();
    const codexPresets = presets.filter((p) => p.agent === "codex");
    return readCodexUsageAccountsFromSources(
      (codexPresets.length > 0
        ? codexPresets
        : [{ id: "codex", name: "Codex", configDir: DEFAULT_CODEX_HOME }]).map(
        (p) => ({
          id: p.id,
          label: p.name,
          home:
            "configDir" in p && typeof p.configDir === "string" && p.configDir
              ? expandUserPath(p.configDir)
              : expandUserPath("~/.codex"),
        }),
      ),
    );
  });
  // Optional, user-enabled usage hook installer (writes ~/.claude/settings.json
  // + a fetch script). The Aya process never reads a token or calls the
  // endpoint — that happens later in the script, run by Claude Code.
  ipcMain.handle("usage-hook:status", async () => usageHookStatus());
  ipcMain.handle("usage-hook:install", async () => installUsageHook());
  ipcMain.handle("usage-hook:uninstall", async () => uninstallUsageHook());
  ipcMain.handle("sessions:list-monitored", async () => listMonitoredSessions());
  ipcMain.handle("intelligence:ollama-status", async (_e, model: unknown) =>
    ollamaStatus(typeof model === "string" && model.trim() ? model.trim() : undefined),
  );
  ipcMain.handle("intelligence:pull-ollama-model", async (_e, model: unknown) =>
    pullOllamaModel(validateOllamaModelName(model)),
  );

  ipcMain.handle("themes:list", async () => {
    const { loadThemes } = await import("./themes");
    return loadThemes();
  });
  ipcMain.handle("themes:save", async (_e, file: unknown) => {
    const { saveThemes } = await import("./themes");
    return saveThemes(validateThemesFile(file));
  });
  ipcMain.handle("themes:import", async (e) => {
    const { parseTheme } = await import("./themes");
    const win = senderWindow(e);
    const options = {
      title: "Import terminal theme",
      defaultPath: app.getPath("home"),
      properties: ["openFile" as const],
      filters: [
        {
          name: "Terminal themes (.itermcolors, .json)",
          extensions: ["itermcolors", "json"],
        },
        { name: "iTerm2 colors", extensions: ["itermcolors"] },
        { name: "Windows Terminal JSON", extensions: ["json"] },
        { name: "All files", extensions: ["*"] },
      ],
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    const content = await fs.readFile(filePath, "utf-8");
    const fallbackName = path.basename(filePath, path.extname(filePath));
    return parseTheme(content, fallbackName);
  });

  ipcMain.handle("env:cwd", async () => process.cwd());
  ipcMain.handle("env:home", async () => os.homedir());
  ipcMain.handle("env:expand", async (_e, p: unknown) =>
    expandPath(requireString(p, "env:expand.path")),
  );
  ipcMain.handle("env:complete-path", async (_e, p: unknown) =>
    completeDirectoryPath(requireString(p, "env:complete-path.path")),
  );
  ipcMain.handle("env:git", async (_e, directory: unknown) =>
    getGitInfo(requireString(directory, "env:git.directory")),
  );
  ipcMain.handle("env:git-changed-files", async (_e, directory: unknown) =>
    getGitChangedFiles(requireString(directory, "env:git-changed-files.directory")),
  );
  ipcMain.handle("env:git-diff", async (_e, directory: unknown) =>
    getGitDiff(requireString(directory, "env:git-diff.directory")),
  );
  ipcMain.handle("env:git-worktrees", async (_e, directory: unknown) =>
    listWorktrees(requireString(directory, "env:git-worktrees.directory")),
  );
  ipcMain.handle("env:github-link", async (_e, directory: unknown) =>
    getGitHubLink(requireString(directory, "env:github-link.directory")),
  );
  ipcMain.handle("env:git-worktree-add", async (_e, req: unknown) => {
    const r = requireRecord(req, "env:git-worktree-add");
    return createWorktree(
      requireString(r.directory, "env:git-worktree-add.directory"),
      requireString(r.path, "env:git-worktree-add.path"),
      optionalTrimmed(r.branch),
      optionalTrimmed(r.base),
    );
  });
  ipcMain.handle("env:git-worktree-remove", async (_e, req: unknown) => {
    const r = requireRecord(req, "env:git-worktree-remove");
    return removeWorktree(
      requireString(r.directory, "env:git-worktree-remove.directory"),
      requireString(r.path, "env:git-worktree-remove.path"),
      r.force === true,
    );
  });
  ipcMain.handle("env:github-cli-available", async () =>
    isGitHubCliAvailable(),
  );
  ipcMain.handle("env:pick-dir", async (e) => {
    const win = senderWindow(e);
    const options = {
      title: "Pick a project directory",
      defaultPath: app.getPath("home"),
      properties: ["openDirectory" as const, "createDirectory" as const],
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
  ipcMain.handle("env:pick-sound", async (e) => {
    const win = senderWindow(e);
    const options = {
      title: "Pick a notification sound",
      properties: ["openFile" as const],
      filters: [
        { name: "Audio", extensions: ["wav", "mp3", "ogg", "m4a", "aac", "flac"] },
        { name: "All files", extensions: ["*"] },
      ],
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
  ipcMain.handle("env:dir-exists", async (_e, p: unknown) => {
    try {
      const stat = await fs.stat(
        expandPath(requireString(p, "env:dir-exists.path")),
      );
      return stat.isDirectory();
    } catch {
      return false;
    }
  });
  ipcMain.handle("env:create-dir", async (_e, p: unknown) => {
    await fs.mkdir(expandPath(requireString(p, "env:create-dir.path")), {
      recursive: true,
    });
  });
  ipcMain.handle("env:open-path", async (_e, p: unknown) => {
    const expanded = expandPath(requireString(p, "env:open-path.path"));
    const error = await shell.openPath(expanded);
    if (error) throw new Error(error);
  });
  ipcMain.handle("env:open-url", async (_e, value: unknown) => {
    await openExternalUrl(requireString(value, "env:open-url.url"));
  });
  ipcMain.handle("env:clipboard-read", async () => clipboard.readText());
  ipcMain.handle("env:clipboard-write", async (_e, value: unknown) => {
    clipboard.writeText(requireString(value, "env:clipboard-write.text"));
  });
  ipcMain.handle("app:is-fullscreen", async (e) => {
    const win = senderWindow(e);
    return win ? isAyaFullScreen(win) : false;
  });
  ipcMain.handle("app:is-maximized", async (e) => {
    const win = senderWindow(e);
    return win ? win.isMaximized() : false;
  });
  ipcMain.handle("app:minimize", (e) => {
    const win = senderWindow(e);
    if (win && !win.isDestroyed()) win.minimize();
  });
  ipcMain.handle("app:toggle-maximize", (e) => {
    const win = senderWindow(e);
    if (!win || win.isDestroyed()) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle("app:close", (e) => {
    const win = senderWindow(e);
    if (win && !win.isDestroyed()) win.close();
  });
  ipcMain.handle("app:set-fullscreen", async (e, value: unknown) => {
    const win = senderWindow(e);
    if (win) setAyaFullScreen(win, !!value);
  });
  // Dock badge for unattended notifications (waiting terminals). Empty
  // string clears. macOS only; no-op on Linux/Windows for now since their
  // taskbar badge stories differ.
  ipcMain.handle("app:focus-window", (e) => {
    const win = senderWindow(e);
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  ipcMain.handle("app:notify-waiting", async (e, req: unknown) => {
    if (!Notification.isSupported()) return;
    // The notifying renderer owns the terminal - clicking the notification
    // must focus THAT window, which may not exist anymore by click time.
    const win = senderWindow(e);
    const projectSlug = requireString(
      (req as Record<string, unknown> | null)?.projectSlug,
      "app:notify-waiting.projectSlug",
    );
    const terminalId = requireString(
      (req as Record<string, unknown> | null)?.terminalId,
      "app:notify-waiting.terminalId",
    );
    const body = requireString(
      (req as Record<string, unknown> | null)?.body,
      "app:notify-waiting.body",
    );
    const notification = new Notification({
      title: "Aya - waiting for input",
      body,
      silent: false,
    });
    notification.on("click", () => {
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.focus();
      win.webContents.send("notification:select-terminal", {
        projectSlug,
        terminalId,
      });
    });
    notification.show();
  });
  ipcMain.handle("app:cli-status", async () => cliStatus());
  ipcMain.handle("app:install-cli", async () => installCli());
  ipcMain.handle("app:diagnostics", async () => diagnosticsReport());
  ipcMain.handle("updates:status", async () => getUpdateStatus());
  ipcMain.handle("updates:check", async () => checkForUpdates());
  ipcMain.handle("updates:install", async () => {
    if (getUpdateStatus().phase !== "downloaded") {
      throw new Error("No downloaded update is ready to install.");
    }
    autoUpdater.quitAndInstall(false, true);
  });
  ipcMain.handle("app:open-notification-settings", async () => {
    if (process.platform === "darwin") {
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
      );
    }
  });
  // Microphone access surfaced read-only in Settings: Aya never records, but
  // CLI tools the user runs (e.g. a /voice plugin) may. macOS owns the actual
  // grant/revoke; these just report status, trigger the system prompt, and
  // deep-link to the real toggle. See build/entitlements.mac.plist (audio-input).
  ipcMain.handle("mic:status", async () => {
    if (process.platform !== "darwin") return "unsupported";
    return systemPreferences.getMediaAccessStatus("microphone");
  });
  ipcMain.handle("mic:request", async () => {
    if (process.platform !== "darwin") return true;
    // No-op (returns immediately) if already granted/denied; only prompts when
    // status is not-determined.
    return systemPreferences.askForMediaAccess("microphone");
  });
  ipcMain.handle("mic:open-settings", async () => {
    if (process.platform === "darwin") {
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
      );
    }
  });
  ipcMain.handle("app:set-dock-badge", async (_e, text: unknown) => {
    const badge = requireString(text, "app:set-dock-badge.text");
    if (process.platform === "darwin" && app.dock) {
      try {
        app.dock.setBadge(badge || "");
      } catch {
        // best effort
      }
    }
  });

  // --- Aya Web (experimental) ---
  ipcMain.handle("web:status", async () => {
    if (!webConfig) webConfig = await loadWebConfig();
    return webStatus();
  });
  ipcMain.handle("web:configure", async (_e, req: unknown) => {
    if (typeof req !== "object" || req === null) {
      throw new Error("web:configure: request must be an object");
    }
    if (!webConfig) webConfig = await loadWebConfig();
    const r = req as Record<string, unknown>;
    const next: WebConfig = { ...webConfig };
    if (typeof r.enabled === "boolean") next.enabled = r.enabled;
    if (r.port !== undefined) next.port = normalizeWebPort(r.port);
    if (typeof r.user === "string" && r.user.trim()) {
      next.user = r.user.trim();
    }
    if (typeof r.password === "string" && r.password) {
      // Custom password: store only the hash; the plaintext generated copy
      // (if any) is dropped by webCredentials.
      delete next.generatedPassword;
      Object.assign(next, webCredentials(r.password, false));
    }
    webConfig = next;
    await saveWebConfig(next);
    await applyWebServerState();
    return webStatus();
  });
  ipcMain.handle("web:regenerate-password", async () => {
    if (!webConfig) webConfig = await loadWebConfig();
    webConfig = {
      ...webConfig,
      ...webCredentials(generateWebPassword(), true),
    };
    await saveWebConfig(webConfig);
    // Existing sessions stay valid; new logins need the new password.
    return webStatus();
  });
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

function eachAyaWindow(fn: (win: BrowserWindow) => void): void {
  for (const win of ayaWindows) {
    if (!win.isDestroyed()) fn(win);
  }
}

// Per-window project slices (multi-window, session-only) - semantics live in
// window-slices.ts; main only wires window ids and the disk write.
const windowSlices = new WindowProjectSlices();
let bootWindowId: number | null = null;

function projectStateForWindow(
  state: ProjectCollectionState,
  windowId: number,
): ProjectCollectionState {
  return windowSlices.stateForWindow(state, windowId, windowId === bootWindowId);
}

/** A window died: drop its slice and persist the shrunken union so its
 *  projects fall out of `open` (they land back in recent; their PTYs keep
 *  running in the detached host, same as an app restart). */
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
  const target = focusedAyaWindow();
  if (target) {
    if (target.isMinimized()) target.restore();
    target.focus();
  }
  const dir = findDirInArgv(argv) ?? workingDir ?? null;
  dispatchOpenProject(target, dir);
});

// macOS sends open-file for `open -a Aya /path` (when invoked without --args).
app.on("open-file", (event, filePath) => {
  event.preventDefault();
  const target = focusedAyaWindow();
  if (target) {
    if (target.isMinimized()) target.restore();
    target.focus();
  }
  try {
    if (statSync(filePath).isDirectory()) {
      dispatchOpenProject(target, filePath);
    }
  } catch {
    // ignore
  }
});

app.whenReady().then(async () => {
  configureAppIdentity();

  // Repair PATH before anything that resolves a binary. A GUI-launched app
  // only inherits launchd's minimal PATH, so the user's CLIs (claude, codex,
  // …) installed under ~/.local/bin / mise / asdf are invisible until we pull
  // the real PATH from a login shell. Must run before createWindow (the
  // renderer's first preset:list triggers a harness scan) and before the PTY
  // host spawns (it inherits this process's env), so we await it here. The
  // probe self-bounds (SIGKILL + guard timer), so a slow rc delays first paint
  // by at most the probe timeout; a failed probe is a no-op.
  await repairProcessPath();

  // In dev, replace Electron's default dock icon with ours so the running
  // instance is visually distinguishable. In packaged builds the bundle's
  // icon handles this, so we skip.
  if (IS_DEV && process.platform === "darwin" && app.dock) {
    try {
      const icon = nativeImage.createFromPath(devIconPath());
      if (!icon.isEmpty()) app.dock.setIcon(icon);
    } catch {
      // Non-fatal — just means we keep Electron's default dock icon.
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
    const summary = reapStaleHostRecords(
      ptyHost.expectedHostIdentity(EXPECTED_HOST_VERSION),
      path.join(__dirname, "pty-host.js"),
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
    // best effort — never block startup on reconciliation
  }

  // Reconcile the SOCKET-connected host too, still before the window exists:
  // once the renderer loads it immediately spawns terminals, and a spawn that
  // raced this check could land on the stale host and be killed by the reap
  // (losing the user's first terminal). Fast path: no socket file, no host to
  // reconcile — don't pay a probe (which would spawn a host early) on a cold
  // start. The amber fallback icon is applied after installApplicationMenu.
  if (await pathExists(PTY_HOST_SOCKET_PATH)) {
    await handleStaleHost();
  }

  const savedState = await loadWindowState();
  mainWindow = createWindow(savedState);
  registerIpc();
  configureAutoUpdates(mainWindow);
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
    readPane: (terminalId) => ptyHost.getBuffer(terminalId),
    writePane: async (terminalId, data) => {
      ptyHost.write(terminalId, data);
    },
    // Status updates also reach Aya Web clients via a virtual window-like
    // sink (harness status dots must work in the browser too).
    getWindows: () => [
      ...[...ayaWindows].filter((w) => !w.isDestroyed()),
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: "control:status", update: unknown) => {
            webServer?.broadcast(channel, update);
          },
        },
      },
    ],
    openProject: (directory) => {
      const target = focusedAyaWindow();
      if (target) {
        if (target.isMinimized()) target.restore();
        target.focus();
      }
      dispatchOpenProject(target, directory);
    },
  });
  startRemoteServer({
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
  // Off the critical path — a bad config or busy port must not block boot;
  // the failure lands in webServerError and shows up in Settings.
  void loadWebConfig()
    .then(async (config) => {
      webConfig = config;
      await applyWebServerState();
    })
    .catch((err: unknown) => {
      webServerError = err instanceof Error ? err.message : String(err);
    });
  installApplicationMenu();

  // The stale-host reconcile ran before the window (see above); the menu did
  // not exist yet, so apply the amber "Restart Aya" affordance now if needed.
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

  // Honor an initial directory argument on first launch — the renderer
  // applies the same switch-or-create logic as for second-instance.
  const initialDir = findDirInArgv(process.argv);
  if (initialDir && mainWindow) {
    mainWindow.webContents.once("did-finish-load", () => {
      dispatchOpenProject(mainWindow, initialDir);
    });
  }

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const state = await loadWindowState();
      mainWindow = createWindow(state);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  appQuitting = true;
  if (legacySweepTimer) {
    clearTimeout(legacySweepTimer);
    legacySweepTimer = null;
  }
  if (!IS_E2E_PTY_SHUTDOWN) return;
  void ptyHost.shutdown().catch(() => {
    // Test-only cleanup. Normal app runs intentionally keep PTYs alive.
  });
});
