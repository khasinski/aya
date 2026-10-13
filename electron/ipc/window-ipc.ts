// Window IPC: the window chrome (full screen, maximize, minimize, close, reload) and moving a project between
// windows (other windows, where a dropped tab lands, adopting a project, the open-project handshake).

import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { requireString } from "../validation";
import { resolveDropTarget } from "../window-slices";

export interface WindowIpcDeps {
  ipcMain: Pick<IpcMain, "handle" | "on">;
  senderWindow: (e: IpcMainInvokeEvent) => BrowserWindow | null;
  /** Every Aya window, in creation order. */
  windows: () => Iterable<BrowserWindow>;
  /** The project a window last saved as active, for "Move to window…" labels. */
  activeProjectOf: (windowId: number) => string | null;
  openNewWindow: (at?: { x: number; y: number }) => Promise<BrowserWindow>;
  /** Hands a directory to a window's open-project flow (switch to, create, or ignore). */
  openProjectIn: (win: BrowserWindow, directory: string) => void;
  /** The renderer finished an open-project request. */
  confirmOpen: (sender: WebContents, directory: string) => void;
  isFullScreen: (win: BrowserWindow) => boolean;
  setFullScreen: (win: BrowserWindow, value: boolean) => void;
}

export function registerWindowIpc(deps: WindowIpcDeps): void {
  const { ipcMain, senderWindow } = deps;
  const liveWindows = () => [...deps.windows()].filter((w) => !w.isDestroyed());

  // Multi-window: targets for "Move to window…" (every live window but the
  // caller, labeled by its last-saved active project).
  ipcMain.handle("windows:list-others", async (e) => {
    const self = senderWindow(e);
    return liveWindows()
      .filter((w) => w !== self)
      .map((w) => ({
        id: w.id,
        activeProject: deps.activeProjectOf(w.id),
      }));
  });
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
      const candidates = liveWindows()
        .filter((w) => w.isVisible())
        .map((w) => ({ id: w.id, bounds: w.getBounds(), isSelf: w === self }));
      return resolveDropTarget(x, y, candidates);
    },
  );
  // Adopt a (released) project into another window - the source renderer drops
  // its local state first (WITHOUT killing PTYs), then calls this; the target
  // window runs the ordinary switch-or-create open flow and re-attaches to the
  // live PTYs exactly like after an app restart.
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
        win = await deps.openNewWindow(dropAt);
      } else if (typeof target === "number") {
        win = liveWindows().find((w) => w.id === target) ?? null;
      }
      if (!win) throw new Error("windows:adopt-project: target window not found");
      if (win.isMinimized()) win.restore();
      win.focus();
      deps.openProjectIn(win, dir);
    },
  );
  ipcMain.on("open-project:done", (event, dir: unknown) => {
    if (typeof dir === "string") deps.confirmOpen(event.sender, dir);
  });

  ipcMain.handle("app:is-fullscreen", async (e) => {
    const win = senderWindow(e);
    return win ? deps.isFullScreen(win) : false;
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
    if (win) deps.setFullScreen(win, !!value);
  });
  // The window's error screen reloads through here: a location.reload() from the page started and
  // was cancelled (measured in e2e, Electron 43), while webContents.reload() is not. Aya Web reloads
  // in its own page, so a stub event (sender: null) is a no-op.
  ipcMain.handle("window:reload", (e) => {
    e.sender?.reload();
  });
}
