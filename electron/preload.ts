// Preload — exposes a typed `window.aya` API to the renderer using
// contextBridge. The renderer has no direct Node access.

import { contextBridge, ipcRenderer } from "electron";
import type { AyaApi, ControlStatusUpdate, PtyEvent } from "./types";

const isDev = process.env.AYA_DEV === "1";

const api: AyaApi = {
  isDev,
  ptySpawn: (req) => ipcRenderer.invoke("pty:spawn", req),
  ptyWrite: (ptyId, data) => ipcRenderer.invoke("pty:write", ptyId, data),
  ptyResize: (ptyId, cols, rows) =>
    ipcRenderer.invoke("pty:resize", ptyId, cols, rows),
  ptyKill: (ptyId) => ipcRenderer.invoke("pty:kill", ptyId),
  ptySearch: (query) => ipcRenderer.invoke("pty:search", query),
  onPtyEvent: (handler) => {
    const listener = (_e: unknown, event: PtyEvent) => handler(event);
    ipcRenderer.on("pty:event", listener);
    return () => ipcRenderer.removeListener("pty:event", listener);
  },

  listProjects: () => ipcRenderer.invoke("projects:list"),
  listProjectState: () => ipcRenderer.invoke("projects:state"),
  saveProjectState: (state) =>
    ipcRenderer.invoke("projects:save-state", state),
  createProject: (name, directory) =>
    ipcRenderer.invoke("projects:create", name, directory),
  updateProject: (project) => ipcRenderer.invoke("projects:update", project),
  deleteProject: (slug) => ipcRenderer.invoke("projects:delete", slug),
  readRepoProjectConfig: (directory) =>
    ipcRenderer.invoke("projects:read-repo-config", directory),

  listPresets: () => ipcRenderer.invoke("presets:list"),
  savePresets: (presets) => ipcRenderer.invoke("presets:save", presets),
  scanHarnesses: () => ipcRenderer.invoke("presets:scan-harnesses"),

  listThemes: () => ipcRenderer.invoke("themes:list"),
  saveThemes: (file) => ipcRenderer.invoke("themes:save", file),
  importTheme: () => ipcRenderer.invoke("themes:import"),

  getCwd: () => ipcRenderer.invoke("env:cwd"),
  getHomeDir: () => ipcRenderer.invoke("env:home"),
  expandPath: (p) => ipcRenderer.invoke("env:expand", p),
  completePath: (p) => ipcRenderer.invoke("env:complete-path", p),
  getGitInfo: (directory) => ipcRenderer.invoke("env:git", directory),
  pickDirectory: () => ipcRenderer.invoke("env:pick-dir"),
  dirExists: (p) => ipcRenderer.invoke("env:dir-exists", p),
  createDir: (p) => ipcRenderer.invoke("env:create-dir", p),
  openPath: (p) => ipcRenderer.invoke("env:open-path", p),
  openUrl: (url) => ipcRenderer.invoke("env:open-url", url),

  isFullScreen: () => ipcRenderer.invoke("app:is-fullscreen"),
  setDockBadge: (text) => ipcRenderer.invoke("app:set-dock-badge", text),
  focusWindow: () => ipcRenderer.invoke("app:focus-window"),
  showWaitingNotification: (req) =>
    ipcRenderer.invoke("app:notify-waiting", req),
  cliStatus: () => ipcRenderer.invoke("app:cli-status"),
  installCli: () => ipcRenderer.invoke("app:install-cli"),
  openNotificationSettings: () =>
    ipcRenderer.invoke("app:open-notification-settings"),
  onTerminalNotificationSelect: (handler) => {
    const listener = (
      _e: unknown,
      selection: { projectSlug: string; terminalId: string },
    ) => handler(selection);
    ipcRenderer.on("notification:select-terminal", listener);
    return () =>
      ipcRenderer.removeListener("notification:select-terminal", listener);
  },
  onControlStatus: (handler) => {
    const listener = (_e: unknown, update: ControlStatusUpdate) =>
      handler(update);
    ipcRenderer.on("control:status", listener);
    return () => ipcRenderer.removeListener("control:status", listener);
  },
  onFullScreenChange: (handler) => {
    const listener = (_e: unknown, isFullScreen: boolean) =>
      handler(isFullScreen);
    ipcRenderer.on("app:fullscreen", listener);
    return () => ipcRenderer.removeListener("app:fullscreen", listener);
  },

  onShortcut: (handler) => {
    const listener = (_e: unknown, action: string) => handler(action);
    ipcRenderer.on("shortcut", listener);
    return () => ipcRenderer.removeListener("shortcut", listener);
  },

  onOpenProject: (handler) => {
    const listener = (_e: unknown, directory: string) => handler(directory);
    ipcRenderer.on("open-project", listener);
    return () => ipcRenderer.removeListener("open-project", listener);
  },
};

contextBridge.exposeInMainWorld("aya", api);
