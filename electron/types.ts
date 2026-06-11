// Types shared between the Electron main and the renderer via the preload
// context bridge. Keep this file pure type definitions so it can be imported
// from both sides without runtime side-effects.

import type { Snippet } from "./snippets";
import type { HarnessDef } from "./harnesses";
import type { Preset } from "./presets";
import type { BufferSearchHit } from "./pty";
import type { Theme, ThemesFile } from "./themes";
import type { UsageData } from "./usage";
import type { UsageHookStatus } from "./usage-hook";

export type {
  BufferSearchHit,
  Snippet,
  HarnessDef,
  Preset,
  Theme,
  ThemesFile,
  UsageData,
  UsageHookStatus,
};

export interface WorkingTab {
  id: string;
  presetId: string;
  name: string;
}

export interface SplitLayout {
  rows: number;
  cols: number;
  rowFr: number[];
  colFr: number[];
  cells: (string | null)[];
  activeCell: number;
}

export interface ProjectConfig {
  slug: string;
  name: string;
  directory: string;
  tabs: WorkingTab[];
  splitLayout?: SplitLayout;
}

export interface RepoProjectConfig {
  presets: Preset[];
}

export interface ProjectCollectionState {
  version: 1;
  order: string[];
  open: string[];
  recent: string[];
  /** Last active project (slug), restored on boot. Optional for back-compat. */
  activeProject?: string | null;
  /** Active terminal id per project slug, so the selection survives a restart. */
  activeTab?: Record<string, string>;
  /** Per-project single-terminal view: the shown terminal id (absent = all/split). */
  singleView?: Record<string, string>;
}

export interface SpawnRequest {
  ptyId: string;
  projectSlug?: string;
  presetId?: string;
  // The user-resolved command (e.g. "claude", "$SHELL", "aider --dark"). The
  // renderer picks this from the active preset and the main process embeds it
  // verbatim into `$SHELL -l -c 'cd … && exec <command>'`. NEVER -p / --print.
  command: string;
  cwd: string;
  cols: number;
  rows: number;
}

export interface ProjectGitInfo {
  branch: string | null;
  dirty: number;
}

export interface GitChangedFile {
  status: string;
  path: string;
}

export type SpawnFailureReason =
  | "cwd-missing"
  | "cwd-not-directory"
  | "cwd-unreadable"
  | "preset-empty-command"
  | "command-not-found"
  | "node-pty-spawn-error";

export type PtyEvent =
  | { type: "data"; ptyId: string; chunk: string; replay?: boolean }
  | { type: "exit"; ptyId: string; exitCode: number }
  | {
      type: "spawn-failed";
      ptyId: string;
      reason: SpawnFailureReason;
      detail: string;
    };

export interface WaitingNotificationRequest {
  projectSlug: string;
  terminalId: string;
  body: string;
}

export interface TerminalNotificationSelection {
  projectSlug: string;
  terminalId: string;
}

export interface CliStatus {
  installed: boolean;
  path: string | null;
  installDir: string | null;
  installable: boolean;
  message?: string;
}

/** macOS microphone authorization, surfaced read-only in Settings. Maps the
 *  Electron getMediaAccessStatus values; "unsupported" on non-macOS. */
export type MicPermissionStatus =
  | "not-determined"
  | "granted"
  | "denied"
  | "restricted"
  | "unknown"
  | "unsupported";

export type ControlStatusLevel = "active" | "waiting" | "done" | "error";

export interface ControlStatusUpdate {
  terminalId?: string;
  projectSlug?: string;
  cwd?: string;
  level: ControlStatusLevel | "clear";
  text?: string;
  updatedAt: number;
}

/** A config file the user can edit, which the renderer reloads when it changes
 *  on disk under ~/.aya/. */
export type ConfigSlice = "snippets" | "presets" | "themes" | "projects";

export interface ConfigChange {
  slice: ConfigSlice;
}

// What the preload exposes to window.aya:
export interface AyaApi {
  /** True when running under `npm run dev` (AYA_DEV=1). False in the packaged
   *  Aya.app. Use to show a "dev" indicator and keep the user's dogfooded
   *  state in ~/.aya/ from being touched. */
  isDev: boolean;
  platform: NodeJS.Platform;

  // PTY lifecycle
  ptySpawn(req: SpawnRequest): Promise<void>;
  ptyWrite(ptyId: string, data: string): Promise<void>;
  ptyResize(ptyId: string, cols: number, rows: number): Promise<void>;
  ptyKill(ptyId: string): Promise<void>;
  /** Case-insensitive substring search across every live PTY's recent
   *  output buffer. Returns one hit per matching pty (the first match plus
   *  an extra-occurrences count). */
  ptySearch(query: string): Promise<BufferSearchHit[]>;
  onPtyEvent(handler: (event: PtyEvent) => void): () => void;

