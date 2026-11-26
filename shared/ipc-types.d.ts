/** Single source of truth for the desktop/web bridge and its data transfer objects. */
import type { AgentKind, Preset, WorkingTab, ProjectConfig, RepoProjectConfig, ProjectCollectionState, PanePick, PresetChoice, TeamOpenPanesRequest, PaneChangeRequest, RolePanes, TeamStartResult, TeamDefinition, TeamSummary, RoleDraft } from "./project-team-types";



/** A process under a pane's agent (or shell) that listens on TCP ports (electron/agent-servers.ts). */
export interface AgentServer { pid: number; command: string; ports: number[] }

/** One of a terminal pane's `aya present` artifacts, without its content (electron/tui-artifacts.ts). */
export interface TuiArtifactSummary { id: string; kind: "html" | "image" | "table" | "metric"; title: string; revision: number; updatedAt: number }
/** An artifact a pane presented or updated; `opened` when a window opened for it (no --no-open). */
export interface TuiArtifactsChange { terminalId: string; artifact: TuiArtifactSummary; updated: boolean; opened: boolean }

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


/** A note anchored to a row in the local working-tree diff. Mirrors the
 *  main-process shape so comments can be validated at IPC before saving. */
export interface DiffComment {
  id: string;
  file: string;
  hunk: string;
  line: string;
  newLine: number | null;
  oldLine: number | null;
  occurrence: number;
  checkout: string;
  note: string;
  createdAt: string;
  sentAt: string | null;
  sentTo: string | null;
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


export type KanbanPriority = "low" | "medium" | "high" | "urgent";


export interface KanbanColumn {
  id: string;
  title: string;
}


export interface KanbanClaim {
  paneId?: string;
  paneName: string;
  since: string;
  startup?: "reserved" | "sending" | "sent";
}


export interface KanbanCard {
  id: string;
  columnId: string;
  title: string;
  description?: string;
  assignee?: string;
  priority?: KanbanPriority;
  labels?: string[];
  claim?: KanbanClaim;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}


export interface BoardSnapshot {
  version: 1;
  projectSlug: string;
  source: "repo" | "user";
  filePath: string;
  columns: KanbanColumn[];
  cards: KanbanCard[];
  archivedCards?: KanbanCard[];
  notices?: Array<{ id: string; cardId: string; paneName: string; state: "pending" | "sending" | "typed" }>;
}


export interface ProjectGitInfo {
  branch: string | null;
  dirty: number;
}


/** Overall window layout. "classic": project tabs on top + terminal list on
 *  the left. "projects-left": project tabs in a left rail + terminal tabs on
 *  top. "stacked": no tabs on top; two boxes on the left, projects above and
 *  the project's terminals below (each scrolling inside its box), with the
 *  active terminal's header in the top bar. The last two split no panes. */
export type LayoutMode = "classic" | "projects-left" | "stacked";


export type GitHubLinkKind = "pr" | "branch";


/** A GitHub URL for the active project's current branch: its open PR, or the
 *  branch's tree page when there is no PR. Resolved via the `gh` CLI. */
export interface GitHubLink {
  kind: GitHubLinkKind;
  url: string;
}


export interface GitPublishStatus {
  branch: string | null;
  detached: boolean;
  defaultBranch: boolean;
  remote: string | null;
  pushDisabledReason: string | null;
  pullRequestDisabledReason: string | null;
  remoteError?: string;
}


export type GitPublishResult = { ok: true } | { ok: false; error: string };

export type GitPullRequestResult = { ok: true; url: string } | { ok: false; error: string };


export interface PullRequestCheck {
  name: string;
  state: string;
  bucket: "pass" | "fail" | "pending" | "skipping" | "cancel" | "unknown";
  url: string | null;
}


export interface PullRequestChecks {
  pullRequestUrl: string | null;
  pullRequestState: "open" | "merged" | "closed" | "unknown" | "none";
  checks: PullRequestCheck[];
  error?: string;
}


export interface CiFailurePreview {
  token: string;
  checkName: string;
  checkUrl: string;
  prompt: string;
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


export type GitCommitResult =
  | { ok: true; commit: string }
  | { ok: false; error: string };


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
  | "pane-limit-reached"
  | "node-pty-spawn-error"
  | "spawn-prepare-failed";


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
  /** Restore a captured display, then replay only output after this boundary. */
  replayAfter?: { generation: string; offset: number; token?: string };
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
  | { type: "data"; ptyId: string; chunk: string; replay?: boolean; reset?: boolean; replayToken?: string; replayModeUnknown?: true; streamOffset?: number; remoteDeliveryId?: string }
  | { type: "exit"; ptyId: string; exitCode: number; ownerExit?:{generation:number;event:number} }
  | {
      type: "spawn-failed";
      ptyId: string;
      reason: SpawnFailureReason;
      detail: string;
    }
  // Host had no live session for an attach-only spawn: the process died while
  // the host stayed up. The tab becomes stopped/restartable, not respawned.
  | { type: "no-session"; ptyId: string }
  | { type: "host-connection"; ptyId:string;connected:boolean;reason:string }
  | { type: "remote-control"; ptyId: string; controlled: boolean; readOnly?: boolean }
  | { type: "remote-connection"; ptyId: string; host: string; connected: boolean; retryInMs?: number }
  | { type: "remote-replay-truncated"; ptyId: string }
  | { type: "disconnected"; ptyId: string; reason?:string;recoveryBlocked?:boolean;retryable?:boolean }
  | {type:"recovery-unavailable";ptyId:string;reason:string}
  | {type:"recovered";ptyId:string;generation:string;replayToken:string;notice:string}
  | {type:"recovery-screen";ptyId:string;generation:string;known:boolean}
  | {type:"recovery-state";ptyId:string;generation:string;notice:string;screenUnknown:boolean}
  // Explicit status parsed from an OSC 9001 `aya.status` or OSC 7501 sequence
  // the TUI (or a wrapper script) emitted inline in its own output - see
  // integrations.md. Same vocabulary as ControlStatusUpdate's "status" request
  // (including "clear"), delivered in-band through the PTY stream instead of
  // the control socket.
  | {
      type: "osc-status";
      ptyId: string;
      level: ControlStatusLevel | "clear";
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
  | { type: "vt-status"; ptyId: string; waiting: boolean; dialog?: string }
  // Whether the screen shows an agent at work (electron/busy-tracker.ts steadies it). Repeated while busy.
  | { type: "vt-activity"; ptyId: string; busy: boolean };


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
    /** The host this Aya talks to, or null. */
    pid: number | null;
    /** Whether pty-host.sock exists, and the host answering on it (null when none answers). */
    socket: { exists: boolean; pid: number | null };
    /** Running hosts this Aya does not use and that are not on the socket: their terminals show in no window. */
    otherHosts: Array<{ pid: number; startTime: string; version: string }>;
    /** What is wrong, as Diagnostics shows it; empty when nothing is. */
    warnings: string[];
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
  userScreenRules: {
    available: boolean;
    reason?: string;
    quarantinedDigest?: string;
    directory: string;
    fileProblem?: string;
    sets: Array<{
      agent: "generic" | "claude" | "codex" | "opencode" | "grok" | "antigravity";
      status: "loaded" | "built-in only" | "unavailable";
      ruleCount?: number;
      version?: string;
      digest?: string;
      sources?: string[];
    }>;
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
  /** True while Aya has frozen terminal changes to prepare an app update. */
  preparingUpdate?: boolean;
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


/** What an agent reported, as the windows hold it: "waiting" needs the user, "waiting-on" names the teammate in `on`. */
export type ReportedStatusLevel = ControlStatusLevel | "waiting-on";


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


export interface HarnessSearchResult {
  hits: HarnessSearchHit[];
  coverage: {
    partial: boolean;
    searchedBackTo?: string;
    longMessagesSkipped?: boolean;
    cancelled?: boolean;
    /** The global hit cap stopped the search; value is the number returned. */
    hitLimitReached?: number;
  };
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
  /** This computer's non-internal IPv4 addresses, offered in Settings as listen addresses. */
  addresses: WebInterfaceAddress[];
  /** Currently connected browser clients. */
  clients: number;
  /** Last start failure (e.g. port in use), or null. */
  error: string | null;
}


export interface WebInterfaceAddress {
  /** The OS interface name, e.g. en0 or utun4. */
  name: string;
  address: string;
}


export interface WebConfigureRequest {
  enabled?: boolean;
  port?: number;
  /** Listen address: 127.0.0.1, 0.0.0.0 or one interface address; must be an IP literal. */
  host?: string;
  user?: string;
  /** New custom password; stored as a hash, never echoed back. */
  password?: string;
}


export interface HandoverCaptureRequest {requestId:string;ptyId:string;maxBytes:number}

export interface HandoverDisplay {json:string|null;generation:string;offset:number;notice:string|null}


export type PromptAttachmentResult =
  | { status: "added" }
  | { status: "copied-not-added"; message: string; copyText: string };


export interface AyaApi {
  /** True under `npm run dev` (AYA_DEV=1). */
  isDev: boolean;
  /** True when this renderer is connected through Aya Web rather than Electron preload. */
  isWeb?: boolean;
  platform: NodeJS.Platform;

  ptySpawn(req: SpawnRequest): Promise<void>;
  onHandoverCapture(handler:(request:HandoverCaptureRequest)=>Promise<string|null>):()=>void;
  handoverDisplay(ptyId:string):Promise<HandoverDisplay|null>;
  acknowledgeHandoverDisplay(ptyId:string,generation:string,token?:string):Promise<void>;
  ptyWrite(ptyId: string, data: string): Promise<boolean>;
  ptyResize(ptyId: string, cols: number, rows: number): Promise<void>;
  ptyKill(ptyId: string, action?: "end-remote"): Promise<void>;
  ptyRemoteReconnect(ptyId: string): Promise<boolean>;
  e2eDropRemoteBridge(ptyId: string): Promise<boolean>;
  ptyBuffer(ptyId: string): Promise<string>;
  /** Live cwd of a terminal's process - where the console actually is after a
   *  `cd`, not the cwd Aya spawned it with. null when it can't be read (old
   *  PTY host, dead process, unsupported platform). */
  ptyCwd(ptyId: string): Promise<string | null>;
  /** Local servers the pane's process started: its descendants listening on TCP ports. [] when unknown. */
  ptyServers(ptyId: string): Promise<AgentServer[]>;
  /** SIGTERM (then SIGKILL) one of them; refused unless it still runs under the pane's process. */
  ptyStopServer(ptyId: string, pid: number): Promise<{ forced: boolean }>;
  /** The pane's `aya present` artifacts, newest first; kept across restarts. */
  tuiArtifacts(ptyId: string): Promise<TuiArtifactSummary[]>;
  /** Opens (or reloads) the artifact's window; refused for another pane's artifact. */
  openTuiArtifact(ptyId: string, artifactId: string): Promise<void>;
  onTuiArtifactsChange(handler: (change: TuiArtifactsChange) => void): () => void;
  ptySearch(query: string): Promise<BufferSearchHit[]>;
  /** Experimental harness-aware search: scans the LOCAL Claude Code / Codex
   *  session transcripts for the tab's cwd (history, not terminal output). */
  harnessSearch(req: HarnessSearchRequest, requestId: string, paneId: string): Promise<HarnessSearchResult>;
  harnessSearchCancel(requestId: string, paneId: string): Promise<void>;
  restartPtyHost(): Promise<void>;
  retryPtyHostRecovery():Promise<boolean>;
  /** Stop running hosts this Aya does not use; returns the pids signalled. */
  stopOtherPtyHosts(): Promise<number[]>;
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
  machinesStatus(): Promise<{ version: number; machines: MachineView[] }>;
  machinesSetup(): Promise<{ machines: MachineSetup[]; hosts: KnownHost[] }>;
  machinesCommand(argv: string[]): Promise<string>;
  machinesConfigure(argv: string[], token?: string): Promise<string>;
  machinesDiscover(id: string): Promise<ApiDiscovery>;
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
  getUsageHistory?(days: number, refresh?: boolean): Promise<import("../shared/usage-history").UsageHistory>;
  getUsage(): Promise<UsageAccount[]>;
  /** Read-only Codex usage from its local rollout logs. */
  getCodexUsage(): Promise<UsageAccount[]>;
  /** Grok usage (tokens + cost, last 7 days, account-wide), or null when none. */
  getAntigravityUsage(): Promise<UsageAccount[]>;
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
  /** Main asks this window to change one of its tabs (aya pane rename / close); answer with teamPanesOpened. */
  onPaneChange(handler: (request: PaneChangeRequest) => void): () => void;

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
  setActiveGitDirectory(directory: string | null): Promise<void>;
  commitGitFiles(req: { directory: string; paths: string[]; message: string }): Promise<GitCommitResult>;
  getGitPublishStatus(directory: string, requestId: string): Promise<GitPublishStatus>;
  cancelGitPublishStatus(requestId: string): Promise<void>;
  pushGitBranch(directory: string): Promise<GitPublishResult>;
  createGitPullRequest(directory: string): Promise<GitPullRequestResult>;
  getPullRequestChecks(req: { projectSlug: string; directory: string; requestId: string }): Promise<PullRequestChecks>;
  cancelCiCheckRequest(requestId: string): Promise<void>;
  previewCiFailure(req: { projectSlug: string; directory: string; targetId: string; checkUrl: string; requestId: string }): Promise<CiFailurePreview>;
  sendCiFailure(req: { projectSlug: string; targetId: string; token: string; requestId: string }): Promise<void>;
  getGitDiff(directory: string): Promise<string>;
  listDiffComments(projectSlug: string): Promise<DiffComment[]>;
  addDiffComment(projectSlug: string, comment: DiffComment): Promise<DiffComment[]>;
  editDiffComment(projectSlug: string, id: string, note: string): Promise<DiffComment[]>;
  deleteDiffComment(projectSlug: string, id: string): Promise<DiffComment[]>;
  clearSentDiffComments(projectSlug: string): Promise<DiffComment[]>;
  sendDiffComments(req: { projectSlug: string; targetId: string; checkout: string; commentIds: string[] }): Promise<DiffComment[]>;

  // Kanban board (per project)
  getBoard(projectSlug: string): Promise<BoardSnapshot>;
  acknowledgeBoardNotice(req: { projectSlug: string; noticeId: string }): Promise<BoardSnapshot>;
  reserveBoardCardStart(req: { projectSlug: string; cardId: string; paneId: string; paneName: string }): Promise<{ board: BoardSnapshot; previous: KanbanCard }>;
  dispatchBoardCard(req: { projectSlug: string; cardId: string; paneId: string; claimSince: string }): Promise<BoardSnapshot>;
  cancelBoardCardStart(req: { projectSlug: string; cardId: string; paneId: string; claimSince: string; previousColumn: string; previousAssignee?: string }): Promise<BoardSnapshot>;
  addBoardCard(req: { projectSlug: string; id?: string; title: string; description?: string; columnId?: string; assignee?: string; priority?: KanbanPriority; labels?: string[]; index?: number }): Promise<BoardSnapshot>;
  updateBoardCard(req: { projectSlug: string; cardId: string; title?: string; description?: string; columnId?: string; assignee?: string | null; priority?: KanbanPriority | null; labels?: string[] | null }): Promise<BoardSnapshot>;
  moveBoardCard(req: { projectSlug: string; cardId: string; columnId: string; index?: number }): Promise<BoardSnapshot>;
  deleteBoardCard(req: { projectSlug: string; cardId: string; archive?: boolean }): Promise<BoardSnapshot>;
  clearBoardColumn(req: { projectSlug: string; columnId: string; archive?: boolean }): Promise<BoardSnapshot>;
  restoreBoardCards(req: { projectSlug: string; entries: Array<{ card: KanbanCard; index?: number }> }): Promise<BoardSnapshot>;
  claimBoardCard(req: { projectSlug: string; cardId: string; paneId?: string; paneName: string; replace?: boolean }): Promise<BoardSnapshot>;
  releaseBoardCard(req: { projectSlug: string; cardId: string }): Promise<BoardSnapshot>;
  addBoardColumn(req: { projectSlug: string; title: string }): Promise<BoardSnapshot>;
  moveBoardColumn(req: { projectSlug: string; columnId: string; before?: string; after?: string }): Promise<BoardSnapshot>;
  renameBoardColumn(req: { projectSlug: string; columnId: string; title: string }): Promise<BoardSnapshot>;
  deleteBoardColumn(req: { projectSlug: string; columnId: string }): Promise<BoardSnapshot>;
  exportBoardToRepo(projectSlug: string): Promise<BoardSnapshot>;
  sendBoardCardToPane(req: { projectSlug: string; cardId: string; targetId: string }): Promise<BoardSnapshot>;
  releaseBoardPane(req: { projectSlug: string; paneId: string }): Promise<BoardSnapshot | null>;
  syncBoardPaneName(req: { projectSlug: string; paneId: string; paneName: string }): Promise<BoardSnapshot | null>;
  saveBoardImage(req: { projectSlug: string; dataBase64: string; name?: string }): Promise<{ path: string; markdown: string }>;
  readBoardImage(req: { projectSlug: string; src: string }): Promise<string>;
  onBoardChange(handler: (projectSlug: string) => void): () => void;
  /** Create a git worktree. Errors are RETURNED, not thrown: the caller shows
   *  git's own message (e.g. "a branch named 'x' already exists"). */
  createWorktree(req: {
    directory: string;
    path: string;
    branch?: string;
    base?: string;
  }): Promise<GitMutationResult>;
  createWorktreeBatch(req: {
    directory: string;
    slug: string;
    count: number;
    base: string;
  }): Promise<{ created: { path: string; branch: string }[]; errors: string[] }>;
  /** One worktree + `aya/<name>` branch per name from one base commit
   *  ("Send to several agents"); each name succeeds or fails on its own. */
  createFanOutWorktrees(req: { directory: string; base: string; names: string[] }): Promise<{
    base: string | null;
    results: ({ name: string; ok: true; path: string; branch: string } | { name: string; ok: false; error: string })[];
    error?: string;
  }>;
  /** A fan-out checkout's diff against its base commit, for Compare. */
  fanOutDiff(req: { checkout: string; base: string }): Promise<string>;
  worktreeBranchRemovalInfo(req: {
    directory: string;
    path: string;
    base: string;
  }): Promise<{ branch: string | null; canDelete: boolean; reason: string | null; unmerged: number | null }>;
  removeWorktreeAndBranch(req: {
    directory: string;
    path: string;
    base: string;
    deleteBranch: boolean;
    expectedBranch: string | null;
  }): Promise<{ ok: true; path: string; branchDeleted: boolean } | { ok: false; error: string }>;
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
  /** Reloads this window; its terminals keep running in the pty host. */
  reloadWindow(): Promise<void>;
  getUpdateStatus(): Promise<UpdateStatus>;
  checkForUpdates(): Promise<UpdateStatus>;
  installUpdate(): Promise<void>;
  openNotificationSettings(): Promise<void>;
  /** Opens macOS Privacy & Security; the user selects Local Network. Never changes the permission. */
  openLocalNetworkSettings(): Promise<void>;
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


export type TerminalStatus = "running" | "idle" | "waiting" | "error";


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


// Machines (electron/machines.ts, electron/machines-probe.ts).
export interface ApiCandidate { baseUrl: string; kind: "confirmed" | "auth-required" }

export interface ApiDiscovery { candidates: ApiCandidate[]; error: string | null }

export interface GpuLoad {
  name: string;
  utilPct: number | null;
  memUsedMiB: number | null;
  memTotalMiB: number | null;
}


export interface LoadedModel {
  name: string;
  vramBytes: number | null;
  expiresAt: string | null;
  pinned: boolean;
}


export interface MachineStatus {
  reachable: boolean;
  checkedAt: string;
  error: string | null;
  cpuName: string | null;
  cpus: number | null;
  load1: number | null;
  memUsedBytes: number | null;
  memTotalBytes: number | null;
  gpus: GpuLoad[];
  gpuError: string | null;
  ollama: { up: boolean; version: string | null; loaded: LoadedModel[] | null; modelsError: string | null; installed: boolean | null; running: boolean | null };
  api?: { up: boolean; models: string[] | null; error: string | null };
}


export type MachineReach = "local" | { ssh: string };


export interface MachineClaim {
  by: string;
  pane?: string;
  purpose: string;
  since: string;
}


export interface MachineView {
  id: string;
  reach: MachineReach;
  ollama: { port: number };
  api?: { baseUrl: string; tokenConfigured?: boolean };
  claim?: MachineClaim;
  status: MachineStatus;
}


/** A machine as saved, without its status: what Settings > Machines lists. */
export type Machine = Omit<MachineView, "status">;


/** Local desktop settings only; the stored token itself never crosses the bridge. */
export interface MachineSetup extends Machine {
  api?: NonNullable<Machine["api"]> & { savedTokenPreview?: string };
}


export interface KnownHost {
  target: string;
  sources: ("ssh config" | "remote project")[];
  machine?: string;
}
