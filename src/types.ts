// Renderer types. Mirrors the electron-side definitions; we keep these in two
// places (here and electron/types.ts) so the two TS projects stay independent.

/** Agent CLIs Aya knows how to classify and resume. "custom" is anything
 *  else - a plain shell, a script, an agent we have no resume story for. */
export type AgentKind =
  | "claude"
  | "codex"
  | "opencode"
  | "kilo"
  | "pi"
  | "cursor"
  | "copilot"
  | "grok"
  | "droid"
  | "devin"
  | "kimi"
  | "hermes"
  | "qodercli"
  | "antigravity"
  | "custom";

export interface Preset {
  id: string;
  name: string;
  icon: string;
  color: string; // hex or "" for default
  command: string;
  agent?: AgentKind;
  configDir?: string;
  unsafeMode?: boolean;
  autoResume?: boolean;
  /** Opt-in: tell the agent that `aya` exists, through its harness's channel
   *  (electron/agent-brief.ts). Harnesses without a channel ignore it. */
  agentBrief?: boolean;
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
 *  iTerm2 Snippets). Lives in Aya (editor side), not in an agent's prompt - so
 *  it doesn't sit in the agent's context until actually sent. `autoRun`
 *  appends Enter to execute. */
export interface Snippet {
  id: string;
  name: string;
  text: string;
  autoRun: boolean;
}

/** Account-wide Claude/Codex usage snapshot (mirrors electron/usage.ts).
 *  Written by a user hook, read-only in Aya. Numbers are account-global -
 *  all sessions share the 5h + weekly limits, never per-project. */
export interface UsageWindow {
  pct: number;
  resetsAt?: string;
}
export interface UsageData {
  /** Optional: newer Codex plans expose only a single (weekly) window. */
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  updatedAt: string;
}
export interface UsageAccount {
  id: string;
  label: string;
  usage: UsageData;
}

/** Mirror of electron/usage-grok.ts. */
export interface GrokLimit {
  pct: number;
  resetsAt: string;
  updatedAt: string;
}

export interface GrokUsage {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  /** Cost in Grok's own unit: 1e-10 USD ("ticks"). USD = ticks * 1e-10. */
  costUsdTicks: number;
  turns: number;
  models: string[];
  updatedAt: string;
  limit?: GrokLimit;
}

/** State of the optional usage-hook installer (mirrors electron/usage-hook.ts). */
export interface UsageHookStatus {
  installed: boolean;
  scriptPath: string;
  settingsPath: string;
}

/** State of the optional automatic-status hook installer (#38, mirrors
 *  electron/status-hook.ts). */
export interface StatusHookStatus {
  installed: boolean;
  scriptPath: string;
  settingsPath: string;
  /** Codex half of the same toggle (#38): its `notify` program. Absent when the
   *  main process couldn't determine it. `configured` = ours is set; `conflict`
   *  = the user already has their own notify, which we left untouched. */
  codex?: {
    configured: boolean;
    conflict: boolean;
    configPath: string;
  };
}

/** A semantic color palette, the shape of an Omarchy theme's colors.toml. Drives
 *  BOTH the app chrome (CSS vars) and the terminal (ThemeColors) through one
 *  mapping (see src/theme-skin.ts). snake_case toml keys are normalized to
 *  camelCase; only background/foreground/accent are guaranteed, the rest have
 *  mapping fallbacks. */
export interface OmarchyPalette {
  mode: "dark" | "light";
  accent: string;
  selection?: string;
  muted?: string;
  background: string;
  darkBackground?: string;
  darkerBackground?: string;
  lighterBackground?: string;
  foreground: string;
  darkForeground?: string;
  lightForeground?: string;
  brightForeground?: string;
  red?: string;
  yellow?: string;
  orange?: string;
  green?: string;
  cyan?: string;
  blue?: string;
  magenta?: string;
  brown?: string;
  brightRed?: string;
  brightYellow?: string;
  brightGreen?: string;
  brightCyan?: string;
  brightBlue?: string;
  brightMagenta?: string;
}

export interface OmarchyTheme {
  name: string;
  palette: OmarchyPalette;
}

