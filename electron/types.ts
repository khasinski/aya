// Types shared between the Electron main and the renderer via the preload
// context bridge. Keep this file pure type definitions so it can be imported
// from both sides without runtime side-effects.

import type { Snippet } from "./snippets";
import type { HarnessDef } from "./harnesses";
import type {
  HarnessSearchHit,
  HarnessSearchRequest,
} from "./harness-search";
import type { AgentKind, Preset } from "./presets";
import type { BufferSearchHit } from "./pty";
import type { Theme, ThemesFile } from "./themes";
import type { UsageAccount, UsageData } from "./usage";
import type { UsageHookStatus } from "./usage-hook";
import type { StatusHookStatus } from "./status-hook";

export type {
  BufferSearchHit,
  HarnessSearchHit,
  HarnessSearchRequest,
  Snippet,
  HarnessDef,
  Preset,
  Theme,
  ThemesFile,
  UsageData,
  UsageAccount,
  UsageHookStatus,
  StatusHookStatus,
};

import type { SplitNode } from "./split-tree";

export interface WorkingTab {
  id: string;
  presetId: string;
  name: string;
  /** Worktree binding: absolute cwd this tab spawns in. Absent = the project's
   *  own directory. Set when the terminal runs in a git worktree. */
  cwd?: string;
  /** Last session id the agent reported over OSC 9001 (see integrations.md).
   *  Lets a restore resume that exact conversation instead of whatever the
   *  CLI considers "latest". Absent for agents that never report one. */
  sessionId?: string;
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
  /** Legacy flat grid. Read for migration; no longer written. */
  splitLayout?: SplitLayout;
  /** Pane layout as a BSP tree (see electron/split-tree.ts). */
  splitTree?: SplitNode;
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
  /** IPC-response-only (never persisted; the save validator strips it): true
   *  when this state was sliced for a secondary window, so the renderer must
   *  NOT apply the first-run "open everything" fallback to the empty list. */
  secondaryWindow?: boolean;
  /** Active terminal id per project slug, so the selection survives a restart. */
  activeTab?: Record<string, string>;
  /** Per-project single-terminal view: the shown terminal id (absent = all/split). */
  singleView?: Record<string, string>;
}

export interface SpawnRequest {
  ptyId: string;
  projectSlug?: string;
  presetId?: string;
  /** Which agent CLI this pane runs, resolved by the renderer (it owns the
   *  inference — see src/agentPreset.ts). Lets the host pick that agent's
   *  screen-detection rules without duplicating the inference. */
  agent?: AgentKind;
  // The user-resolved command (e.g. "claude", "$SHELL", "aider --dark"). The
  // renderer picks this from the active preset and the main process embeds it
  // verbatim into `$SHELL -l -c 'cd … && exec <command>'`. NEVER -p / --print.
  command: string;
  cwd: string;
  cols: number;
  rows: number;
  // Attach to an existing PTY only - if the host has no session for this id, do
  // NOT spawn a fresh process; emit a `no-session` event instead. Set by the
  // renderer when re-mounting a tab that already ran this session.
  attachOnly?: boolean;
  // Attach-only IF the connected PTY host predates this app session (it was
  // found running, not spawned by us). Set by the renderer for the first mount
  // of a boot-restored tab; PtyHostClient.spawn resolves it into `attachOnly`
  // because only the main-process client knows how the host came to be. On a
  // reused host the tab's session either still lives (attach + replay) or died
  // while the app was away - then the tab shows stopped/restartable instead of
  // silently auto-respawning (the same maintainer decision as for manual host
  // restarts). On a freshly-spawned host this is a no-op: boot auto-start.
  attachIfReused?: boolean;
}

export interface ProjectGitInfo {
  branch: string | null;
  dirty: number;
}

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

/** Outcome of a repository-changing git command. Mirrors electron/git.ts. */
export type GitMutationResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

export interface GitChangedFile {
  status: string;
  path: string;
}

/** A git worktree of a repository (from `git worktree list --porcelain`). */
export interface Worktree {
  /** Absolute path to the worktree checkout. */
  path: string;
  /** Short branch name, or null when detached/bare. */
  branch: string | null;
  /** The primary worktree (the repo's original checkout). */
  isMain: boolean;
  detached: boolean;
  bare: boolean;
  /** Git flagged this worktree as prunable (its gitdir is gone). */
  prunable: boolean;
}

