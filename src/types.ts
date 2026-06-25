// Renderer types. Mirrors the electron-side definitions; we keep these in two
// places (here and electron/types.ts) so the two TS projects stay independent.

export interface Preset {
  id: string;
  name: string;
  icon: string;
  color: string; // hex or "" for default
  command: string;
  agent?: "claude" | "codex" | "custom";
  configDir?: string;
  unsafeMode?: boolean;
  autoResume?: boolean;
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

/** Account-wide Claude/Codex usage snapshot (mirrors electron/usage.ts).
 *  Written by a user hook, read-only in Aya. Numbers are account-global —
 *  all sessions share the 5h + weekly limits, never per-project. */
export interface UsageWindow {
  pct: number;
  resetsAt?: string;
}
export interface UsageData {
  fiveHour: UsageWindow;
  sevenDay: UsageWindow;
  updatedAt: string;
}
export interface UsageAccount {
  id: string;
  label: string;
  usage: UsageData;
}

/** State of the optional usage-hook installer (mirrors electron/usage-hook.ts). */
export interface UsageHookStatus {
  installed: boolean;
  scriptPath: string;
  settingsPath: string;
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
  remote?: {
    hostId: string;
    label: string;
    sshTarget: string;
    directory: string;
  };
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

export interface ProjectGitInfo {
  branch: string | null;
  dirty: number;
}

/** Overall window layout. "classic": project tabs on top + terminal list on
 *  the left. "projects-left": project tabs in a left rail + terminal tabs on
 *  top. The two are rendered by separate, self-contained layout components. */
export type LayoutMode = "classic" | "projects-left";

export type GitHubLinkKind = "pr" | "branch";

/** A GitHub URL for the active project's current branch: its open PR, or the
 *  branch's tree page when there is no PR. Resolved via the `gh` CLI. */
export interface GitHubLink {
  kind: GitHubLinkKind;
  url: string;
}

export interface RemoteHostInfo {
  id: string;
  name: string;
  platform: NodeJS.Platform;
  user: string;
}

export interface RemoteDirectoryEntry {
  name: string;
  path: string;
  kind: "directory";
}

export interface RemoteDirectoryListing {
  host: RemoteHostInfo;
  presets: Preset[];
  recentProjects: ProjectConfig[];
  path: string;
  entries: RemoteDirectoryEntry[];
}

export interface RemoteProjectCreateResult {
  host: RemoteHostInfo;
  presets: Preset[];
  project: ProjectConfig;
}

export type RemoteHealthStage = "ssh" | "node" | "aya-remote" | "snapshot";

export interface RemoteHealthCheck {
  stage: RemoteHealthStage;
  ok: boolean;
  message: string;
}

export interface RemoteHealthResult {
  ok: boolean;
  sshTarget: string;
  checkedAt: string;
  checks: RemoteHealthCheck[];
  host?: RemoteHostInfo;
  presetsCount?: number;
  recentProjectsCount?: number;
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
  | "agent-config-dir-create-failed"
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

export type AyaIntelligenceProvider = "apple" | "ollama" | "openai";

export interface AyaIntelligenceConfig {
  provider: AyaIntelligenceProvider;
  ollamaModel: string;
  openAiBaseUrl: string;
  openAiApiKey: string;
  openAiModel: string;
}

export interface OllamaStatus {
  installed: boolean;
  running: boolean;
  path: string | null;
  models: string[];
  recommendedModel: string;
  recommendedModelInstalled: boolean;
  message?: string;
}

export interface LocalSummaryRequest {
  kind: "terminal" | "project";
  lines: string[];
  intelligence?: AyaIntelligenceConfig;
}

export interface LocalSummaryResult {
  available: boolean;
  useful: boolean;
  summary: string;
  error?: string;
}

export interface CliStatus {
  installed: boolean;
  path: string | null;
  installDir: string | null;
  installable: boolean;
  message?: string;
}

export interface DiagnosticsReport {
  generatedAt: string;
  app: {
    version: string;
    mode: "development" | "production";
    platform: NodeJS.Platform;
    arch: string;
    pid: number;
    cwd: string;
  };
  paths: {
    ayaHome: string;
    controlSocket: string;
    remoteSocket: string;
    ptyHostSocket: string;
    controlSocketExists: boolean;
    remoteSocketExists: boolean;
    ptyHostSocketExists: boolean;
  };
  shell: {
    shell: string | null;
    pathEntries: string[];
  };
  cli: CliStatus;
  ptyHost: {
    expected: { version: string; scriptHash: string };
    actual: { version: string; scriptHash: string } | null;
    ptyCount: number;
    stale: boolean;
  };
  presets: Array<{
    id: string;
    name: string;
    agent: Preset["agent"];
    command: string;
    configDir?: string;
    autoResume?: boolean;
    unsafeMode?: boolean;
  }>;
  projects: {
    total: number;
    open: number;
    recent: number;
    remote: number;
  };
  usage: {
    claudeAccounts: number;
    codexAccounts: number;
    hookInstalled: boolean;
    hookScriptPath: string;
  };
}

export type UpdateStatusPhase =
  | "unsupported"
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error";

export interface UpdateStatus {
  phase: UpdateStatusPhase;
  supported: boolean;
  currentVersion: string;
  availableVersion?: string;
  downloadedVersion?: string;
  percent?: number;
  message?: string;
  checkedAt?: string;
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

export type MonitoredSessionLevel = ControlStatusLevel;

export interface MonitoredSession {
  id: string;
  source: string;
  cwd: string;
  projectName?: string;
  sessionName?: string;
  level: MonitoredSessionLevel;
  text: string;
  updatedAt: number;
}

export interface BufferSearchHit {
  ptyId: string;
  snippet: string;
  matchStart: number;
  matchLength: number;
  more: number;
}

/** A config file the user can edit, which the renderer reloads when it changes
 *  on disk under ~/.aya/. */
export type ConfigSlice = "snippets" | "presets" | "themes" | "projects";

export interface ConfigChange {
  slice: ConfigSlice;
}

export interface AyaApi {
  /** True under `npm run dev` (AYA_DEV=1). */
  isDev: boolean;
  platform: NodeJS.Platform;