export interface OmarchyStatus {
  /** The current Omarchy theme's colors.toml exists (Omarchy installed and a
   *  theme active). Always false off Linux. */
  available: boolean;
  /** Human-facing current theme name, or null when unavailable. */
  themeName: string | null;
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

import type { SplitNode } from "./split-tree";
import { PRESET_ID_SHELL } from "./preset-ids";

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
  /** A same-agent pane has shared this folder once, kept: with no session id
   *  the pane starts fresh, not on the folder's "latest". */
  sharedDir?: true;
  /** Opened for a team role: every launch is widened to reach Aya, unless Aya may not lift the block. */
  teamLaunch?: boolean;
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
  /** Pane layout as a BSP tree (see src/split-tree.ts). */
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

/** A worktree plus its live state, for the status bar's checkout picker.
 *  `dirty` is 0 for a repo with a single worktree (nothing to pick between, so
 *  the per-worktree status calls are skipped) and for prunable/bare ones. */
export interface WorktreeStatus extends Worktree {
  dirty: number;
}

export type SpawnFailureReason =
  | "cwd-missing"
  | "cwd-not-directory"
  | "cwd-unreadable"
  | "preset-empty-command"
  | "agent-config-dir-create-failed"
  | "command-not-found"
  | "node-pty-spawn-error";

/** What a pane spawns: `command`, and `sharedDirCommand` when a peer in `peerCwds` is in the same folder. */
export type SpawnCommand = Pick<SpawnRequest, "command" | "sharedDirCommand" | "peerCwds">;

export interface SpawnRequest {
  ptyId: string;
  projectSlug?: string;
  presetId?: string;
  /** Which agent CLI this pane runs, resolved by the renderer (it owns the
   *  inference - see src/agentPreset.ts). Lets the host pick that agent's
   *  screen-detection rules without duplicating the inference. */
  agent?: AgentKind;
  /** The preset's config dir, where claude registers its session per pid. */
  agentConfigDir?: string;
  command: string;
  /** Run instead of `command` when a pane in `peerCwds` is in the same
   *  folder; the host compares real paths. */
  sharedDirCommand?: string;
  peerCwds?: string[];
  cwd: string;
  cols: number;
  rows: number;
  /** Attach to an existing PTY only - do NOT start a fresh process if the host
   *  has no session for this id. Used when re-mounting a tab that already ran
   *  this session: if its PTY died, surface a stopped/restartable state via a
   *  `no-session` event instead of silently spawning a brand-new process. */
  attachOnly?: boolean;
  /** Attach-only IF the PTY host predates this app session (the main-process
   *  client found it running instead of spawning it - only the client can
   *  tell, so it resolves this into attachOnly). Set on the first mount of a
   *  boot-restored tab: on a reused host the session either still lives
   *  (attach + replay) or died while the app was away - then the tab shows
   *  stopped/restartable instead of silently auto-respawning. On a fresh
   *  host this is a no-op and boot auto-start is unchanged. */
  attachIfReused?: boolean;
  /** A pane Aya opened for a team role: launched widened to reach Aya, or as is when
   *  electron/launch-mode.ts teamLaunch refuses. */
  teamLaunch?: boolean;
}

export type PtyEvent =
  | { type: "data"; ptyId: string; chunk: string; replay?: boolean }
  | { type: "exit"; ptyId: string; exitCode: number }
  | {
      type: "spawn-failed";
      ptyId: string;
      reason: SpawnFailureReason;
      detail: string;
    }
  // Host had no live session for an attach-only spawn: the process died while
  // the host stayed up. The tab becomes stopped/restartable, not respawned.
  | { type: "no-session"; ptyId: string }
  // Explicit status parsed from an OSC 9001 `aya.status` sequence the TUI (or
  // a wrapper script) emitted inline in its own output - see integrations.md.
  // Same vocabulary as ControlStatusUpdate's "status" request, delivered
  // in-band through the PTY stream instead of the control socket.
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
  // both edges. `dialog` names a dialog Aya tells apart (an account-wide offer).
  | { type: "vt-status"; ptyId: string; waiting: boolean; dialog?: string };

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
  /** Every `aya` on PATH in PATH order; `path` is the first. */
  copies?: { path: string; ours: boolean; broken: boolean }[];
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
  /** Per harness: panes Aya launched vs panes that ever called `aya` (#117). */
  cliAdoption: Array<{
    agent: string;
    panesLaunched: number;
    panesThatCalledAya: number;
    panesThatRanCapabilities: number;
  }>;
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
    agentBrief?: boolean;
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
  /** A previous in-app update silently failed to install and rolled back
   *  (#78). Sticky: it rides on EVERY status until an update actually applies,
   *  because the startup auto-check replaces `phase`/`message` 12 s after the
   *  reconcile wrote them, and Settings is usually opened long after that. */
  rollbackNotice?: string;
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

/** A question the agent asked before Aya was closed: read back ("restored"), or no longer confirmed by the pane's
 *  session ("unconfirmed": shown to the user, holds no round). */
export type QuestionRestart = "restored" | "unconfirmed";

/** Panes whose agent ran `aya status waiting`, by pane id: its text, when (epoch ms), and whether it was asked
 *  before Aya was closed (electron/agent-status.ts: "unconfirmed" holds no round). */
export type WaitingPanes = Record<string, { text: string; since: number; restart?: QuestionRestart; on?: string }>;

/** `aya status waiting --on <role>`: a team role waits on a teammate, not on the user (no bell, no attention). */
export const WAITING_ON = "waiting-on";

/** What an agent reported, as the windows hold it: "waiting" needs the user, "waiting-on" names the teammate in `on`. */
export type ReportedStatusLevel = ControlStatusLevel | typeof WAITING_ON;

export interface ControlStatusUpdate {
  terminalId?: string;
  projectSlug?: string;
  cwd?: string;
  level: ReportedStatusLevel | "clear";
  text?: string;
  updatedAt: number;
  restart?: QuestionRestart;
  on?: string;
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

/** Experimental harness-aware search (FindBar "History" mode): request to
 *  search the LOCAL Claude Code / Codex session transcripts for a tab's cwd. */
export interface HarnessSearchRequest {
  agent: "claude" | "codex";
  cwd: string;
  /** Preset's config-dir override (may be ~-relative). */
  configDir?: string;
  /** Preset's command, for an inline CODEX_HOME=... there. */
  command?: string;
  query: string;
}

export interface HarnessSearchHit {
  sessionId: string;
  role: "user" | "assistant";
  /** ISO timestamp of the matched message, when the transcript carried one. */
  timestamp?: string;
  /** Full message text (capped) - shown when the user expands the hit. */
  text: string;
  snippet: string;
  /** Offset/length of the first matched token WITHIN the snippet. */
  matchStart: number;
  matchLength: number;
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

export interface AyaApi {
  /** True under `npm run dev` (AYA_DEV=1). */
  isDev: boolean;
  platform: NodeJS.Platform;

