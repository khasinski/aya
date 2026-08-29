// Scenario model for the Aya emulator.
//
// A scenario is an authoring-friendly description of a UI state. The bridge
// (createEmulatorAya) turns it into the exact shapes the real renderer loads:
// ProjectConfig[] (listProjects), ProjectCollectionState (listProjectState),
// per-terminal ANSI content (pushed as replay pty:data events), control
// statuses (onControlStatus), git info, and usage snapshots.
//
// Nothing here spawns a process; `content` is just text written into a real
// xterm so the pane shows whatever you want in a screenshot.

import type { SplitNode } from "../split-tree";
import { leaf } from "../split-tree";
import type {
  ControlStatusLevel,
  ProjectGitInfo,
  UsageAccount,
} from "../types";

export interface EmTab {
  id: string;
  /** Preset id: "shell" | "claude" | "codex" | any agent id (see presets.ts). */
  presetId: string;
  name: string;
  /** Worktree cwd override (shows the worktree binding); absent = project dir. */
  cwd?: string;
  /** ANSI/plain text written into the pane's xterm (as a replay data event). */
  content?: string;
  /** Apple Intelligence (local summary): the AI-generated one-line label shown
   *  under the tab name in the sidebar. Setting any summary in a scenario turns
   *  the local-summaries feature on for that render. */
  summary?: string;
  /** Drives the pane's external status pill, the project badge, and the rail. */
  status?: ControlStatusLevel;
  statusText?: string;
  /** Non-null renders the "[process exited]" line + a stopped/restartable pane. */
  exitCode?: number | null;
  /** Killed by a host restart (stopped, restartable) rather than a clean exit. */
  stopped?: boolean;
}

export interface EmProject {
  slug: string;
  name: string;
  directory: string;
  git?: ProjectGitInfo;
  /** Apple Intelligence (local summary): the AI-generated label shown in place
   *  of the path under the project name in its top-bar tab. */
  summary?: string;
  tabs: EmTab[];
  /** Active terminal id (default: first tab). */
  activeTabId?: string;
  /** When set, the project shows just this one terminal instead of the split. */
  singleViewTabId?: string;
  /** Explicit pane layout. When omitted, a balanced tree over all tabs is used
   *  so every terminal is visible in a split. */
  split?: SplitNode;
}

export interface EmScenario {
  name: string;
  platform?: NodeJS.Platform;
  homeDir?: string;
  cwd?: string;
  themeId?: string;
  /** App chrome appearance. Defaults to "dark" for the emulator; overridable
   *  per render with ?theme=light|dark|system. */
  theme?: "light" | "dark" | "system";
  projects: EmProject[];
  activeProjectSlug?: string;
  /** Claude usage accounts → the Claude usage chip(s) in the top bar. */
  usage?: UsageAccount[];
  /** Codex usage accounts → the Codex usage chip in the top bar. */
  codexUsage?: UsageAccount[];
}

/** Build a balanced BSP tree over the given terminal ids so all panes are
 *  visible. Alternates split direction by depth for a grid-ish layout. The
 *  leaf/split ids are deterministic (derived from the terminal ids) so repeated
 *  renders of the same scenario are stable. */
export function balancedSplitTree(
  terminalIds: string[],
  depth = 0,
): SplitNode {
  if (terminalIds.length <= 1) {
    return leaf(`leaf-${terminalIds[0] ?? "empty"}`, terminalIds[0] ?? null);
  }
  const mid = Math.ceil(terminalIds.length / 2);
  const first = terminalIds.slice(0, mid);
  const second = terminalIds.slice(mid);
  return {
    kind: "split",
    id: `split-${depth}-${terminalIds.join("_")}`,
    direction: depth % 2 === 0 ? "row" : "column",
    ratio: first.length / terminalIds.length,
    first: balancedSplitTree(first, depth + 1),
    second: balancedSplitTree(second, depth + 1),
  };
}
