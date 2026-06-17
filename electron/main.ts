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
import {
  accessSync,
  constants as fsConstants,
  promises as fs,
  readFileSync,
  statSync,
} from "node:fs";
import { deflateSync } from "node:zlib";
import * as os from "node:os";
import * as path from "node:path";
import {
  createProject,
  deleteProject,
  expandPath,
  listProjects,
  listProjectState,
  saveProjectState,
  updateProject,
} from "./config";
import { bundledAyaCliPath } from "./cli-path";
import {
  defaultInstallAyaCliPath,
  parseShimTargets,
  renderCliShim,
} from "./cli-shim";
import { startConfigWatcher } from "./config-watcher";
import { isHostStale } from "./pty-host-staleness";
import { startControlServer } from "./control";
import { startRemoteServer } from "./remote-server";
import { getGitChangedFiles, getGitDiff, getGitInfo } from "./git";
import { IS_DEV, IS_E2E_HEADLESS, IS_E2E_PTY_SHUTDOWN } from "./paths";
import { scanHarnesses } from "./harnesses";
import { isInternalNavigationUrl, parseHttpUrl } from "./navigation";
import { listPresets, savePresets } from "./presets";
import { listSnippets, saveSnippets } from "./snippets";
import { readUsageAccounts } from "./usage";
import { readCodexUsageAccounts } from "./usage-codex";
import {
  usageHookStatus,
  installUsageHook,
  uninstallUsageHook,
} from "./usage-hook";
import { readRepoProjectConfig } from "./project-local";
import { repairProcessPath } from "./shell-path";
import { PtyHostClient } from "./pty-host-client";
import {
  requirePositiveInt,
  requireString,
  validateSnippetArray,
  validatePresetArray,
  validateProjectCollectionState,
  validateProjectConfig,
  validateSpawnRequest,
  validateThemesFile,
} from "./validation";
import { loadWindowState, trackWindowState } from "./window-state";
import type { CliStatus } from "./types";

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

const ptyHost = new PtyHostClient(path.join(__dirname, "pty-host.js"));
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

async function openExternalHttpUrl(raw: string): Promise<void> {
  const parsed = parseHttpUrl(raw);
  if (!parsed) throw new Error("Only HTTP and HTTPS URLs can be opened.");
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
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("shortcut", action);
}