  ptySpawn(req: SpawnRequest): Promise<void>;
  ptyWrite(ptyId: string, data: string): Promise<void>;
  ptyResize(ptyId: string, cols: number, rows: number): Promise<void>;
  ptyKill(ptyId: string): Promise<void>;
  ptyBuffer(ptyId: string): Promise<string>;
  /** Live cwd of a terminal's process - where the console actually is after a
   *  `cd`, not the cwd Aya spawned it with. null when it can't be read (old
   *  PTY host, dead process, unsupported platform). */
  ptyCwd(ptyId: string): Promise<string | null>;
  ptySearch(query: string): Promise<BufferSearchHit[]>;
  /** Experimental harness-aware search: scans the LOCAL Claude Code / Codex
   *  session transcripts for the tab's cwd (history, not terminal output). */
  harnessSearch(req: HarnessSearchRequest): Promise<HarnessSearchHit[]>;
  restartPtyHost(): Promise<void>;
  /** Asks first when the pane shows background tasks or monitors a restart stops; false: the user kept it. */
  confirmPaneRestart(ptyId: string): Promise<boolean>;
  onPtyEvent(handler: (event: PtyEvent) => void): () => void;

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
  readRepoProjectConfig(directory: string): Promise<RepoProjectConfig | null>;

  listPresets(): Promise<Preset[]>;
  /** The questions agents asked the user (`aya status waiting`) that nobody has answered, by pane, kept across restarts. */
  agentWaiting(): Promise<WaitingPanes>;
  savePresets(presets: Preset[]): Promise<void>;
  scanHarnesses(): Promise<HarnessDef[]>;

  listSnippets(): Promise<Snippet[]>;
  saveSnippets(snippets: Snippet[]): Promise<void>;