  // Project config
  listProjects(): Promise<ProjectConfig[]>;
  listProjectState(): Promise<ProjectCollectionState>;
  saveProjectState(state: ProjectCollectionState): Promise<void>;
  createProject(name: string, directory: string): Promise<ProjectConfig>;
  updateProject(project: ProjectConfig): Promise<void>;
  deleteProject(slug: string): Promise<void>;
  readRepoProjectConfig(directory: string): Promise<RepoProjectConfig | null>;

  // Presets (terminal launchers)
  listPresets(): Promise<Preset[]>;
  savePresets(presets: Preset[]): Promise<void>;
  /** Async PATH probe for known agent harnesses. Used to seed first-
   *  launch defaults and to surface "Suggested presets" in Settings. */
  scanHarnesses(): Promise<HarnessDef[]>;

  // Saved snippets (text injected into the active terminal on demand)
  listSnippets(): Promise<Snippet[]>;
  saveSnippets(snippets: Snippet[]): Promise<void>;

  /** Read-only account-wide usage snapshot a user hook writes (null if none).
   *  Aya never fetches it — see electron/usage.ts. */
  getUsage(): Promise<UsageData | null>;
  /** Read-only Codex usage parsed from its local rollout logs (null if none). */
  getCodexUsage(): Promise<UsageData | null>;

  // Optional usage-hook installer (writes ~/.claude/settings.json + a fetch
  // script). The Aya process never reads a token or calls the endpoint.
  usageHookStatus(): Promise<UsageHookStatus>;
  installUsageHook(): Promise<UsageHookStatus>;
  uninstallUsageHook(): Promise<UsageHookStatus>;

  // Themes (terminal color schemes — xterm.js ITheme shape internally)
  listThemes(): Promise<ThemesFile>;
  saveThemes(file: ThemesFile): Promise<void>;
  /** Opens a file picker for .itermcolors / .json, parses, returns the
   *  imported Theme — caller adds it to the list and persists. */
  importTheme(): Promise<Theme | null>;

  // Environment + git
  getCwd(): Promise<string>;
  getHomeDir(): Promise<string>;
  expandPath(path: string): Promise<string>;
  completePath(pathPrefix: string): Promise<string[]>;
  getGitInfo(directory: string): Promise<ProjectGitInfo>;
  getGitChangedFiles(directory: string): Promise<GitChangedFile[]>;
  getGitDiff(directory: string): Promise<string>;
  pickDirectory(): Promise<string | null>;
  /** True if the path exists and is a directory. */
  dirExists(path: string): Promise<boolean>;
  /** `mkdir -p` semantics. Throws if the path can't be created. */
  createDir(path: string): Promise<void>;
  /** Opens a path in the OS file browser. */
  openPath(path: string): Promise<void>;
  /** Opens an http/https URL in the OS default browser. */
  openUrl(url: string): Promise<void>;
  /** Clipboard helpers used by the terminal context menu. */
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;

  // Window state
  isFullScreen(): Promise<boolean>;
  onFullScreenChange(handler: (isFullScreen: boolean) => void): () => void;
  /** Sets the macOS dock badge text. Empty string clears. No-op elsewhere. */
  setDockBadge(text: string): Promise<void>;
  /** Brings the aya window to the foreground (restore if minimized). */
  focusWindow(): Promise<void>;
  /** Shows a native app notification for a waiting terminal. */
  showWaitingNotification(req: WaitingNotificationRequest): Promise<void>;
  cliStatus(): Promise<CliStatus>;
  installCli(): Promise<CliStatus>;
  openNotificationSettings(): Promise<void>;
  /** Current macOS microphone authorization (read-only; "unsupported" off-mac). */
  micStatus(): Promise<MicPermissionStatus>;
  /** Triggers the system mic prompt when status is not-determined; resolves to
   *  whether access is granted. No-op (returns current grant) otherwise. */
  requestMicAccess(): Promise<boolean>;
  /** Opens System Settings > Privacy & Security > Microphone (the real toggle). */
  openMicrophoneSettings(): Promise<void>;
  /** Fired when the user clicks a waiting-terminal notification. */
  onTerminalNotificationSelect(
    handler: (selection: TerminalNotificationSelection) => void,
  ): () => void;
  onControlStatus(handler: (update: ControlStatusUpdate) => void): () => void;

  /** Subscribe to keyboard shortcuts dispatched by the main process. Returns
   *  an unsubscribe function. Action strings: "new-shell", "close-tab",
   *  "search", "open-settings", "prev-tab", "next-tab",
   *  "project-1".."project-9". */
  onShortcut(handler: (action: string) => void): () => void;

  /** Subscribe to "open this project directory" requests from main — fired
   *  on first launch with argv and on every second-instance invocation. */
  onOpenProject(handler: (directory: string) => void): () => void;

  /** Fired when something outside the app edits one of the watched config files
   *  (snippets/presets/themes) under ~/.aya/. The renderer reloads that slice
   *  so an edit made by hand isn't overwritten by the next save in the app. */
  onConfigChange(handler: (change: ConfigChange) => void): () => void;
}

declare global {
  interface Window {
    aya: AyaApi;
  }
}
