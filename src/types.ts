import type { AyaApi,QuestionRestart,ReportedStatusLevel,SpawnFailureReason,TerminalStatus } from '../shared/ipc-types';
import type { Preset,WorkingTab } from "../shared/project-team-types";
export type { ApiCandidate,ApiDiscovery,AyaApi,AyaIntelligenceConfig,AyaIntelligenceProvider,BoardSnapshot,BufferSearchHit,CiFailurePreview,CliStatus,ConfigChange,ConfigSlice,ControlStatusLevel,ControlStatusUpdate,DiagnosticsReport,DiffComment,GitChangedFile,GitCommitResult,GitHubLink,GitHubLinkKind,GitMutationResult,GitPublishResult,GitPublishStatus,GitPullRequestResult,GpuLoad,GrokLimit,GrokUsage,HandoverCaptureRequest,HandoverDisplay,HarnessDef,HarnessSearchHit,HarnessSearchRequest,HarnessSearchResult,KanbanCard,KanbanClaim,KanbanColumn,KanbanPriority,KnownHost,LayoutMode,LoadedModel,LocalSummaryRequest,LocalSummaryResult,Machine,MachineClaim,MachineReach,MachineSetup,MachineStatus,MachineView,MicPermissionStatus,MonitoredSession,MonitoredSessionLevel,OllamaStatus,OmarchyPalette,OmarchyStatus,OmarchyTheme,ProjectEvent,ProjectEventLevel,ProjectGitInfo,PromptAttachmentResult,PtyEvent,PullRequestCheck,PullRequestChecks,QuestionRestart,RemoteDirectoryEntry,RemoteDirectoryListing,RemoteHealthCheck,RemoteHealthResult,RemoteHealthStage,RemoteHostInfo,RemoteProjectCreateResult,ReportedStatusLevel,Snippet,SpawnCommand,SpawnFailureReason,SpawnRequest,StatusHookStatus,TerminalNotificationSelection,TerminalStatus,Theme,ThemeColors,ThemesFile,UpdateStatus,UpdateStatusPhase,UsageAccount,UsageData,UsageHookStatus,UsageWindow,WaitingNotificationRequest,WaitingPanes,WebConfigureRequest,WebInterfaceAddress,WebServerStatus,Worktree,WorktreeStatus } from '../shared/ipc-types';
export type { AgentKind,LaunchReach,NewPane,PaneChangeRequest,PanePick,Preset,PresetChoice,ProjectCollectionState,ProjectConfig,RepoProjectConfig,RoleDraft,RolePane,RolePanes,SendRoute,SplitLayout,TeamDefinition,TeamLiveness,TeamMessage,TeamOpenPanesRequest,TeamRole,TeamStartResult,TeamSummary,WorkingTab } from "../shared/project-team-types";

import { PRESET_ID_BOARD,PRESET_ID_SHELL } from "./preset-ids";

/** `aya status waiting --on <role>`: a team role waits on a teammate, not on the user (no bell, no attention). */
export const WAITING_ON = "waiting-on";

declare global {
  interface Window {
    aya: AyaApi;
  }
}

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
  /** The pane's screen shows an agent at work right now (vt-activity); see isTerminalWorking for what counts. */
  working?: boolean;
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
  disconnected?: boolean;
  /** The remote terminal's bridge is reconnecting; this is informational, not a local PTY failure. */
  remoteDisconnected?: boolean;
  disconnectedReason?: string;
  recoveryGeneration?: string;
  recoveryNotice?: string;
  recoveryScreenUnknown?: boolean;
  recoveryBlocked?: boolean;
  recoveryRetryable?: boolean;
  /** Restored from a persisted project tab, not newly created by the user.
   *  Agent presets may append --resume only in this case. */
  restored?: boolean;
  /** Another Aya currently has the host-side controller for this pane. */
  remoteControlled?: boolean;
  /** This local view is attached read-only because another client controls it. */
  remoteReadOnly?: boolean;
  remoteReconnectDelayMs?: number;
  /** Display name of the machine that owns this pane. Derived from its remote project. */
  remoteHost?: string;
  /** Some earlier output was no longer retained when Aya reattached. */
  remoteReplayTruncated?: boolean;
  /** Opened for a team role (WorkingTab.teamLaunch). */
  /** Opened on a machine (WorkingTab.sshTarget). */
  sshTarget?: string;
  teamLaunch?: boolean;
  /** Last session id the agent reported over OSC 9001, mirrored from (and
   *  persisted back to) the project's WorkingTab so a restore can resume this
   *  exact conversation. */
  sessionId?: string;
  /** Mirrors WorkingTab.sharedDir. */
  sharedDir?: true;
  /** One-time prompt for a newly-created worktree pane; never persisted. */
  initialPrompt?: string;
  initialBoardCard?: WorkingTab["initialBoardCard"];
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

export const BUILTIN_BOARD: Preset = {
  id: PRESET_ID_BOARD,
  name: "Kanban",
  icon: "▦",
  color: "#58a6ff",
  command: "",
};

export function getPreset(presets: Preset[], id: string): Preset {
  const found = presets.find((p) => p.id === id);
  if (found) return found;
  // Special-case "shell" so terminals created via Cmd+T always render with a
  // sensible icon/name even if the user deleted their shell preset.
  if (id === PRESET_ID_SHELL) return BUILTIN_SHELL;
  if (id === PRESET_ID_BOARD) return BUILTIN_BOARD;
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

const NON_INTERACTIVE_FLAG = /(?:^|\s)(-p|--print|--headless|--non-interactive|--no-interactive)(?:\s|$|=)/;

/** Match heuristic for commands that look like they've been switched to
 *  non-interactive Claude mode. Shown as a warning in Settings; not blocked.
 *  Only a Claude command counts: other CLIs' -p is a port (ssh, docker, next) or a profile (codex). */
export function looksNonInteractive(command: string): boolean {
  // Quoted text is an argument (a prompt may well say "-p 3000"), never a flag.
  const unquoted = command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
  return unquoted.split(/&&|\|\||[;|&]/).some((segment) => {
    const words = segment.trim().replace(/^(?:env\s+)?(?:\w+=\S*\s+)*/, "");
    return /^(?:\S*\/)?claude(?:\s|$)/.test(words) && NON_INTERACTIVE_FLAG.test(words);
  });
}
