export type { AyaIntelligenceConfig,AyaIntelligenceProvider,CiFailurePreview,CliStatus,ConfigChange,ConfigSlice,ControlStatusLevel,ControlStatusUpdate,DiagnosticsReport,DiffComment,GitChangedFile,GitCommitResult,GitHubLink,GitHubLinkKind,GitMutationResult,GitPublishResult,GitPublishStatus,GitPullRequestResult,HandoverCaptureRequest,HandoverDisplay,LocalSummaryRequest,LocalSummaryResult,MicPermissionStatus,MonitoredSession,MonitoredSessionLevel,OllamaStatus,OmarchyPalette,OmarchyStatus,OmarchyTheme,ProjectGitInfo,PromptAttachmentResult,PtyEvent,PullRequestCheck,PullRequestChecks,QuestionRestart,RemoteDirectoryEntry,RemoteDirectoryListing,RemoteHealthCheck,RemoteHealthResult,RemoteHealthStage,RemoteHostInfo,RemoteProjectCreateResult,ReportedStatusLevel,SpawnFailureReason,SpawnRequest,TerminalNotificationSelection,UpdateStatus,UpdateStatusPhase,WaitingNotificationRequest,WaitingPanes,WebConfigureRequest,WebInterfaceAddress,WebServerStatus,Worktree,WorktreeStatus } from '../shared/ipc-types';
export type { LaunchReach,NewPane,PaneChangeRequest,PanePick,PresetChoice,ProjectCollectionState,ProjectConfig,RepoProjectConfig,RoleDraft,RolePane,RolePanes,SendRoute,SplitLayout,TeamDefinition,TeamLiveness,TeamMessage,TeamOpenPanesRequest,TeamRole,TeamStartResult,TeamSummary,WorkingTab } from "../shared/project-team-types";
export type { TuiArtifactSummary,TuiArtifactsChange } from "../shared/ipc-types";
// Types shared between the Electron main and the renderer via the preload
// context bridge. Keep this file pure type definitions so it can be imported
// from both sides without runtime side-effects.

import type {
	HarnessSearchHit,
	HarnessSearchRequest,
	HarnessSearchResult,
} from "./harness-search";
import type { HarnessDef } from "./harnesses";
import type { Preset } from "./presets";
import type { BufferSearchHit } from "./pty";
import type { Snippet } from "./snippets";
import type { StatusHookStatus } from "./status-hook";
import type { Theme,ThemesFile } from "./themes";
import type { UsageAccount,UsageData } from "./usage";
import type { GrokUsage } from "./usage-grok";
import type { UsageHookStatus } from "./usage-hook";

export type {
	BufferSearchHit,GrokUsage,HarnessDef,HarnessSearchHit,HarnessSearchRequest,HarnessSearchResult,Preset,Snippet,StatusHookStatus,Theme,
	ThemesFile,UsageAccount,UsageData,UsageHookStatus
};

	import type { BoardSnapshot,KanbanCard,KanbanClaim,KanbanColumn,KanbanPriority } from "./board";



export type { BoardSnapshot,KanbanCard,KanbanClaim,KanbanColumn,KanbanPriority };

/** `aya status waiting --on <role>`: a team role waits on a teammate, not on the user (no bell, no attention). */
export const WAITING_ON = "waiting-on";
import type { AyaApi } from "../shared/ipc-types";
export type { AyaApi } from "../shared/ipc-types";


declare global {
  interface Window {
    aya: AyaApi;
  }
}
