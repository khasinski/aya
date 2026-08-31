// Aya Web (experimental) — window.aya implemented over the WebSocket bridge.
//
// Mirrors electron/preload.ts: every invoke-style method forwards
// (channel, args) to the server, which dispatches to the same ipcMain
// handlers the desktop renderer uses. Window-scoped and host-native calls
// (window chrome, native dialogs, clipboard, notifications) are stubbed or
// re-implemented with browser equivalents here, so the server never needs a
// BrowserWindow for a web session.

import type { AyaApi, ControlStatusUpdate, PtyEvent } from "../types";
import { shortcutForKey } from "./shortcuts";
import type { WebTransport } from "./transport";

async function readClipboardWeb(): Promise<string> {
  // navigator.clipboard needs a secure context; plain-HTTP Aya Web over the
  // LAN doesn't have one. Keyboard paste still works (xterm handles the
  // browser's native paste event) — only menu-driven paste degrades.
  try {
    return await navigator.clipboard.readText();
  } catch {
    return "";
  }
}

async function writeClipboardWeb(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Insecure context / permission denied — legacy fallback below.
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}

const isMacClient = /Mac/i.test(navigator.platform);

export function createWebAya(transport: WebTransport): AyaApi {
  // Promise<never> is assignable to every Promise<T>, so each member below
  // still gets full "does this method exist on AyaApi" checking.
  const inv =
    (channel: string) =>
    (...args: unknown[]) =>
      transport.invoke(channel, args) as Promise<never>;
  const on =
    <T>(channel: string) =>
    (handler: (payload: T) => void) =>
      transport.onEvent(channel, handler as (payload: unknown) => void);
  const noopAsync = async () => undefined as never;
  const noopSubscription = () => () => {};

  const api: AyaApi = {
    isDev: transport.hello.isDev,
    platform: transport.hello.platform as NodeJS.Platform,

    ptySpawn: inv("pty:spawn"),
    ptyWrite: inv("pty:write"),
    ptyResize: inv("pty:resize"),
    ptyKill: inv("pty:kill"),
    ptyBuffer: inv("pty:buffer"),
    ptyCwd: inv("pty:cwd"),
    ptySearch: inv("pty:search"),
    harnessSearch: inv("harness:search"),
    restartPtyHost: inv("pty-host:restart"),
    onPtyEvent: on<PtyEvent>("pty:event"),

    listProjects: inv("projects:list"),
    listProjectState: inv("projects:state"),
    saveProjectState: inv("projects:save-state"),
    // Multi-window is a desktop concept; the web client is its own world.
    listOtherWindows: async () => [] as never,
    adoptProjectInWindow: async () => {
      throw new Error("Multi-window is not available in Aya Web");
    },
    resolveProjectDrop: async () => ({ kind: "self" }) as never,
    createProject: inv("projects:create"),
    createRemoteProject: inv("projects:create-remote"),
    listRemoteDirectory: inv("remote:list-directory"),
    createRemoteDirectory: inv("remote:create-directory"),
    listRemotePresets: inv("remote:list-presets"),
    checkRemoteHealth: inv("remote:health"),
    createRemoteProjectOnHost: inv("remote:create-project"),
    updateProject: inv("projects:update"),
    deleteProject: inv("projects:delete"),
    readRepoProjectConfig: inv("projects:read-repo-config"),

    listPresets: inv("presets:list"),
    savePresets: inv("presets:save"),
    scanHarnesses: inv("presets:scan-harnesses"),

    listSnippets: inv("snippets:list"),
    saveSnippets: inv("snippets:save"),

    getUsage: inv("usage:get"),
    getCodexUsage: inv("usage:get-codex"),
    usageHookStatus: inv("usage-hook:status"),
    installUsageHook: inv("usage-hook:install"),
    uninstallUsageHook: inv("usage-hook:uninstall"),
    statusHookStatus: inv("status-hook:status"),
    installStatusHook: inv("status-hook:install"),
    uninstallStatusHook: inv("status-hook:uninstall"),
    summarizeLocal: inv("local-summary:summarize"),
    ollamaStatus: inv("intelligence:ollama-status"),
    pullOllamaModel: inv("intelligence:pull-ollama-model"),
    listMonitoredSessions: inv("sessions:list-monitored"),

    listThemes: inv("themes:list"),
    saveThemes: inv("themes:save"),
    // Native file picker — not available in the browser.
    importTheme: async () => null as never,

    getCwd: inv("env:cwd"),
    getHomeDir: inv("env:home"),
    expandPath: inv("env:expand"),
    completePath: inv("env:complete-path"),
    getGitInfo: inv("env:git"),
    getGitChangedFiles: inv("env:git-changed-files"),
    getGitDiff: inv("env:git-diff"),
    getGitWorktrees: inv("env:git-worktrees"),
    getGitRoot: inv("env:git-root"),
    getGitWorktreeStatus: inv("env:git-worktree-status"),
    getGitHubLink: inv("env:github-link"),
    githubCliAvailable: inv("env:github-cli-available"),
    // Repository mutations stay on the desktop app, where the user can see the
    // result and the confirmation prompt.
    createWorktree: async () => ({ ok: false, error: "Not available in Aya Web" }),
    removeWorktree: async () => ({ ok: false, error: "Not available in Aya Web" }),
    // Native pickers — a browser session can't drive the host's file dialogs.
    pickDirectory: async () => null,
    pickSoundFile: async () => null,
    dirExists: inv("env:dir-exists"),
    createDir: inv("env:create-dir"),
    // Opening the HOST's file browser from a remote session is meaningless.
    openPath: noopAsync,
    openUrl: async (url: string) => {
      window.open(url, "_blank", "noopener");
    },
    readClipboard: () => readClipboardWeb() as Promise<never>,
    writeClipboard: (text: string) =>
      writeClipboardWeb(text) as Promise<never>,

    // Window chrome — no window to manage in a browser tab.
    isFullScreen: async () => false as never,
    isMaximized: async () => false as never,
    setDockBadge: noopAsync,
    focusWindow: noopAsync,
    minimizeWindow: noopAsync,
    toggleMaximizeWindow: noopAsync,
    closeWindow: noopAsync,
    setFullScreen: noopAsync,
    showWaitingNotification: noopAsync,
    cliStatus: inv("app:cli-status"),
    installCli: inv("app:install-cli"),
    getDiagnostics: inv("app:diagnostics"),
    getUpdateStatus: inv("updates:status"),
    checkForUpdates: inv("updates:check"),
    installUpdate: inv("updates:install"),
    openNotificationSettings: noopAsync,
    micStatus: inv("mic:status"),
    requestMicAccess: inv("mic:request"),
    openMicrophoneSettings: noopAsync,
    onTerminalNotificationSelect: on("notification:select-terminal"),
    onControlStatus: on<ControlStatusUpdate>("control:status"),
    onUpdateStatus: on("updates:status"),
    // No GPU helper process in a browser session (#79 is desktop-only).
    onGpuRelaunched: noopSubscription,
    // Omarchy skinning is desktop/Linux-only.
    omarchyStatus: async () => ({ available: false, themeName: null }),
    getOmarchyTheme: async () => null,
    onOmarchyThemeChange: noopSubscription,
    onFullScreenChange: noopSubscription,
    onMaximizedChange: noopSubscription,
    onConfigChange: on("config:changed"),

    onShortcut: (handler) => {
      const listener = (e: KeyboardEvent) => {
        const action = shortcutForKey(e, isMacClient);
        if (!action) return;
        e.preventDefault();
        handler(action);
      };
      window.addEventListener("keydown", listener);
      return () => window.removeEventListener("keydown", listener);
    },

    onOpenProject: on("open-project"),

    webStatus: inv("web:status"),
    configureWeb: inv("web:configure"),
    regenerateWebPassword: inv("web:regenerate-password"),
  };
  return api;
}
