// Preload — exposes a typed `window.aya` API to the renderer using
// contextBridge. The renderer has no direct Node access.

import { contextBridge, ipcRenderer } from "electron";
import type {
  AyaApi,
  ConfigChange,
  ControlStatusUpdate,
  PtyEvent,
  UpdateStatus,
} from "./types";

const isDev = process.env.AYA_DEV === "1";

const api: AyaApi = {
  isDev,
  platform: process.platform,
  ptySpawn: (req) => ipcRenderer.invoke("pty:spawn", req),
  ptyWrite: (ptyId, data) => ipcRenderer.invoke("pty:write", ptyId, data),
  ptyResize: (ptyId, cols, rows) =>
    ipcRenderer.invoke("pty:resize", ptyId, cols, rows),
  ptyKill: (ptyId) => ipcRenderer.invoke("pty:kill", ptyId),
  ptyBuffer: (ptyId) => ipcRenderer.invoke("pty:buffer", ptyId),
  ptySearch: (query) => ipcRenderer.invoke("pty:search", query),
  restartPtyHost: () => ipcRenderer.invoke("pty-host:restart"),
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
  createRemoteProject: (req) =>
    ipcRenderer.invoke("projects:create-remote", req),
  listRemoteDirectory: (sshTarget, directory) =>
    ipcRenderer.invoke("remote:list-directory", sshTarget, directory),
  createRemoteDirectory: (sshTarget, directory) =>
    ipcRenderer.invoke("remote:create-directory", sshTarget, directory),
  listRemotePresets: (sshTarget) =>
    ipcRenderer.invoke("remote:list-presets", sshTarget),
  checkRemoteHealth: (sshTarget) =>
    ipcRenderer.invoke("remote:health", sshTarget),
  createRemoteProjectOnHost: (sshTarget, directory, name) =>
    ipcRenderer.invoke("remote:create-project", sshTarget, directory, name),
  updateProject: (project) => ipcRenderer.invoke("projects:update", project),
  deleteProject: (slug) => ipcRenderer.invoke("projects:delete", slug),
  readRepoProjectConfig: (directory) =>
    ipcRenderer.invoke("projects:read-repo-config", directory),

  listPresets: () => ipcRenderer.invoke("presets:list"),
  savePresets: (presets) => ipcRenderer.invoke("presets:save", presets),
  scanHarnesses: () => ipcRenderer.invoke("presets:scan-harnesses"),

  listSnippets: () => ipcRenderer.invoke("snippets:list"),
  saveSnippets: (snippets) => ipcRenderer.invoke("snippets:save", snippets),

  getUsage: () => ipcRenderer.invoke("usage:get"),
  getCodexUsage: () => ipcRenderer.invoke("usage:get-codex"),
  usageHookStatus: () => ipcRenderer.invoke("usage-hook:status"),
  installUsageHook: () => ipcRenderer.invoke("usage-hook:install"),
  uninstallUsageHook: () => ipcRenderer.invoke("usage-hook:uninstall"),
  summarizeLocal: (req) => ipcRenderer.invoke("local-summary:summarize", req),
  ollamaStatus: (model) => ipcRenderer.invoke("intelligence:ollama-status", model),
  pullOllamaModel: (model) =>
    ipcRenderer.invoke("intelligence:pull-ollama-model", model),
  listMonitoredSessions: () => ipcRenderer.invoke("sessions:list-monitored"),

  listThemes: () => ipcRenderer.invoke("themes:list"),
  saveThemes: (file) => ipcRenderer.invoke("themes:save", file),
  importTheme: () => ipcRenderer.invoke("themes:import"),

  getCwd: () => ipcRenderer.invoke("env:cwd"),
  getHomeDir: () => ipcRenderer.invoke("env:home"),
  expandPath: (p) => ipcRenderer.invoke("env:expand", p),
  completePath: (p) => ipcRenderer.invoke("env:complete-path", p),
  getGitInfo: (directory) => ipcRenderer.invoke("env:git", directory),
  getGitChangedFiles: (directory) =>
    ipcRenderer.invoke("env:git-changed-files", directory),
  getGitDiff: (directory) => ipcRenderer.invoke("env:git-diff", directory),
  getGitHubLink: (directory) =>
    ipcRenderer.invoke("env:github-link", directory),
  githubCliAvailable: () => ipcRenderer.invoke("env:github-cli-available"),
  pickDirectory: () => ipcRenderer.invoke("env:pick-dir"),
  dirExists: (p) => ipcRenderer.invoke("env:dir-exists", p),
  createDir: (p) => ipcRenderer.invoke("env:create-dir", p),
  openPath: (p) => ipcRenderer.invoke("env:open-path", p),
  openUrl: (url) => ipcRenderer.invoke("env:open-url", url),
  readClipboard: () => ipcRenderer.invoke("env:clipboard-read"),
  writeClipboard: (text) => ipcRenderer.invoke("env:clipboard-write", text),

  isFullScreen: () => ipcRenderer.invoke("app:is-fullscreen"),
  isMaximized: () => ipcRenderer.invoke("app:is-maximized"),
  setDockBadge: (text) => ipcRenderer.invoke("app:set-dock-badge", text),
  focusWindow: () => ipcRenderer.invoke("app:focus-window"),
  minimizeWindow: () => ipcRenderer.invoke("app:minimize"),
  toggleMaximizeWindow: () => ipcRenderer.invoke("app:toggle-maximize"),
  closeWindow: () => ipcRenderer.invoke("app:close"),
  setFullScreen: (value: boolean) => ipcRenderer.invoke("app:set-fullscreen", value),
  showWaitingNotification: (req) =>
    ipcRenderer.invoke("app:notify-waiting", req),
  cliStatus: () => ipcRenderer.invoke("app:cli-status"),
  installCli: () => ipcRenderer.invoke("app:install-cli"),
  getDiagnostics: () => ipcRenderer.invoke("app:diagnostics"),
  getUpdateStatus: () => ipcRenderer.invoke("updates:status"),
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  installUpdate: () => ipcRenderer.invoke("updates:install"),
  openNotificationSettings: () =>
    ipcRenderer.invoke("app:open-notification-settings"),
  micStatus: () => ipcRenderer.invoke("mic:status"),
  requestMicAccess: () => ipcRenderer.invoke("mic:request"),
  openMicrophoneSettings: () => ipcRenderer.invoke("mic:open-settings"),
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
  onUpdateStatus: (handler) => {
    const listener = (_e: unknown, status: UpdateStatus) => handler(status);
    ipcRenderer.on("updates:status", listener);
    return () => ipcRenderer.removeListener("updates:status", listener);
  },
  onFullScreenChange: (handler) => {
    const listener = (_e: unknown, isFullScreen: boolean) =>
      handler(isFullScreen);
    ipcRenderer.on("app:fullscreen", listener);
    return () => ipcRenderer.removeListener("app:fullscreen", listener);
  },
  onMaximizedChange: (handler) => {
    const listener = (_e: unknown, isMaximized: boolean) =>
      handler(isMaximized);
    ipcRenderer.on("app:maximized", listener);
    return () => ipcRenderer.removeListener("app:maximized", listener);
  },
  onConfigChange: (handler) => {
    const listener = (_e: unknown, change: ConfigChange) => handler(change);
    ipcRenderer.on("config:changed", listener);
    return () => ipcRenderer.removeListener("config:changed", listener);
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
