// Electron main process. Creates the window, wires IPC handlers to the PTY
// host and the project config layer.

import { app, BrowserWindow, dialog, ipcMain, nativeImage } from "electron";
import { promises as fs, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createProject,
  deleteProject,
  expandPath,
  listProjects,
  updateProject,
} from "./config";
import { getGitInfo } from "./git";
import { IS_DEV } from "./paths";
import { listPresets, savePresets } from "./presets";
import { killAll, killPty, resizePty, spawnPty, writePty } from "./pty";
import { loadThemes, parseTheme, saveThemes } from "./themes";
import type { Preset, ProjectConfig, SpawnRequest, ThemesFile } from "./types";

const DEV_SERVER_URL = "http://localhost:5183";
const WINDOW_TITLE = IS_DEV ? "Aya Dev" : "Aya";

// Sets the dock label on macOS. Must happen before the BrowserWindow is created.
if (IS_DEV) {
  app.setName("Aya Dev");
}

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

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    title: WINDOW_TITLE,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0d1117",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // node-pty needs the preload to have node access
    },
  });

  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
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
  win.on("enter-full-screen", () => sendFullScreen(true));
  win.on("leave-full-screen", () => sendFullScreen(false));
  // Initial broadcast once the renderer is ready (also useful if a future
  // restart preserves fullscreen state).
  win.webContents.once("did-finish-load", () => sendFullScreen(win.isFullScreen()));

  // Intercept keyboard shortcuts at the BrowserWindow level so they fire
  // even while xterm.js has focus (otherwise xterm would forward them to the
  // PTY). Calling event.preventDefault() prevents both the page and the
  // default menu from receiving the keystroke.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const isMac = process.platform === "darwin";
    const mod = isMac ? input.meta : input.control;
    if (!mod) return;
    // Don't trigger our shortcuts if extra modifiers we don't bind are held —
    // e.g. Cmd+Shift+T should NOT fire our Cmd+T action.
    if (input.shift || input.alt) return;
    const key = input.key.toLowerCase();
    let action: string | null = null;
    if (key === "t") action = "new-shell";
    else if (key === "w") action = "close-tab";
    else if (key === ",") action = "open-settings";
    else if (key === "[") action = "prev-tab";
    else if (key === "]") action = "next-tab";
    else if (key.length === 1 && key >= "1" && key <= "9") {
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

function registerIpc(win: BrowserWindow): void {
  ipcMain.handle("pty:spawn", async (_e, req: SpawnRequest) => {
    spawnPty(req, win.webContents);
  });
  ipcMain.handle("pty:write", async (_e, ptyId: string, data: string) =>
    writePty(ptyId, data),
  );
  ipcMain.handle(
    "pty:resize",
    async (_e, ptyId: string, cols: number, rows: number) =>
      resizePty(ptyId, cols, rows),
  );
  ipcMain.handle("pty:kill", async (_e, ptyId: string) => killPty(ptyId));

  ipcMain.handle("projects:list", async () => listProjects());
  ipcMain.handle("projects:create", async (_e, name: string, dir: string) =>
    createProject(name, dir),
  );
  ipcMain.handle("projects:update", async (_e, project: ProjectConfig) =>
    updateProject(project),
  );
  ipcMain.handle("projects:delete", async (_e, slug: string) =>
    deleteProject(slug),
  );

  ipcMain.handle("presets:list", async () => listPresets());
  ipcMain.handle("presets:save", async (_e, presets: Preset[]) =>
    savePresets(presets),
  );

  ipcMain.handle("themes:list", async () => loadThemes());
  ipcMain.handle("themes:save", async (_e, file: ThemesFile) =>
    saveThemes(file),
  );
  ipcMain.handle("themes:import", async () => {
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
  ipcMain.handle("env:expand", async (_e, p: string) => expandPath(p));
  ipcMain.handle("env:git", async (_e, directory: string) =>
    getGitInfo(directory),
  );
  ipcMain.handle("env:pick-dir", async () => {
    const result = await dialog.showOpenDialog(win, {
      title: "Pick a project directory",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
  ipcMain.handle("env:dir-exists", async (_e, p: string) => {
    try {
      const stat = await fs.stat(expandPath(p));
      return stat.isDirectory();
    } catch {
      return false;
    }
  });
  ipcMain.handle("env:create-dir", async (_e, p: string) => {
    await fs.mkdir(expandPath(p), { recursive: true });
  });
  ipcMain.handle("app:is-fullscreen", async () => win.isFullScreen());
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

app.whenReady().then(() => {
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

  mainWindow = createWindow();
  registerIpc(mainWindow);

  // Honor an initial directory argument on first launch — the renderer
  // applies the same switch-or-create logic as for second-instance.
  const initialDir = findDirInArgv(process.argv);
  if (initialDir && mainWindow) {
    mainWindow.webContents.once("did-finish-load", () => {
      dispatchOpenProject(mainWindow, initialDir);
    });
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  killAll();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => killAll());