  /** Read-only account-wide usage snapshots. */
  getUsage(): Promise<UsageAccount[]>;
  /** Read-only Codex usage from its local rollout logs. */
  getCodexUsage(): Promise<UsageAccount[]>;
  /** Grok usage (tokens + cost, last 7 days, account-wide), or null when none. */
  getGrokUsage(): Promise<GrokUsage | null>;
  /** Start a team: unpause, send every role a delivery test, arm its rounds. */
  teamStart(projectSlug: string, team: string, task?: string, to?: string): Promise<TeamStartResult>;
  teamPause(projectSlug: string, team: string): Promise<void>;
  teamRemove(projectSlug: string, team: string): Promise<void>;
  teamList(projectSlug: string): Promise<TeamSummary[]>;
  /** Save team: writes .aya/teams/<name>.md and the snapshot Aya runs on.
   *  `create`: refuse when a team with this name already exists. */
  teamSave(projectSlug: string, team: TeamDefinition, create?: boolean): Promise<void>;
  /** Gives a role a pane (null frees it) and tells the agent; returns why it was not told. */
  teamAssign(projectSlug: string, team: string, role: string, paneId: string | null): Promise<string | null>;
  /** A closed tab gives up its roles in every team of the project. */
  teamReleasePane(projectSlug: string, paneId: string): Promise<void>;
  /** Drafts a role of the team as the editor holds it, with Aya Intelligence. */
  teamDraftRole(team: TeamDefinition, roleId: string, intelligence: AyaIntelligenceConfig): Promise<RoleDraft>;
  teamResume(projectSlug: string, team: string): Promise<void>;
  /** The presets, each with whether its CLI is installed (aya presets). */
  teamPresets(): Promise<PresetChoice[]>;
  /** Gives each role a new session or an existing pane (aya team open --replace). */
  /** `release`: roles left without a pane, applied with the picks after they pass the check. */
  teamOpenPanes(projectSlug: string, team: string, panes: PanePick[], release?: string[]): Promise<RolePanes>;
  /** Main asks this window to add panes as tabs; answer with teamPanesOpened. */
  onTeamOpenPanes(handler: (request: TeamOpenPanesRequest) => void): () => void;
  teamPanesOpened(requestId: string, error: string | null): Promise<void>;

  usageHookStatus(): Promise<UsageHookStatus>;
  installUsageHook(): Promise<UsageHookStatus>;
  uninstallUsageHook(): Promise<UsageHookStatus>;
  statusHookStatus(): Promise<StatusHookStatus>;
  installStatusHook(): Promise<StatusHookStatus>;
  uninstallStatusHook(): Promise<StatusHookStatus>;
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
  /** Root of the checkout containing `directory` (a worktree's own root), or
   *  null outside a repo. */
  getGitRoot(directory: string): Promise<string | null>;
  /** Worktrees of the repo containing `directory`, each with branch + dirty
   *  count (dirty is 0 when the repo has a single worktree). */
  getGitWorktreeStatus(directory: string): Promise<WorktreeStatus[]>;
  getGitHubLink(directory: string): Promise<GitHubLink | null>;
  githubCliAvailable(): Promise<boolean>;
  pickDirectory(): Promise<string | null>;
  pickSoundFile(): Promise<string | null>;
  dirExists(path: string): Promise<boolean>;
  createDir(path: string): Promise<void>;
  openPath(path: string): Promise<void>;
  openUrl(url: string): Promise<void>;
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;

  isFullScreen(): Promise<boolean>;
  isMaximized(): Promise<boolean>;
  setDockBadge(text: string): Promise<void>;
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
  /** The GPU helper process died and Chromium is relaunching it (#79); fired a
   *  beat later so visible terminals can re-run their WebGL/PTY repair. */
  onGpuRelaunched(handler: () => void): () => void;
  /** Whether Omarchy is installed with an active theme (chrome+terminal skin). */
  omarchyStatus(): Promise<OmarchyStatus>;
  /** The current Omarchy theme (name + palette), or null when unavailable. */
  getOmarchyTheme(): Promise<OmarchyTheme | null>;
  /** Fires when the active Omarchy theme changes (omarchy-theme-set). */
  onOmarchyThemeChange(handler: () => void): () => void;
  onFullScreenChange(handler: (isFullScreen: boolean) => void): () => void;
  onMaximizedChange(handler: (isMaximized: boolean) => void): () => void;

  /** Action strings include "new-shell", "close-tab", "search",
   *  "open-settings", "prev-tab", "next-tab", and "project-1".."project-9". */
  onShortcut(handler: (action: string) => void): () => void;
  onOpenProject(handler: (directory: string) => void): () => void;
  openProjectDone(directory: string): void;

  /** Fired when something outside the app edits one of the watched config files
   *  under ~/.aya/, so the renderer can reload that slice instead of
   *  overwriting the edit on the next save in the app. */
  onConfigChange(handler: (change: ConfigChange) => void): () => void;