  ptySpawn(req: SpawnRequest): Promise<void>;
  ptyWrite(ptyId: string, data: string): Promise<void>;
  ptyResize(ptyId: string, cols: number, rows: number): Promise<void>;
  ptyKill(ptyId: string): Promise<void>;
  ptyBuffer(ptyId: string): Promise<string>;
  ptySearch(query: string): Promise<BufferSearchHit[]>;
  restartPtyHost(): Promise<void>;
  onPtyEvent(handler: (event: PtyEvent) => void): () => void;

  listProjects(): Promise<ProjectConfig[]>;
  listProjectState(): Promise<ProjectCollectionState>;
  saveProjectState(state: ProjectCollectionState): Promise<void>;
  createProject(name: string, directory: string): Promise<ProjectConfig>;
  createRemoteProject(req: {
    name: string;
    directory: string;
    hostId: string;
    label: string;
    sshTarget: string;
  }): Promise<ProjectConfig>;
  listRemoteDirectory(
    sshTarget: string,
    directory?: string,
  ): Promise<RemoteDirectoryListing>;
  createRemoteDirectory(
    sshTarget: string,
    directory: string,
  ): Promise<string>;
  listRemotePresets(sshTarget: string): Promise<Preset[]>;
  checkRemoteHealth(sshTarget: string): Promise<RemoteHealthResult>;
  createRemoteProjectOnHost(
    sshTarget: string,
    directory: string,
    name?: string,
  ): Promise<RemoteProjectCreateResult>;
  updateProject(project: ProjectConfig): Promise<void>;
  deleteProject(slug: string): Promise<void>;
  readRepoProjectConfig(directory: string): Promise<RepoProjectConfig | null>;

  listPresets(): Promise<Preset[]>;
  savePresets(presets: Preset[]): Promise<void>;
  scanHarnesses(): Promise<HarnessDef[]>;

  listSnippets(): Promise<Snippet[]>;
  saveSnippets(snippets: Snippet[]): Promise<void>;