export type SpawnFailureReason =
  | "cwd-missing"
  | "cwd-not-directory"
  | "cwd-unreadable"
  | "preset-empty-command"
  | "agent-config-dir-create-failed"
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
    }
  // Host had no live session for an attach-only spawn (process died while the
  // host stayed up). The tab becomes stopped/restartable, not respawned.
  | { type: "no-session"; ptyId: string }
  // Explicit status parsed from an OSC 9001 `aya.status` sequence the TUI (or
  // a wrapper script) emitted inline in its own output — see integrations.md.
  // Carries the same vocabulary as ControlStatusUpdate's "status" request,
  // just delivered in-band through the PTY stream instead of the control
  // socket.
  | {
      type: "osc-status";
      ptyId: string;
      level: ControlStatusLevel;
      text: string;
      updatedAt: number;
    }
  // Agent session id reported over OSC 9001, persisted so a later restore can
  // resume this exact conversation.
  | { type: "osc-session"; ptyId: string; sessionId: string }
  // Derived from the pane's real rendered screen (electron/vt-state.ts):
  // whether an approval prompt is on screen RIGHT NOW. Unlike the raw-byte
  // heuristic it also reports when the prompt goes away, so it is emitted on
  // both edges.
  | { type: "vt-status"; ptyId: string; waiting: boolean };

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

/** A config file the user can edit, which the renderer reloads when it changes
 *  on disk under ~/.aya/. */
export type ConfigSlice = "snippets" | "presets" | "themes" | "projects";

export interface ConfigChange {
  slice: ConfigSlice;
}

// --- Aya Web (experimental): browser access to Aya ---

export interface WebServerStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  host: string;
  user: string;
  /** Plaintext of the auto-generated password so Settings can show it.
   *  Null once the user sets a custom password (only its hash is stored). */
  generatedPassword: string | null;
  /** URLs the server is reachable at (one per non-internal IPv4 interface). */
  urls: string[];
  /** Currently connected browser clients. */
  clients: number;
  /** Last start failure (e.g. port in use), or null. */
  error: string | null;
}

export interface WebConfigureRequest {
  enabled?: boolean;
  port?: number;
  user?: string;
  /** New custom password; stored as a hash, never echoed back. */
  password?: string;
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
  ptyBuffer(ptyId: string): Promise<string>;
  /** Case-insensitive substring search across every live PTY's recent
   *  output buffer. Returns one hit per matching pty (the first match plus
   *  an extra-occurrences count). */
  ptySearch(query: string): Promise<BufferSearchHit[]>;
  /** Experimental harness-aware search: scans the LOCAL Claude Code / Codex
   *  session transcripts for the tab's cwd (history, not terminal output). */
  harnessSearch(req: HarnessSearchRequest): Promise<HarnessSearchHit[]>;
  restartPtyHost(): Promise<void>;
  onPtyEvent(handler: (event: PtyEvent) => void): () => void;

  // Project config
  listProjects(): Promise<ProjectConfig[]>;
  listProjectState(): Promise<ProjectCollectionState>;
  saveProjectState(state: ProjectCollectionState): Promise<void>;
  /** Other live Aya windows (multi-window "Move to window…" targets). */
  listOtherWindows(): Promise<Array<{ id: number; activeProject: string | null }>>;
  /** Open a project (by directory) in another / a new window. The caller must
   *  have released its own copy first (drop local state, keep PTYs alive).
   *  `at` (screen coords) positions a torn-out NEW window at the release
   *  point, Chrome-tab style. */
  adoptProjectInWindow(
    directory: string,
    target: number | "new",
    at?: { x: number; y: number },
  ): Promise<void>;
  /** Hit-test a drag release point (screen coords) against the live windows:
   *  the source window itself, another window (attach), or empty space (tear
   *  out into a new window). */
  resolveProjectDrop(
    x: number,
    y: number,
  ): Promise<
    { kind: "self" } | { kind: "window"; id: number } | { kind: "new" }
  >;
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

  // Presets (terminal launchers)
  listPresets(): Promise<Preset[]>;
  savePresets(presets: Preset[]): Promise<void>;
  /** Async PATH probe for known agent harnesses. Used to seed first-
   *  launch defaults and to surface "Suggested presets" in Settings. */
  scanHarnesses(): Promise<HarnessDef[]>;

  // Saved snippets (text injected into the active terminal on demand)
  listSnippets(): Promise<Snippet[]>;
  saveSnippets(snippets: Snippet[]): Promise<void>;

