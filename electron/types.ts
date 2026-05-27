// Types shared between the Electron main and the renderer via the preload
// context bridge. Keep this file pure type definitions so it can be imported
// from both sides without runtime side-effects.

import type { HarnessDef } from "./harnesses";
import type { Preset } from "./presets";
import type { BufferSearchHit } from "./pty";
import type { Theme, ThemesFile } from "./themes";

export type { BufferSearchHit, HarnessDef, Preset, Theme, ThemesFile };

export interface WorkingTab {
  id: string;
  presetId: string;
  name: string;
}

export interface ProjectConfig {
  slug: string;
  name: string;
  directory: string;
  tabs: WorkingTab[];
}

export interface ProjectCollectionState {
  version: 1;
  order: string[];
  open: string[];
  recent: string[];
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

export type SpawnFailureReason =
  | "cwd-missing"
  | "cwd-not-directory"
  | "cwd-unreadable"
  | "preset-empty-command"
  | "command-not-found"
  | "node-pty-spawn-error";

export type PtyEvent =
  | { type: "data"; ptyId: string; chunk: string }
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

export type ControlStatusLevel = "active" | "waiting" | "done" | "error";

export interface ControlStatusUpdate {
  terminalId?: string;
  projectSlug?: string;
  cwd?: string;
  level: ControlStatusLevel | "clear";
  text?: string;
  updatedAt: number;
}

// What the preload exposes to window.aya:
export interface AyaApi {
  /** True when running under `npm run dev` (AYA_DEV=1). False in the packaged
   *  Aya.app. Use to show a "dev" indicator and keep the user's dogfooded
   *  state in ~/.aya/ from being touched. */
  isDev: boolean;

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

  // Presets (terminal launchers)
  listPresets(): Promise<Preset[]>;
  savePresets(presets: Preset[]): Promise<void>;
  /** Async PATH probe for known agent harnesses. Used to seed first-
   *  launch defaults and to surface "Suggested presets" in Settings. */
  scanHarnesses(): Promise<HarnessDef[]>;

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
  pickDirectory(): Promise<string | null>;
  /** True if the path exists and is a directory. */
  dirExists(path: string): Promise<boolean>;
  /** `mkdir -p` semantics. Throws if the path can't be created. */
  createDir(path: string): Promise<void>;
  /** Opens a path in the OS file browser. */
  openPath(path: string): Promise<void>;
  /** Opens an http/https URL in the OS default browser. */
  openUrl(url: string): Promise<void>;

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
}

declare global {
  interface Window {
    aya: AyaApi;
  }
}