  /** Read-only account-wide usage snapshots. */
  getUsage(): Promise<UsageAccount[]>;
  /** Read-only Codex usage from its local rollout logs. */
  getCodexUsage(): Promise<UsageAccount[]>;

  usageHookStatus(): Promise<UsageHookStatus>;
  installUsageHook(): Promise<UsageHookStatus>;
  uninstallUsageHook(): Promise<UsageHookStatus>;
  summarizeLocal(req: LocalSummaryRequest): Promise<LocalSummaryResult>;
  ollamaStatus(model?: string): Promise<OllamaStatus>;
  pullOllamaModel(model: string): Promise<OllamaStatus>;
  listMonitoredSessions(): Promise<MonitoredSession[]>;

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
  getGitHubLink(directory: string): Promise<GitHubLink | null>;
  githubCliAvailable(): Promise<boolean>;
  pickDirectory(): Promise<string | null>;
  dirExists(path: string): Promise<boolean>;
  createDir(path: string): Promise<void>;
  openPath(path: string): Promise<void>;
  openUrl(url: string): Promise<void>;
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;

  isFullScreen(): Promise<boolean>;
  isMaximized(): Promise<boolean>;
  setDockBadge(text: string): Promise<void>;
  focusWindow(): Promise<void>;
  /** Minimize the window (yellow traffic light). */
  minimizeWindow(): Promise<void>;
  /** Toggle maximized/restored window state. */
  toggleMaximizeWindow(): Promise<void>;
  /** Close the window (red traffic light). */
  closeWindow(): Promise<void>;
  /** Programmatic fullscreen control (used for the green traffic light in FS). */
  setFullScreen(value: boolean): Promise<void>;
  showWaitingNotification(req: WaitingNotificationRequest): Promise<void>;
  cliStatus(): Promise<CliStatus>;
  installCli(): Promise<CliStatus>;
  getDiagnostics(): Promise<DiagnosticsReport>;
  getUpdateStatus(): Promise<UpdateStatus>;
  checkForUpdates(): Promise<UpdateStatus>;
  installUpdate(): Promise<void>;
  openNotificationSettings(): Promise<void>;
  /** Current macOS microphone authorization (read-only; "unsupported" off-mac). */
  micStatus(): Promise<MicPermissionStatus>;
  /** Triggers the system mic prompt when status is not-determined; resolves to
   *  whether access is granted. No-op (returns current grant) otherwise. */
  requestMicAccess(): Promise<boolean>;
  /** Opens System Settings > Privacy & Security > Microphone (the real toggle). */
  openMicrophoneSettings(): Promise<void>;
  onTerminalNotificationSelect(
    handler: (selection: TerminalNotificationSelection) => void,
  ): () => void;
  onControlStatus(handler: (update: ControlStatusUpdate) => void): () => void;
  onUpdateStatus(handler: (status: UpdateStatus) => void): () => void;
  onFullScreenChange(handler: (isFullScreen: boolean) => void): () => void;
  onMaximizedChange(handler: (isMaximized: boolean) => void): () => void;

  /** Action strings include "new-shell", "close-tab", "search",
   *  "open-settings", "prev-tab", "next-tab", and "project-1".."project-9". */
  onShortcut(handler: (action: string) => void): () => void;
  onOpenProject(handler: (directory: string) => void): () => void;

  /** Fired when something outside the app edits one of the watched config files
   *  under ~/.aya/, so the renderer can reload that slice instead of
   *  overwriting the edit on the next save in the app. */
  onConfigChange(handler: (change: ConfigChange) => void): () => void;
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
  /** Tab added by an external config edit (#4): kept out of the hidden
   *  TerminalView pool so no PTY spawns until the terminal first becomes
   *  visible (sidebar activation or split assignment clears the flag). */
  spawnDeferred?: boolean;
  /** PTY was killed by a host restart (#28), not by a real exit. Renders as
   *  stopped + restartable (Shift+Enter) without faking a clean exit code, so
   *  it never shows as a "done"/successful finish. Cleared on restart. */
  stopped?: boolean;
  /** Restored from a persisted project tab, not newly created by the user.
   *  Agent presets may append --resume only in this case. */
  restored?: boolean;
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