  /** Read-only account-wide usage snapshots a user hook writes.
   *  Aya never fetches it — see electron/usage.ts. */
  getUsage(): Promise<UsageAccount[]>;
  /** Read-only Codex usage parsed from its local rollout logs. */
  getCodexUsage(): Promise<UsageAccount[]>;

  // Optional usage-hook installer (writes ~/.claude/settings.json + a fetch
  // script). The Aya process never reads a token or calls the endpoint.
  usageHookStatus(): Promise<UsageHookStatus>;
  installUsageHook(): Promise<UsageHookStatus>;
  uninstallUsageHook(): Promise<UsageHookStatus>;
  statusHookStatus(): Promise<StatusHookStatus>;
  installStatusHook(): Promise<StatusHookStatus>;
  uninstallStatusHook(): Promise<StatusHookStatus>;
  summarizeLocal(req: LocalSummaryRequest): Promise<LocalSummaryResult>;
  ollamaStatus(model?: string): Promise<OllamaStatus>;
  pullOllamaModel(model: string): Promise<OllamaStatus>;

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
  /** Git worktrees for the repo containing `directory` ([] if not a repo). */
  getGitWorktrees(directory: string): Promise<Worktree[]>;
  /** Create a git worktree. Errors are RETURNED, not thrown: the caller shows
   *  git's own message (e.g. "a branch named 'x' already exists"). */
  createWorktree(req: {
    directory: string;
    path: string;
    branch?: string;
    base?: string;
  }): Promise<GitMutationResult>;
  /** Remove a git worktree. `force` discards uncommitted changes in it. */
  removeWorktree(req: {
    directory: string;
    path: string;
    force?: boolean;
  }): Promise<GitMutationResult>;
  /** GitHub URL for the current branch: its PR, else the branch tree page. */
  getGitHubLink(directory: string): Promise<GitHubLink | null>;
  /** True if the `gh` CLI is on PATH. */
  githubCliAvailable(): Promise<boolean>;
  pickDirectory(): Promise<string | null>;
  /** Picks an audio file for the terminal notification chimes. */
  pickSoundFile(): Promise<string | null>;
  /** True if the path exists and is a directory. */
  dirExists(path: string): Promise<boolean>;
  /** `mkdir -p` semantics. Throws if the path can't be created. */
  createDir(path: string): Promise<void>;
  /** Opens a path in the OS file browser. */
  openPath(path: string): Promise<void>;
  /** Opens a safe external URL in the OS default handler. */
  openUrl(url: string): Promise<void>;
  /** Clipboard helpers used by the terminal context menu. */
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;

  // Window state
  isFullScreen(): Promise<boolean>;
  isMaximized(): Promise<boolean>;
  onFullScreenChange(handler: (isFullScreen: boolean) => void): () => void;
  onMaximizedChange(handler: (isMaximized: boolean) => void): () => void;
  /** Sets the macOS dock badge text. Empty string clears. No-op elsewhere. */
  setDockBadge(text: string): Promise<void>;
  /** Brings the aya window to the foreground (restore if minimized). */
  focusWindow(): Promise<void>;
  /** Minimize the window (yellow traffic light). */
  minimizeWindow(): Promise<void>;
  /** Toggle maximized/restored window state. */
  toggleMaximizeWindow(): Promise<void>;
  /** Close the window (red traffic light). */
  closeWindow(): Promise<void>;
  /** Programmatic fullscreen control (used for the green traffic light in FS). */
  setFullScreen(value: boolean): Promise<void>;
  /** Shows a native app notification for a waiting terminal. */
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
  /** Fired when the user clicks a waiting-terminal notification. */
  onTerminalNotificationSelect(
    handler: (selection: TerminalNotificationSelection) => void,
  ): () => void;
  onControlStatus(handler: (update: ControlStatusUpdate) => void): () => void;
  listMonitoredSessions(): Promise<MonitoredSession[]>;
  onUpdateStatus(handler: (status: UpdateStatus) => void): () => void;

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

  // Aya Web (experimental) — browser access to Aya
  webStatus(): Promise<WebServerStatus>;
  configureWeb(req: WebConfigureRequest): Promise<WebServerStatus>;
  regenerateWebPassword(): Promise<WebServerStatus>;
}

declare global {
  interface Window {
    aya: AyaApi;
  }
}
