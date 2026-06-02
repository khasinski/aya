// Renderer types. Mirrors the electron-side definitions; we keep these in two
// places (here and electron/types.ts) so the two TS projects stay independent.

export interface Preset {
  id: string;
  name: string;
  icon: string;
  color: string; // hex or "" for default
  command: string;
  /** Optional per-preset theme override. Empty/undefined means use the
   *  global active theme. */
  themeId?: string;
}

export interface HarnessDef {
  id: string;
  binary: string;
  name: string;
  icon: string;
  color: string;
  command: string;
}

/** A reusable text snippet the user injects into the active terminal (à la
 *  iTerm2 Snippets). Lives in Aya (editor side), not in an agent's prompt — so
 *  it doesn't sit in the agent's context until actually sent. `autoRun`
 *  appends Enter to execute. */
export interface Snippet {
  id: string;
  name: string;
  text: string;
  autoRun: boolean;
}

export interface ThemeColors {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent?: string;
  selectionBackground?: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface Theme {
  id: string;
  name: string;
  colors: ThemeColors;
}

export interface ThemesFile {
  themes: Theme[];
  activeId: string;
}

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

export interface SpawnRequest {
  ptyId: string;
  projectSlug?: string;
  presetId?: string;
  command: string;
  cwd: string;
  cols: number;
  rows: number;
}

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

export type ControlStatusLevel = "active" | "waiting" | "done" | "error";

export interface ControlStatusUpdate {
  terminalId?: string;
  projectSlug?: string;
  cwd?: string;
  level: ControlStatusLevel | "clear";
  text?: string;
  updatedAt: number;
}

export interface BufferSearchHit {
  ptyId: string;
  snippet: string;
  matchStart: number;
  matchLength: number;
  more: number;
}

export interface AyaApi {
  /** True under `npm run dev` (AYA_DEV=1). */
  isDev: boolean;
  platform: NodeJS.Platform;

  ptySpawn(req: SpawnRequest): Promise<void>;
  ptyWrite(ptyId: string, data: string): Promise<void>;
  ptyResize(ptyId: string, cols: number, rows: number): Promise<void>;
  ptyKill(ptyId: string): Promise<void>;
  ptySearch(query: string): Promise<BufferSearchHit[]>;
  onPtyEvent(handler: (event: PtyEvent) => void): () => void;

  listProjects(): Promise<ProjectConfig[]>;
  listProjectState(): Promise<ProjectCollectionState>;
  saveProjectState(state: ProjectCollectionState): Promise<void>;
  createProject(name: string, directory: string): Promise<ProjectConfig>;
  updateProject(project: ProjectConfig): Promise<void>;
  deleteProject(slug: string): Promise<void>;
  readRepoProjectConfig(directory: string): Promise<RepoProjectConfig | null>;

  listPresets(): Promise<Preset[]>;
  savePresets(presets: Preset[]): Promise<void>;
  scanHarnesses(): Promise<HarnessDef[]>;

  listSnippets(): Promise<Snippet[]>;
  saveSnippets(snippets: Snippet[]): Promise<void>;

  listThemes(): Promise<ThemesFile>;
  saveThemes(file: ThemesFile): Promise<void>;
  importTheme(): Promise<Theme | null>;

  getCwd(): Promise<string>;
  getHomeDir(): Promise<string>;
  expandPath(path: string): Promise<string>;
  completePath(pathPrefix: string): Promise<string[]>;
  getGitInfo(directory: string): Promise<ProjectGitInfo>;
  getGitChangedFiles(directory: string): Promise<GitChangedFile[]>;
  getGitDiff(directory: string): Promise<string>;
  pickDirectory(): Promise<string | null>;
  dirExists(path: string): Promise<boolean>;
  createDir(path: string): Promise<void>;
  openPath(path: string): Promise<void>;
  openUrl(url: string): Promise<void>;

  isFullScreen(): Promise<boolean>;
  setDockBadge(text: string): Promise<void>;
  focusWindow(): Promise<void>;
  showWaitingNotification(req: WaitingNotificationRequest): Promise<void>;
  cliStatus(): Promise<CliStatus>;
  installCli(): Promise<CliStatus>;
  openNotificationSettings(): Promise<void>;
  onTerminalNotificationSelect(
    handler: (selection: TerminalNotificationSelection) => void,
  ): () => void;
  onControlStatus(handler: (update: ControlStatusUpdate) => void): () => void;
  onFullScreenChange(handler: (isFullScreen: boolean) => void): () => void;

  /** Action strings include "new-shell", "close-tab", "search",
   *  "open-settings", "prev-tab", "next-tab", and "project-1".."project-9". */
  onShortcut(handler: (action: string) => void): () => void;
  onOpenProject(handler: (directory: string) => void): () => void;
}

declare global {
  interface Window {
    aya: AyaApi;
  }
}

export type TerminalStatus = "running" | "idle" | "waiting" | "error";

export interface TerminalState {
  id: string;
  projectSlug: string;
  presetId: string;
  name: string;
  cwd: string;
  status: TerminalStatus;
  bell: boolean;
  exitCode: number | null;
  spawnFailure?: {
    reason: SpawnFailureReason;
    detail: string;
  };
  externalStatus?: {
    level: ControlStatusLevel;
    text: string;
    updatedAt: number;
  };
}

export type ProjectEventLevel = "info" | "active" | "waiting" | "done" | "error";

export interface ProjectEvent {
  id: string;
  projectSlug: string;
  terminalId?: string;
  level: ProjectEventLevel;
  title: string;
  detail?: string;
  createdAt: number;
}

// Fallback used in the sidebar/pane header when a tab references a preset
// that no longer exists (e.g. the user deleted it).
export const MISSING_PRESET: Preset = {
  id: "__missing__",
  name: "missing preset",
  icon: "?",
  color: "",
  command: "$SHELL",
};

// Always-available shell preset. Used when the user has explicitly removed
// their own "shell" preset but the Cmd+T shortcut still needs to open a
// shell terminal. Same shape as the shipped default; not persisted.
export const BUILTIN_SHELL: Preset = {
  id: "shell",
  name: "Shell",
  icon: "$",
  color: "",
  command: "$SHELL",
};

export function getPreset(presets: Preset[], id: string): Preset {
  const found = presets.find((p) => p.id === id);
  if (found) return found;
  // Special-case "shell" so terminals created via Cmd+T always render with a
  // sensible icon/name even if the user deleted their shell preset.
  if (id === "shell") return BUILTIN_SHELL;
  return MISSING_PRESET;
}

/** Slugify a name into a preset id. */
export function presetSlug(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "preset";
}

/** Match heuristic for commands that look like they've been switched to
 *  non-interactive Claude mode. Shown as a warning in Settings; not blocked. */
export function looksNonInteractive(command: string): boolean {
  return /(?:^|\s)(-p|--print|--headless|--non-interactive|--no-interactive)(?:\s|$|=)/.test(
    command,
  );
}