function showAyaAboutPanel(): void {
  if (!IS_DEV && process.platform === "darwin") {
    app.showAboutPanel();
    return;
  }
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
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
          click: () => toggleAyaFullScreen(mainWindow),
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
    ...(process.platform === "linux" ? { frame: false } : {}),
    backgroundColor: COLOR_DARK_BG,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // node-pty needs the preload to have node access
    },
  });

  if (process.platform === "darwin") {
    win.setWindowButtonVisibility(false);
    applyMacOsWindowHack(win);
  }

  if (initial.isMaximized) win.maximize();
  if (initial.isFullScreen) setAyaFullScreen(win, true);

  // Persist geometry changes; the helper handles debouncing + final flush.
  trackWindowState(win);
  ptyHost.setWebContents(win.webContents);

  // Watch ~/.aya/ for edits to snippets/presets/themes made outside the app
  // and reload that slice in the renderer. Stopped when the window closes.
  const stopConfigWatcher = startConfigWatcher(win);

  win.once("ready-to-show", () => {
    if (!IS_E2E_HEADLESS) win.show();
  });
  win.on("closed", () => {
    stopConfigWatcher();
    // Keep the module-level ref in sync so second-instance handlers don't
    // try to focus a destroyed window.
    if (mainWindow === win) mainWindow = null;
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
    setTimeout(() => applyMacOsWindowHack(win), 250);
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
  // keys. Catch both centrally and hand http(s) URLs to the OS browser.
  const handleExternalNavigation = (
    event: { preventDefault(): void },
    url: string,
  ) => {
    if (isInternalNavigationUrl(url, { isDev: IS_DEV, devServerUrl: DEV_SERVER_URL })) return;
    event.preventDefault();
    if (parseHttpUrl(url)) void openExternalHttpUrl(url);
  };

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (parseHttpUrl(url)) void openExternalHttpUrl(url);
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

/** On launch, detect a stale PTY host (#28). With zero live terminals it is
 *  safe to reap silently; otherwise a restart would kill the user's running
 *  processes, so we only notify the renderer (which offers a confirm + button).
 *  Best-effort: never blocks or crashes startup. */
async function handleStaleHost(win: BrowserWindow | null): Promise<void> {
  if (!win || win.isDestroyed()) return;
  try {
    const { identity, ptyCount } = await ptyHost.hostStatus();
    const expected = ptyHost.expectedHostIdentity(app.getVersion());
    if (!isHostStale(expected, identity)) return;
    // Only auto-reap silently when the handshake succeeded and confirmed zero
    // terminals. When identity===null the host does not support the version
    // request (old host after reinstall) so ptyCount is unknown - always show
    // the banner.
    if (identity !== null && ptyCount === 0) {
      await ptyHost.restart();
      return;
    }
    // Signal via the menu item icon instead of an intrusive banner (#52).
    staleHostDetected = true;
    const item = Menu.getApplicationMenu()?.getMenuItemById("restart-aya");
    if (item) {
      // 16x16 px amber dot at scaleFactor 2 = 8pt logical - renders as a
      // small colored circle to the left of the label (standard macOS pattern).
      item.icon = nativeImage.createFromBuffer(
        makeCirclePng(16, 224, 112, 0), // amber #e07000
        { scaleFactor: 2 },
      );
    }
  } catch {
    // best-effort; a host that can't be queried is handled on next use
  }
}

function registerIpc(win: BrowserWindow): void {
  ptyHost.setWebContents(win.webContents);
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
  ipcMain.handle("pty:search", async (_e, query: unknown) =>
    ptyHost.search(requireString(query, "pty:search.query")),
  );
  ipcMain.handle("pty-host:restart", async () => {
    await ptyHost.restart();
    // Clear only on success: if restart() throws, the stale state is still
    // true and the amber icon must stay so the user can retry.
    staleHostDetected = false;
    const item = Menu.getApplicationMenu()?.getMenuItemById("restart-aya");
    if (item) item.icon = nativeImage.createEmpty();
  });

  ipcMain.handle("projects:list", async () => listProjects());
  ipcMain.handle("projects:state", async () => listProjectState());
  ipcMain.handle("projects:save-state", async (_e, state: unknown) =>
    saveProjectState(validateProjectCollectionState(state)),
  );
  ipcMain.handle("projects:create", async (_e, name: unknown, dir: unknown) =>
    createProject(
      requireString(name, "projects:create.name"),
      requireString(dir, "projects:create.dir"),
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
  // Read-only: the account-wide usage snapshot a user hook writes (no fetch).
  ipcMain.handle("usage:get", async () => readUsageAccounts());
  // Read-only: Codex usage, parsed from its own local rollout logs (Codex
  // writes its rate-limit % there, so no token/endpoint/hook is needed).
  ipcMain.handle("usage:get-codex", async () => readCodexUsageAccounts());
  // Optional, user-enabled usage hook installer (writes ~/.claude/settings.json
  // + a fetch script). The Aya process never reads a token or calls the
  // endpoint — that happens later in the script, run by Claude Code.
  ipcMain.handle("usage-hook:status", async () => usageHookStatus());
  ipcMain.handle("usage-hook:install", async () => installUsageHook());
  ipcMain.handle("usage-hook:uninstall", async () => uninstallUsageHook());

  ipcMain.handle("themes:list", async () => {
    const { loadThemes } = await import("./themes");
    return loadThemes();
  });
  ipcMain.handle("themes:save", async (_e, file: unknown) => {
    const { saveThemes } = await import("./themes");
    return saveThemes(validateThemesFile(file));
  });
  ipcMain.handle("themes:import", async () => {
    const { parseTheme } = await import("./themes");
    const result = await dialog.showOpenDialog(win, {
      title: "Import terminal theme",
      properties: ["openFile"],
      filters: [
        {
          name: "Terminal themes (.itermcolors, .json)",
          extensions: ["itermcolors", "json"],
        },
        { name: "iTerm2 colors", extensions: ["itermcolors"] },
        { name: "Windows Terminal JSON", extensions: ["json"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
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
  ipcMain.handle("env:pick-dir", async () => {
    const result = await dialog.showOpenDialog(win, {
      title: "Pick a project directory",
      properties: ["openDirectory", "createDirectory"],
    });
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
    await openExternalHttpUrl(requireString(value, "env:open-url.url"));
  });
  ipcMain.handle("env:clipboard-read", async () => clipboard.readText());
  ipcMain.handle("env:clipboard-write", async (_e, value: unknown) => {
    clipboard.writeText(requireString(value, "env:clipboard-write.text"));
  });
  ipcMain.handle("app:is-fullscreen", async () => isAyaFullScreen(win));
  ipcMain.handle("app:is-maximized", async () => win.isMaximized());
  ipcMain.handle("app:minimize", () => {
    if (!win.isDestroyed()) win.minimize();
  });
  ipcMain.handle("app:toggle-maximize", () => {
    if (win.isDestroyed()) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle("app:close", () => {
    if (!win.isDestroyed()) win.close();
  });
  ipcMain.handle("app:set-fullscreen", async (_e, value: unknown) => {
    setAyaFullScreen(win, !!value);
  });
  // Dock badge for unattended notifications (waiting terminals). Empty
  // string clears. macOS only; no-op on Linux/Windows for now since their
  // taskbar badge stories differ.
  ipcMain.handle("app:focus-window", () => {
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  ipcMain.handle("app:notify-waiting", async (_e, req: unknown) => {
    if (!Notification.isSupported()) return;
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
      if (win.isDestroyed()) return;
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
}

// Holds the active window reference so second-instance / app:open-file
// handlers can talk to the renderer.
let mainWindow: BrowserWindow | null = null;

// Triggered when a second `Aya` launch happens while we're already running
// (the single-instance lock above redirects argv here). Focus the window and
// forward any directory argument to the renderer.
app.on("second-instance", (_e, argv, workingDir) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  const dir = findDirInArgv(argv) ?? workingDir ?? null;
  dispatchOpenProject(mainWindow, dir);
});

// macOS sends open-file for `open -a Aya /path` (when invoked without --args).
app.on("open-file", (event, filePath) => {
  event.preventDefault();
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  try {
    if (statSync(filePath).isDirectory()) {
      dispatchOpenProject(mainWindow, filePath);
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

  const savedState = await loadWindowState();
  mainWindow = createWindow(savedState);
  registerIpc(mainWindow);
  startControlServer({
    getWindow: () => mainWindow,
    openProject: (directory) => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
      dispatchOpenProject(mainWindow, directory);
    },
  });
  startRemoteServer({
    appVersion: app.getVersion(),
    getSnapshot: async () => ({
      projects: await listProjects(),
      projectState: await listProjectState(),
      presets: await listPresets(),
    }),
  });
  installApplicationMenu();

  // After the renderer is listening, check whether the (detached, survives-
  // restart) PTY host is from an older build and act on it (#28).
  mainWindow.webContents.once("did-finish-load", () => {
    void handleStaleHost(mainWindow);
  });

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
  if (!IS_E2E_PTY_SHUTDOWN) return;
  void ptyHost.shutdown().catch(() => {
    // Test-only cleanup. Normal app runs intentionally keep PTYs alive.
  });
});