  // Aya Web (experimental) - browser access to Aya
  webStatus(): Promise<WebServerStatus>;
  configureWeb(req: WebConfigureRequest): Promise<WebServerStatus>;
  regenerateWebPassword(): Promise<WebServerStatus>;
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
    level: ReportedStatusLevel;
    text: string;
    updatedAt: number;
    restart?: QuestionRestart;
    /** The teammate a "waiting-on" status names. */
    on?: string;
  };
  /** The screen's dialog while Aya names it (vt-status `dialog`): what the waiting line says instead of a generic ask. */
  screenDialog?: string;
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
  /** Opened for a team role (WorkingTab.teamLaunch). */
  teamLaunch?: boolean;
  /** Last session id the agent reported over OSC 9001, mirrored from (and
   *  persisted back to) the project's WorkingTab so a restore can resume this
   *  exact conversation. */
  sessionId?: string;
  /** Mirrors WorkingTab.sharedDir. */
  sharedDir?: true;
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
const MISSING_PRESET: Preset = {
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
  id: PRESET_ID_SHELL,
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
  if (id === PRESET_ID_SHELL) return BUILTIN_SHELL;
  return MISSING_PRESET;
}

/** Must stay identical to electron/text.ts slugifyName, fallback included:
 *  the renderer predicts main's slug. Pinned by tests/slug-parity.test.mjs. */
export function slugifyName(name: string, fallback: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

/** Slugify a name into a preset id. */
export function presetSlug(name: string): string {
  return slugifyName(name, "preset");
}

/** Match heuristic for commands that look like they've been switched to
 *  non-interactive Claude mode. Shown as a warning in Settings; not blocked. */
export function looksNonInteractive(command: string): boolean {
  return /(?:^|\s)(-p|--print|--headless|--non-interactive|--no-interactive)(?:\s|$|=)/.test(
    command,
  );
}

/** One `role=target` of aya team open / the Teams window's Apply: a preset id
 *  (a new session), "this" (the calling pane), or a pane id or name. */
export interface PanePick {
  role: string;
  target: string;
}

/** A preset as aya presets lists it: installed as the pane spawn checks it. */
export interface PresetChoice {
  id: string;
  name: string;
  agent: AgentKind;
  installed: boolean;
  /** Whether a pane Aya opens for a role from this preset reaches Aya. */
  reach: LaunchReach;
  /** Why Aya refuses to open one, when it does. */
  cantReach: string | null;
}

export type LaunchReach = "reaches" | "blocked" | "unknown";

/** A pane main asks the window to open, with the id main picked. */
export interface NewPane {
  id: string;
  presetId: string;
  name: string;
  /** Opened for a team role: launched widened to reach Aya where Aya may (SpawnRequest.teamLaunch). */
  teamLaunch: boolean;
}

export interface TeamOpenPanesRequest {
  requestId: string;
  projectSlug: string;
  panes: NewPane[];
}

/** The pane a role got: `preset` names a new session's preset, null an existing
 *  pane; `notReached` says why a running team could not introduce it. */
export interface RolePane {
  role: string;
  paneId: string;
  name: string;
  preset: string | null;
  notReached: string | null;
  /** Why the pane's launch mode cannot reach Aya, or why Aya cannot tell (then `unsure`); null when it reaches Aya. */
  cantReach: string | null;
  /** What Aya widened to make it reach Aya, and "may not reach Aya" for an unknown verdict; null when nothing. */
  note: string | null;
  /** Aya cannot tell whether the pane reaches it: no verdict yet, or an unknown one its process has not settled. */
  unsure: boolean;
}

/** Roles given a pane, and roles whose pane moved to another role. */
export interface RolePanes {
  panes: RolePane[];
  leftWithoutPane: string[];
}

/** Which roles got Start team's delivery test, and why the others did not. */
export interface TeamStartResult {
  /** false: a pane was not ready, so nothing was sent; `held` says which. */
  started: boolean;
  /** The team was already running (or another Start is in flight): nothing was sent. */
  alreadyRunning?: boolean;
  /** A role's pane may not resume this pause (team-runner.ts resumeRefusal): nothing was sent. */
  refused?: string;
  delivered: string[];
  held: { role: string; reason: string }[];
  /** The task given with Start: who got it, and why it waits in the inbox, if it does. `messageId`: its log entry. */
  task: { to: string; held: string | null; typedOnly?: boolean; afterEnter?: boolean; messageId?: number } | null;
}

/** A role this one sends to, and what it sends there (may be empty). */
export interface SendRoute {
  to: string;
  what: string;
}

export interface TeamRole {
  id: string;
  sendsTo: SendRoute[];
  mustNot: string;
  responsibilities: string;
}

/** A team from .aya/teams/<name>.md (see electron/team-definition.ts). */
export interface TeamDefinition {
  name: string;
  roles: TeamRole[];
  /** The role that gets the task and the rounds and checks nobody waits too long; null in a team saved before leads. */
  lead: string | null;
  /** The lead gets a round every this many minutes; null: no periodic rounds. The rhythm has no role of its own. */
  cadenceMinutes: number | null;
  /** An old file named another role under "## Lead" than its "## Cadence": that role (the cadence's leads). */
  leadConflict?: string | null;
  protocol: string;
  /** "## Status command": one shell line whose output Aya appends to the lead's round; absent when the team has none. */
  statusCommand?: string;
}

export interface TeamMessage {
  id: number;
  time: string;
  from: string;
  to: string;
  commit: string | null;
  text: string;
  /** Typed into the recipient's pane; the rest wait for its inbox. */
  delivered: boolean;
  /** Why it was not typed when sent, e.g. "shows an approval prompt". */
  held?: string;
  /** Typed into the composer with its Enter withheld: a draft until a human submits it. */
  typedOnly?: boolean;
  /** Typed only, and `held` says what came of the Enter Aya sent (it failed, no turn, a dialog), not why it was withheld. */
  afterEnter?: boolean;
  /** Held, then read by the receiver with `aya team inbox` (set when the log is read with its delivery notes, not stored). */
  viaInbox?: boolean;
}

/** One team as the teams window shows it. `definition` is what Aya runs on:
 *  the saved snapshot, else the repo file; null when that does not parse. */
export interface TeamSummary {
  name: string;
  definition: TeamDefinition | null;
  error: string | null;
  /** The repo file differs from what the user last saved. */
  repoChanged: boolean;
  /** The repo file is gone; Aya runs the saved copy until the user removes the team. */
  repoGone: boolean;
  /** Only the repo file exists (a pull or a clone brought it): nothing of it
   *  runs until the user saves it in Aya. */
  unsaved: boolean;
  /** The repo file parsed, to adopt with one Save; null when it does not parse. */
  repoDefinition: TeamDefinition | null;
  paused: boolean;
  /** Started with Start team and not paused since. */
  running: boolean;
  /** Saved by an agent from a pane: the agent proposes its panes, no prompt needed. */
  agentAuthored: boolean;
  assignments: Record<string, string>;
  /** Per role with a pane in the project: why a message would wait now, null when it would not. */
  paneHolds: Record<string, string | null>;
  /** Per role with a pane: why its CLI holds no note for this role, null when it does. */
  roleNotes: Record<string, string | null>;
  /** Panes that started with a role note of this team that they no longer play. */
  staleNotes: string[];
  /** Per role with a pane: when a Save changed what its aya team whoami prints, while it has not run whoami since. */
  olderRoles: Record<string, string>;
  /** Per role with a pane in the project: what Aya widened so the pane reaches it, null when nothing. */
  paneNotes: Record<string, string | null>;
  /** Messages per role that are waiting in its inbox. */
  unread: Record<string, number>;
  liveness: TeamLiveness;
  log: TeamMessage[];
}

/** Whether the team's rounds get any answer; mirrors electron/types.ts. */
export interface TeamLiveness {
  status: "never started" | "paused" | "progressing" | "talking" | "stalled" | "blocked" | "unreachable";
  /** Set while stalled: the last change to the repo (ISO). */
  stalledSince: string | null;
  blocked: { role: string; reason: string; since: string }[];
  /** The role rounds go to, while its pane has taken none for several rounds (not running, a draft, a shell). */
  unreached: { role: string; reason: string; since: string } | null;
  /** What watches a team: the lead gets a round every `everyMin` (null: no cadence) and is asked for one after
   *  `askAfterMin` of quiet (null: the team has no lead); the team is stalled after `stalledAfterMin`. */
  silence: { askAfterMin: number | null; everyMin?: number | null; stalledAfterMin: number };
  /** While running: the last change to the repo (ISO) and the peer messages since it. */
  repo?: { since: string; messages: number } | null;
  /** The lead did not answer its last `rounds` rounds: the next ones wait for its answer. */
  roundsHeld?: { role: string; rounds: number } | null;
}

/** A role drafted by Aya Intelligence from its name, for the user to edit. */
export interface RoleDraft {
  responsibilities: string;
  mustNot: string;
  sendsTo: SendRoute[];
}
