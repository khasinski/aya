// Aya windows: creation, focus, fullscreen and the shared target for outside opens.

import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";
import * as path from "node:path";
import { isInternalNavigationUrl, parseExternalUrl } from "./navigation";
import { replayOpensOnLoad } from "./open-delivery";
import type { PtyHostClient } from "./pty-host-client";
import { singleFlight } from "./single-flight";
import { installWindowZoom } from "./zoom";

// Minimum dimensions of the main application window (px)
const WINDOW_MIN_WIDTH = 800;
const WINDOW_MIN_HEIGHT = 500;
// Cascade offset for a window opened from another window (File > New Window,
// tab tear-out), so it doesn't cover its parent exactly.
const NEW_WINDOW_CASCADE_OFFSET_PX = 28;
const TEAR_OUT_CURSOR_OFFSET_X_PX = 80;
const TEAR_OUT_CURSOR_OFFSET_Y_PX = 20;
// macOS needs a moment after fullscreen transitions before the window hack
// can be re-applied.
const MACOS_FULLSCREEN_HACK_DELAY_MS = 250;

/** The window an outside action lands in: the existing one, else one made once for every caller arriving meanwhile;
 *  while Aya quits there is none, since an open acked then would be lost with the process. */
export function createWindowSource<W>(
  existing: () => W | null,
  create: () => Promise<W>,
  quitting: () => boolean = () => false,
): {
  forOpen: () => Promise<W>;
  createOnce: () => Promise<W>;
} {
  const made = singleFlight(create);
  const createOnce = async (): Promise<W> => {
    if (quitting()) throw new Error("Aya is quitting; run it again once it has quit");
    return made();
  };
  return { forOpen: async () => (quitting() ? createOnce() : (existing() ?? createOnce())), createOnce };
}

export interface WindowGeometry {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isFullScreen: boolean;
  isMaximized: boolean;
}

export interface AyaWindowsDeps {
  BrowserWindow: {
    new(options: BrowserWindowConstructorOptions): BrowserWindow;
    getFocusedWindow(): BrowserWindow | null;
  };
  ptyHost: Pick<PtyHostClient, "attachWebContents" | "detachWebContents">;
  platform: NodeJS.Platform;
  mainDirname: string;
  windowTitle: string;
  darkBackground: string;
  isDev: boolean;
  isE2eHeadless: boolean;
  devServerUrl: string;
  rendererIndexPath: string;
  maxKeyboardProjects: number;
  loadWindowState: () => Promise<WindowGeometry>;
  trackWindowState: (win: BrowserWindow) => unknown;
  startConfigWatcher: (win: BrowserWindow) => () => void;
  openExternalUrl: (url: string) => Promise<void>;
  claimBootWindow: (windowId: number) => void;
  releaseWindowSlices: (windowId: number) => Promise<void>;
  onWindowClosed?: (webContentsId: number) => void;
  quitting: () => boolean;
  loadMacOsWindowHack?: () => { apply(handle: Buffer): void };
}

export function createAyaWindows(deps: AyaWindowsDeps) {
  const {
    BrowserWindow, ptyHost, platform, mainDirname, loadWindowState,
    trackWindowState, startConfigWatcher, openExternalUrl,
    windowTitle: WINDOW_TITLE, darkBackground: COLOR_DARK_BG,
    isDev: IS_DEV, isE2eHeadless: IS_E2E_HEADLESS,
    devServerUrl: DEV_SERVER_URL, rendererIndexPath: RENDERER_INDEX_PATH,
    maxKeyboardProjects: MAX_KEYBOARD_PROJECTS,
  } = deps;

  let macosWindowHack:
    | {
        apply(handle: Buffer): void;
      }
    | null
    | undefined;

  function applyMacOsWindowHack(win: BrowserWindow): void {
    if (platform !== "darwin" || win.isDestroyed()) return;
    if (macosWindowHack === undefined) {
      try {
        macosWindowHack = (deps.loadMacOsWindowHack ?? (() => require(path.join(mainDirname, "macos-window-hack.node"))))() as {
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
  }, deps.quitting);

  /** Set once startup has created its own first window. */
  let startupWindowCreated = false;

  function eachAyaWindow(fn: (win: BrowserWindow) => void): void {
    for (const win of ayaWindows) {
      if (!win.isDestroyed()) fn(win);
    }
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
      ...(platform === "darwin"
        ? { titleBarStyle: "hidden" as const }
        : {}),
      ...(platform === "linux"
        ? { frame: false, roundedCorners: false }
        : {}),
      backgroundColor: COLOR_DARK_BG,
      show: false,
      webPreferences: {
        // One file from vite.preload.config.mts: a sandboxed preload cannot require its own modules.
        preload: path.join(mainDirname, "preload.bundle.js"),
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

    if (platform === "darwin") {
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
    deps.claimBootWindow(win.id);
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
      deps.onWindowClosed?.(windowWebContents.id);
      // Keep the module-level ref in sync so second-instance handlers don't
      // try to focus a destroyed window.
      if (mainWindow === win) {
        mainWindow = [...ayaWindows].at(-1) ?? null;
      }
      ptyHost.detachWebContents(windowWebContents);
      stopConfigWatcher();
      // The closed window's projects fall back to recent; PTYs keep running in
      // the detached host (same contract as an app restart).
      void deps.releaseWindowSlices(windowId);
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
      const isMac = platform === "darwin";
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

  return {
    ayaWindows,
    get mainWindow() { return mainWindow; },
    set mainWindow(win: BrowserWindow | null) { mainWindow = win; },
    get startupWindowCreated() { return startupWindowCreated; },
    set startupWindowCreated(value: boolean) { startupWindowCreated = value; },
    focusedAyaWindow,
    eachAyaWindow,
    createWindow,
    openNewWindow,
    createWindowOnce,
    windowForOpen,
    applyMacOsWindowHack,
    isAyaFullScreen,
    setAyaFullScreen,
    toggleAyaFullScreen,
  };
}
