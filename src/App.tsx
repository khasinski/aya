import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { detectApproval } from "./bell";
import { commandWithAutoResume } from "./agentPreset";
import { gitContextCwd, projectBaseCwd, tabFromTerminal } from "./worktree";
import { findStatusTarget } from "./control-status-target";
import {
  clearedTerminalStatus,
  controlLevelToTerminalStatus,
  controlStatusEventTitle,
  isTerminalDone,
} from "./pty-event-reducer";
import { forgetSpawn, wasSpawned } from "./spawnSession";
import {
  applyExternalProjectEdits,
  mergeProjectsFromDisk,
} from "./project-reload";
import { AttentionCenter } from "./components/AttentionCenter";
import { StatusRail } from "./components/StatusRail";
import { EmptyState } from "./components/EmptyState";
import { MissingDirModal } from "./components/MissingDirModal";
import { NewProjectModal } from "./components/NewProjectModal";
import { ProjectPresetImportModal } from "./components/ProjectPresetImportModal";
import { SearchModal } from "./components/SearchModal";
import { SettingsModal } from "./components/SettingsModal";
import { ProjectsLeftLayout } from "./components/ProjectsLeftLayout";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TerminalView } from "./components/TerminalView";
import { TopBar } from "./components/TopBar";
import {
  DEFAULT_MAC_OPTION_KEY_MODE,
  isMacOptionKeyMode,
  type MacOptionKeyMode,
} from "./terminal-option-key";
import { useAppShortcuts } from "./hooks/useAppShortcuts";
import { useDoubleShiftSearch } from "./hooks/useDoubleShiftSearch";
import { usePtyEventRouter } from "./hooks/usePtyEventRouter";
import { useStable } from "./hooks/useStableIdentity";
import { sameArrayItems, sameRecordValues } from "./stable-identity";
import { localSummaryUnavailableMessage } from "./local-summary-errors";
import type { SettingsTab } from "./settings-tabs";
import {
  useDockBadge,
  useRecentTerminalActivity,
  useTerminalNotifications,
} from "./hooks/useTerminalSignals";
import { useTerminalSounds } from "./hooks/useTerminalSounds";
import { normalizeSoundOverrides } from "./terminal-sound-prefs";
import {
  MAX_SPLIT_LEAVES,
  assignTerminal,
  compactTree,
  dividerRects,
  findLeafByTerminal,
  focusDirection,
  layoutRects,
  leaf,
  leafCount,
  leaves,
  normalizeTreeForTabs,
  removeTerminal,
  resizeSplit as resizeSplitNode,
  splitLeaf,
  treeFromLegacyLayout,
  type DividerRect,
  type SplitNode,
} from "./split-tree";
import {
  boolPreference,
  enumPreference,
  usePersistentPreference,
  type PreferenceCodec,
} from "./hooks/usePersistentPreference";
import {
  BUILTIN_SHELL,
  type AyaIntelligenceConfig,
  type Snippet,
  getPreset,
  type GitHubLink,
  type LayoutMode,
  type ProjectEvent,
  type MonitoredSession,
  type Preset,
  type PtyEvent,
  presetSlug,
  type ProjectCollectionState,
  type ProjectConfig,
  type ProjectGitInfo,
  type RemoteProjectCreateResult,
  type TerminalState,
  type Theme,
  type ThemeColors,
  type UsageAccount,
  type WorkingTab,
  type Worktree,
  type WorktreeStatus,
} from "./types";

// Cadence for polling the active project's git branch/dirty count (no inotify watch).
const GIT_STATUS_POLL_INTERVAL_MS = 3000;
// Cadence for re-reading the account-wide usage snapshot a user hook writes.
const USAGE_POLL_INTERVAL_MS = 30_000;
// Cap on retained entries in the project event timeline.
const MAX_PROJECT_EVENTS = 200;
// Cap on preset suggestions offered during repo preset import.
const MAX_SUGGESTED_PRESETS = 8;
// Default sidebar width in pixels.
const DEFAULT_SIDEBAR_WIDTH_PX = 240;
const DEFAULT_RAIL_WIDTH_PX = 220;
// Stable empty map handed to chrome when summaries are off, so the prop doesn't
// change identity every render (a fresh `{}` would defeat child memoization).
const EMPTY_SUMMARIES: Record<string, string> = {};

// Run `refresh` now, then on an interval — but skip ticks while the window is
// hidden (no point spawning `git`, re-reading session/usage files in the
// background), and refresh once immediately when it becomes visible again.
// Returns a cleanup that stops the interval and removes the listener.
function pollVisible(refresh: () => void, intervalMs: number): () => void {
  refresh();
  const id = window.setInterval(() => {
    if (!document.hidden) refresh();
  }, intervalMs);
  const onVisible = () => {
    if (!document.hidden) refresh();
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    window.clearInterval(id);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
// Default terminal font size in pixels.
const TERMINAL_FONT_SIZE_PX = 13;
// Persisted schema version for ProjectCollectionState.
const PROJECT_STATE_VERSION = 1;
const APP_THEME_STORAGE_KEY = "aya:app-theme";
const MAC_OPTION_KEY_STORAGE_KEY = "aya:mac-option-key";
const TERMINAL_FONT_FAMILY_STORAGE_KEY = "aya:terminal-font-family";
const USAGE_HARNESS_NAME_STORAGE_KEY = "aya:usage-show-harness-name";
const STATUSBAR_GITHUB_LINK_STORAGE_KEY = "aya:statusbar-github-link";
const LAYOUT_MODE_STORAGE_KEY = "aya:layout-mode";
const WORKTREES_STORAGE_KEY = "aya:worktrees";
const HARNESS_SEARCH_STORAGE_KEY = "aya:harness-search";
const TERMINAL_SOUNDS_STORAGE_KEY = "aya:terminal-sounds";
const STATUS_RAIL_COLLAPSED_STORAGE_KEY = "aya:status-rail-collapsed";
/** Leaf id for the synthetic one-pane tree used when a project has no stored
 *  split (or is showing a single terminal). Constant so React keys and focus
 *  stay stable across renders. */
const SINGLE_VIEW_LEAF_ID = "single";
const SOUND_OVERRIDES_STORAGE_KEY = "aya:terminal-sound-overrides";
const CUSTOM_WAITING_SOUND_STORAGE_KEY = "aya:terminal-sound-waiting";
const CUSTOM_DONE_SOUND_STORAGE_KEY = "aya:terminal-sound-done";
const LOCAL_SUMMARIES_STORAGE_KEY = "aya:local-summaries";
const LOCAL_SUMMARY_CACHE_STORAGE_KEY = "aya:local-summary-cache";
const AYA_INTELLIGENCE_STORAGE_KEY = "aya:intelligence";
const WARM_PROJECT_TERMINAL_CACHE_SIZE = 4;
const LOCAL_SUMMARY_REFRESH_MS = 30 * 60 * 1000;
const LOCAL_SUMMARY_DEBOUNCE_MS = 10_000;
// Debounce for the single project-state disk writer (the #18 race fix).
const PROJECT_STATE_SAVE_DEBOUNCE_MS = 150;
const LOCAL_SUMMARY_MIN_UPDATE_MS = 2 * 60 * 1000;
const LOCAL_SUMMARY_MIN_NEW_LINES = 8;
const LOCAL_SUMMARY_MAX_LINES = 30;
const LOCAL_SUMMARY_BUFFER_LINES = 80;
const LOCAL_SUMMARY_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SESSION_MONITOR_POLL_INTERVAL_MS = 5_000;

type AppThemePreference = "system" | "light" | "dark";

const DEFAULT_AYA_INTELLIGENCE: AyaIntelligenceConfig = {
  provider: "apple",
  ollamaModel: "gemma4:e4b",
  openAiBaseUrl: "http://localhost:11434/v1",
  openAiApiKey: "",
  openAiModel: "gemma4:e4b",
};

interface AutoSummaryStatus {
  terminalCount: number;
  terminalsWithLines: number;
  totalLines: number;
  lastEvent: string;
}

type ProjectBadgeLevel = "active" | "done" | "waiting" | "error";

// Content comparators for useStable: badge/session records are rebuilt with
// fresh value objects on every terminals-map change, so identity alone can't
// tell "same badges" from "changed badges".
function sameProjectBadges(
  a: Record<string, { count: number; level: ProjectBadgeLevel }>,
  b: Record<string, { count: number; level: ProjectBadgeLevel }>,
): boolean {
  return sameRecordValues(
    a,
    b,
    (x, y) => x.count === y.count && x.level === y.level,
  );
}

function sameSessionRecords(
  a: Record<string, MonitoredSession[]>,
  b: Record<string, MonitoredSession[]>,
): boolean {
  return sameRecordValues(a, b, sameArrayItems);
}

interface SummaryCache {
  terminal: Record<string, { summary: string; updatedAt: number }>;
  project: Record<string, { summary: string; updatedAt: number }>;
}

// localStorage codecs for the simple preferences (see usePersistentPreference).
const THEME_CODEC = enumPreference<AppThemePreference>(
  ["system", "light", "dark"],
  "system",
);
const MAC_OPTION_CODEC: PreferenceCodec<MacOptionKeyMode> = {
  fallback: DEFAULT_MAC_OPTION_KEY_MODE,
  parse: (raw) => (isMacOptionKeyMode(raw) ? raw : DEFAULT_MAC_OPTION_KEY_MODE),
  serialize: (v) => v,
};
// "classic" (default): project tabs on top, terminal list left.
// "projects-left": project tabs in a left rail, terminal tabs on top.
const LAYOUT_CODEC = enumPreference<LayoutMode>(
  ["classic", "projects-left"],
  "classic",
);
// Harness names show by default; the PR/branch link is opt-in (needs gh).
const HARNESS_NAME_CODEC = boolPreference(true);
const GITHUB_LINK_CODEC = boolPreference(false);
const LOCAL_SUMMARIES_CODEC = boolPreference(false);
// Experimental: git worktree support (detect + group + launch/create in worktrees).
const WORKTREES_CODEC = boolPreference(false);
// Experimental: Cmd+F "History" mode searching Claude/Codex session
// transcripts on disk for the tab's cwd.
const HARNESS_SEARCH_CODEC = boolPreference(false);
// Waiting/done chimes default on; the settings toggle is an opt-out.
const TERMINAL_SOUNDS_CODEC = boolPreference(true);
// The status rail starts expanded — it only renders at all when something
// actually needs attention, so hiding it by default would defeat the point.
const STATUS_RAIL_COLLAPSED_CODEC = boolPreference(false);
// Per-preset chime exceptions ({presetId: false}) and custom audio paths.
// Stored as JSON because they're maps/nullable strings, not flags.
const SOUND_OVERRIDES_CODEC: PreferenceCodec<Record<string, boolean>> = {
  fallback: {},
  parse: (raw) => {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      const out: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "boolean") out[key] = value;
      }
      return out;
    } catch {
      return {};
    }
  },
  serialize: (value) => JSON.stringify(value),
};
const SOUND_PATH_CODEC: PreferenceCodec<string | null> = {
  fallback: null,
  parse: (raw) => (raw.trim() ? raw : null),
  serialize: (value) => value ?? "",
};

function readTerminalFontFamily(): string {
  return localStorage.getItem(TERMINAL_FONT_FAMILY_STORAGE_KEY) ?? "";
}

function readSummaryCache(): SummaryCache {
  try {
    const raw = localStorage.getItem(LOCAL_SUMMARY_CACHE_STORAGE_KEY);
    if (!raw) return { terminal: {}, project: {} };
    const parsed = JSON.parse(raw) as Partial<SummaryCache>;
    const now = Date.now();
    const normalize = (
      input: unknown,
    ): Record<string, { summary: string; updatedAt: number }> => {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return {};
      }
      const out: Record<string, { summary: string; updatedAt: number }> = {};
      for (const [key, value] of Object.entries(input)) {
        if (
          typeof value !== "object" ||
          value === null ||
          Array.isArray(value)
        ) {
          continue;
        }
        const entry = value as Record<string, unknown>;
        if (
          typeof entry.summary !== "string" ||
          !entry.summary.trim() ||
          typeof entry.updatedAt !== "number" ||
          now - entry.updatedAt > LOCAL_SUMMARY_CACHE_MAX_AGE_MS
        ) {
          continue;
        }
        out[key] = { summary: entry.summary.trim(), updatedAt: entry.updatedAt };
      }
      return out;
    };
    return {
      terminal: normalize(parsed.terminal),
      project: normalize(parsed.project),
    };
  } catch {
    return { terminal: {}, project: {} };
  }
}

function summariesFromCache(
  cache: SummaryCache,
  kind: "terminal" | "project",
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(cache[kind]).map(([key, value]) => [key, value.summary]),
  );
}

function readAyaIntelligenceConfig(): AyaIntelligenceConfig {
  try {
    const raw = localStorage.getItem(AYA_INTELLIGENCE_STORAGE_KEY);
    if (!raw) return DEFAULT_AYA_INTELLIGENCE;
    const parsed = JSON.parse(raw) as Partial<AyaIntelligenceConfig>;
    return {
      provider:
        parsed.provider === "ollama" || parsed.provider === "openai"
          ? parsed.provider
          : "apple",
      ollamaModel:
        typeof parsed.ollamaModel === "string" && parsed.ollamaModel.trim()
          ? parsed.ollamaModel.trim()
          : DEFAULT_AYA_INTELLIGENCE.ollamaModel,
      openAiBaseUrl:
        typeof parsed.openAiBaseUrl === "string"
          ? parsed.openAiBaseUrl
          : DEFAULT_AYA_INTELLIGENCE.openAiBaseUrl,
      openAiApiKey:
        typeof parsed.openAiApiKey === "string" ? parsed.openAiApiKey : "",
      openAiModel:
        typeof parsed.openAiModel === "string" && parsed.openAiModel.trim()
          ? parsed.openAiModel.trim()
          : DEFAULT_AYA_INTELLIGENCE.openAiModel,
    };
  } catch {
    return DEFAULT_AYA_INTELLIGENCE;
  }
}

function cleanTerminalOutput(chunk: string): string[] {
  return chunk
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) =>
      line
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((line) => line.length >= 3);
}

function summaryHash(lines: string[]): string {
  let hash = 2166136261;
  for (const line of lines) {
    for (let i = 0; i < line.length; i += 1) {
      hash ^= line.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
  }
  return String(hash >>> 0);
}

// Hard fallback used only if the themes file is somehow empty before boot
// resolves — matches AYA_DARK in electron/themes.ts.
const FALLBACK_THEME_COLORS: ThemeColors = {
  background: "#0d1117",
  foreground: "#c9d1d9",
  cursor: "#c9d1d9",
  cursorAccent: "#0d1117",
  selectionBackground: "rgba(88,166,255,0.3)",
  black: "#484f58",
  red: "#ff7b72",
  green: "#56d364",
  yellow: "#e3b341",
  blue: "#79c0ff",
  magenta: "#d2a8ff",
  cyan: "#39c5cf",
  white: "#b1bac4",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#7ee787",
  brightYellow: "#f0ad4e",
  brightBlue: "#a5d6ff",
  brightMagenta: "#ffa657",
  brightCyan: "#56d4dd",
  brightWhite: "#f0f6fc",
};

function dedupeSlugs(slugs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const slug of slugs) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

/** Drop null/undefined values so the persisted selection map only has live ids. */
function compactRecord(
  record: Record<string, string | null>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value) out[key] = value;
  }
  return out;
}

interface GitInfo {
  branch: string | null;
  dirty: number;
}

interface NewProjectModalState {
  defaults?: { directory?: string };
  lockDirectory?: boolean;
  title?: string;
  hint?: string;
  pathHint?: string;
}

interface MissingDirEntry {
  slug: string;
  name: string;
  directory: string;
}

interface PendingRepoImport {
  project: ProjectConfig;
  presets: Preset[];
}

function uuid(): string {
  // Cryptographically secure source — CodeQL flags Math.random() ids as
  // insecure. getRandomValues works in every context (incl. the file://
  // production page, where crypto.randomUUID is unavailable).
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function findProject(
  projects: ProjectConfig[],
  slug: string,
): ProjectConfig | null {
  return projects.find((p) => p.slug === slug) ?? null;
}

function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || "project";
}

/** Keep the previous poll-state reference when the fresh result is
 *  value-identical. The polls (git 3s, sessions 5s, usage 30s) hand back fresh
 *  objects every tick; without this every tick re-renders App AND breaks
 *  React.memo on the chrome components by changing prop identities. Poll
 *  payloads are small, so a JSON compare is cheap. */
function samePollPayload<T>(prev: T, next: T): boolean {
  return JSON.stringify(prev) === JSON.stringify(next);
}

/** setGit updater that no-ops (same reference back) when that directory's git
 *  info is unchanged — the common case for the 3s status-bar poll. Keyed by
 *  directory, not project slug: a worktree tab reads its OWN checkout, so one
 *  project can hold several entries and switching tabs must not show the
 *  previous checkout's branch until the next poll lands. */
function mergeGitInfo(
  g: Record<string, ProjectGitInfo>,
  directory: string,
  info: ProjectGitInfo,
): Record<string, ProjectGitInfo> {
  const cur = g[directory];
  return cur && cur.branch === info.branch && cur.dirty === info.dirty
    ? g
    : { ...g, [directory]: info };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function remoteTerminalCommand(project: ProjectConfig, preset: Preset): string {
  if (!project.remote) return preset.command;
  const remoteShell = '"${SHELL:-/bin/sh}"';
  const remoteCommand =
    preset.id === "shell" || preset.command.trim() === "$SHELL"
      ? `cd ${shellQuote(project.remote.directory)} && exec ${remoteShell} -l`
      : `cd ${shellQuote(project.remote.directory)} && exec ${remoteShell} -l -i -c ${shellQuote(`exec ${preset.command}`)}`;
  return `ssh -tt ${shellQuote(project.remote.sshTarget)} ${shellQuote(remoteCommand)}`;
}

function terminalCommand(
  project: ProjectConfig | null,
  preset: Preset,
  terminal: TerminalState,
): string {
  const commandPreset = {
    ...preset,
    command: commandWithAutoResume(preset, terminal.restored, terminal.sessionId),
  };
  return project ? remoteTerminalCommand(project, commandPreset) : commandPreset.command;
}

function uniqueProjectName(projects: ProjectConfig[], directory: string): string {
  const base = basename(directory);
  const used = new Set(projects.map((p) => p.slug));
  const root = base || "project";
  let name = root;
  let idx = 2;
  while (used.has(presetSlug(name))) {
    name = `${root} ${idx}`;
    idx += 1;
  }
  return name;
}

function uniquePresetId(existing: Preset[], project: ProjectConfig, preset: Preset): string {
  const used = new Set(existing.map((p) => p.id));
  const root = presetSlug(`${project.slug}-${preset.id || preset.name}`);
  let candidate = root;
  let idx = 2;
  while (used.has(candidate)) {
    candidate = `${root}-${idx}`;
    idx += 1;
  }
  return candidate;
}

/** A project's pane layout, migrating the pre-tree grid format on the fly.
 *  Migration lives here (not in the main process) so the conversion has exactly
 *  one tested implementation — see src/split-tree.ts treeFromLegacyLayout. The
 *  next save writes `splitTree` and drops `splitLayout`. */
function projectSplitTree(project: ProjectConfig): SplitNode | undefined {
  if (project.splitTree) return project.splitTree;
  if (project.splitLayout) return treeFromLegacyLayout(project.splitLayout);
  return undefined;
}

/** Which pane is focused. A remembered id wins while it still exists;
 *  otherwise the pane holding the active terminal, else the first pane — so
 *  focus never dangles after a pane is closed or collapsed. */
function resolveActiveLeafId(
  tree: SplitNode,
  remembered: string | undefined,
  activeTerminalId: string | null,
): string {
  const all = leaves(tree);
  if (remembered && all.some((l) => l.id === remembered)) return remembered;
  if (activeTerminalId) {
    const holding = all.find((l) => l.terminalId === activeTerminalId);
    if (holding) return holding.id;
  }
  return all[0].id;
}

/** Geometry lives in src/split-tree.ts; App only wires it to state.
 *  A divider is dragged in pixels and converted to a ratio against the area
 *  ITS split governs — measuring against the whole container would make a
 *  divider nested inside a half-width pane move at twice the pointer's speed. */
function SplitResizeHandle({
  divider,
  onResize,
}: {
  divider: DividerRect;
  onResize: (ratio: number) => void;
}) {
  const vertical = divider.direction === "row";
  return (
    <div
      className={`aya-split-resize aya-split-resize--${vertical ? "col" : "row"}`}
      style={{
        left: `${divider.rect.left}%`,
        top: `${divider.rect.top}%`,
        ...(vertical
          ? { height: `${divider.rect.height}%` }
          : { width: `${divider.rect.width}%` }),
      }}
      onMouseDown={(event) => {
        event.preventDefault();
        const host = event.currentTarget.parentElement;
        if (!host) return;
        const hostRect = host.getBoundingClientRect();
        const { bounds } = divider;
        const spanPx = vertical
          ? (hostRect.width * bounds.width) / 100
          : (hostRect.height * bounds.height) / 100;
        const originPx = vertical
          ? hostRect.left + (hostRect.width * bounds.left) / 100
          : hostRect.top + (hostRect.height * bounds.top) / 100;
        if (spanPx <= 0) return;
        const move = (moveEvent: MouseEvent) => {
          const pointer = vertical ? moveEvent.clientX : moveEvent.clientY;
          onResize((pointer - originPx) / spanPx);
        };
        const up = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
          document.body.style.cursor = "";
        };
        document.body.style.cursor = vertical ? "col-resize" : "row-resize";
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      }}
    />
  );
}

/** Default display name for a freshly-created tab. Uses the preset's name
 *  so renaming a preset in Settings shows up on the next launch. */
function defaultTabName(preset: Preset): string {
  return preset.name.trim() || preset.id || "terminal";
}

function normalizeLocalPath(value: string): string {
  if (value.length > 1) return value.replace(/\/+$/, "");
  return value;
}

function pathContainsProject(pathname: string, projectDirectory: string): boolean {
  const cwd = normalizeLocalPath(pathname);
  const directory = normalizeLocalPath(projectDirectory);
  return cwd === directory || cwd.startsWith(directory + "/");
}

function findProjectSlugForSession(
  session: MonitoredSession,
  projects: ProjectConfig[],
): string | null {
  let best: ProjectConfig | null = null;
  for (const project of projects) {
    if (project.remote) continue;
    if (!pathContainsProject(session.cwd, project.directory)) continue;
    if (!best || project.directory.length > best.directory.length) {
      best = project;
    }
  }
  return best?.slug ?? null;
}

export function App() {
  const [allProjects, setAllProjects] = useState<ProjectConfig[]>([]);
  const [projects, setProjects] = useState<ProjectConfig[]>([]);
  const [projectState, setProjectState] = useState<ProjectCollectionState>({
    version: PROJECT_STATE_VERSION,
    order: [],
    open: [],
    recent: [],
  });
  const [presets, setPresets] = useState<Preset[]>([]);
  const [remotePresetsByProject, setRemotePresetsByProject] = useState<
    Record<string, Preset[]>
  >({});
  const [defaultPresets, setDefaultPresets] = useState<Preset[]>([]);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [themes, setThemes] = useState<Theme[]>([]);
  const [activeThemeId, setActiveThemeId] = useState<string>("");
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [warmProjectSlugs, setWarmProjectSlugs] = useState<string[]>([]);
  const [terminals, setTerminals] = useState<Record<string, TerminalState>>({});
  const [projectEvents, setProjectEvents] = useState<ProjectEvent[]>([]);
  const [activeTabByProject, setActiveTabByProject] = useState<
    Record<string, string | null>
  >({});
  const [singleViewByProject, setSingleViewByProject] = useState<
    Record<string, string | null>
  >({});
  // Which pane is focused, per project. Not persisted: the pane holding the
  // (persisted) active terminal is the right answer on boot, and a remembered
  // leaf id would dangle once the layout changed on disk.
  const [activeLeafByProject, setActiveLeafByProject] = useState<
    Record<string, string>
  >({});
  const [git, setGit] = useState<Record<string, GitInfo>>({});
  const [githubLinks, setGithubLinks] = useState<
    Record<string, GitHubLink | null>
  >({});
  const [usageAccounts, setUsageAccounts] = useState<UsageAccount[]>([]);
  const [codexUsageAccounts, setCodexUsageAccounts] = useState<
    UsageAccount[]
  >([]);
  const [newProjectModal, setNewProjectModal] =
    useState<NewProjectModalState | null>(null);
  const [missingDirQueue, setMissingDirQueue] = useState<MissingDirEntry[]>([]);
  /** Session-only override: slug → cwd to use instead of project.directory.
   *  Populated when the user picks "Use home for now" in MissingDirModal. */
  const [projectFallbacks, setProjectFallbacks] = useState<
    Record<string, string>
  >({});
  const [homeDir, setHomeDir] = useState<string>("");
  const [showSettings, setShowSettings] = useState(false);
  const [appThemePreference, setAppThemePreference] = usePersistentPreference(
    APP_THEME_STORAGE_KEY,
    THEME_CODEC,
  );
  const [macOptionKeyMode, setMacOptionKeyMode] = usePersistentPreference(
    MAC_OPTION_KEY_STORAGE_KEY,
    MAC_OPTION_CODEC,
  );
  const [terminalFontFamily, setTerminalFontFamily] =
    useState(readTerminalFontFamily);
  const [showUsageHarnessName, setShowUsageHarnessName] =
    usePersistentPreference(USAGE_HARNESS_NAME_STORAGE_KEY, HARNESS_NAME_CODEC);
  const [showGitHubLink, setShowGitHubLink] = usePersistentPreference(
    STATUSBAR_GITHUB_LINK_STORAGE_KEY,
    GITHUB_LINK_CODEC,
  );
  const [layoutMode, setLayoutMode] = usePersistentPreference(
    LAYOUT_MODE_STORAGE_KEY,
    LAYOUT_CODEC,
  );
  const [worktreesEnabled, setWorktreesEnabled] = usePersistentPreference(
    WORKTREES_STORAGE_KEY,
    WORKTREES_CODEC,
  );
  const [harnessSearchEnabled, setHarnessSearchEnabled] =
    usePersistentPreference(HARNESS_SEARCH_STORAGE_KEY, HARNESS_SEARCH_CODEC);
  const [terminalSoundsEnabled, setTerminalSoundsEnabled] =
    usePersistentPreference(TERMINAL_SOUNDS_STORAGE_KEY, TERMINAL_SOUNDS_CODEC);
  const [statusRailCollapsed, setStatusRailCollapsed] = usePersistentPreference(
    STATUS_RAIL_COLLAPSED_STORAGE_KEY,
    STATUS_RAIL_COLLAPSED_CODEC,
  );
  const [terminalSoundOverrides, setTerminalSoundOverrides] =
    usePersistentPreference(SOUND_OVERRIDES_STORAGE_KEY, SOUND_OVERRIDES_CODEC);
  const [customWaitingSound, setCustomWaitingSound] = usePersistentPreference(
    CUSTOM_WAITING_SOUND_STORAGE_KEY,
    SOUND_PATH_CODEC,
  );
  const [customDoneSound, setCustomDoneSound] = usePersistentPreference(
    CUSTOM_DONE_SOUND_STORAGE_KEY,
    SOUND_PATH_CODEC,
  );
  // Worktrees of the active (local) project, with branch + dirty count. Polled
  // (not loaded once per project switch) because an agent asked to "work in a
  // worktree" creates one mid-session — it has to show up without a restart.
  // Feeds the status bar's checkout picker; the sidebar's worktree grouping and
  // launcher target additionally require the experimental flag.
  const [worktrees, setWorktrees] = useState<WorktreeStatus[]>([]);
  // Bumped after a create/remove so the poll effect re-fires immediately;
  // without it a freshly created worktree would wait out the poll interval.
  const [worktreeNudge, setWorktreeNudge] = useState(0);
  // Checkout the user PINNED in the status bar (slug -> path), overriding the
  // "follow the console" default. Session-only: a pin is a look-at-this-now
  // decision, not a project setting.
  const [pinnedCheckout, setPinnedCheckout] = useState<Record<string, string>>(
    {},
  );
  // Checkout root the ACTIVE terminal is really in: its process cwd (which a
  // `cd` moves) resolved to the enclosing git root. null until the first read,
  // or when it can't be determined — then the spawn cwd stands in.
  const [liveCheckout, setLiveCheckout] = useState<string | null>(null);
  const [railWidth, setRailWidth] = useState(DEFAULT_RAIL_WIDTH_PX);
  const [localSummariesEnabled, setLocalSummariesEnabled] =
    usePersistentPreference(LOCAL_SUMMARIES_STORAGE_KEY, LOCAL_SUMMARIES_CODEC);
  const [ayaIntelligence, setAyaIntelligence] = useState<AyaIntelligenceConfig>(
    readAyaIntelligenceConfig,
  );
  const [initialSummaryCache] = useState(readSummaryCache);
  const [terminalSummaries, setTerminalSummaries] = useState<Record<string, string>>(
    () => summariesFromCache(initialSummaryCache, "terminal"),
  );
  const [projectSummaries, setProjectSummaries] = useState<Record<string, string>>(
    () => summariesFromCache(initialSummaryCache, "project"),
  );
  const [monitoredSessions, setMonitoredSessions] = useState<MonitoredSession[]>([]);
  const [summaryNudge, setSummaryNudge] = useState(0);
  const [autoSummaryStatus, setAutoSummaryStatus] = useState<AutoSummaryStatus>({
    terminalCount: 0,
    terminalsWithLines: 0,
    totalLines: 0,
    lastEvent: "No automatic summary run yet.",
  });
  const effectiveTerminalFontFamily = terminalFontFamily.trim() || undefined;
  const [settingsInitialTab, setSettingsInitialTab] =
    useState<SettingsTab>("general");
  const [showSearch, setShowSearch] = useState(false);
  const [snippetDrawerTerminalId, setSnippetDrawerTerminalId] = useState<
    string | null
  >(null);
  const [showAttentionCenter, setShowAttentionCenter] = useState(false);
  const [pendingRepoImport, setPendingRepoImport] =
    useState<PendingRepoImport | null>(null);
  const [findInPaneFor, setFindInPaneFor] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH_PX);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [didBootstrap, setDidBootstrap] = useState(false);
  const [harnessScanDone, setHarnessScanDone] = useState(false);
  const [foundHarnessCount, setFoundHarnessCount] = useState(0);
  const [hideNoHarnessHint, setHideNoHarnessHint] = useState(
    () => localStorage.getItem("aya:no-harness-hint-dismissed") === "1",
  );
  const fontSize = TERMINAL_FONT_SIZE_PX;
  const openSettings = useCallback((tab: SettingsTab = "general") => {
    setSettingsInitialTab(tab);
    setShowSettings(true);
  }, []);

  // Active terminal, derived early: the git surface below follows the checkout
  // THIS terminal is in, so its id/cwd are needed before the poll effects.
  const activeTabId = activeProjectId
    ? (activeTabByProject[activeProjectId] ?? null)
    : null;
  const activeTerminal = activeTabId ? (terminals[activeTabId] ?? null) : null;

  // The active project's own checkout — where a terminal with no worktree
  // binding runs. null for remote projects (no local working tree).
  const activeProjectCheckout = useMemo(() => {
    if (!activeProjectId) return null;
    const project = findProject(projects, activeProjectId);
    if (!project || project.remote) return null;
    const base = projectFallbacks[project.slug] ?? project.directory;
    return gitContextCwd(base, activeTerminal?.cwd);
  }, [activeProjectId, projects, projectFallbacks, activeTerminal?.cwd]);

  // Follow the console: read the active terminal's REAL cwd (a `cd` — or an
  // agent that made itself a worktree and moved into it — leaves the spawn cwd
  // behind) and resolve it to the enclosing checkout root, since the cwd can be
  // a subdirectory. Active terminal only, on the git cadence: ~70ms on macOS
  // (lsof; there is no /proc), so this is not something to run per tab.
  const liveCwdRef = useRef<string | null>(null);
  useEffect(() => {
    liveCwdRef.current = null;
    setLiveCheckout(null);
    if (!activeTabId || !activeProjectCheckout) return;
    let cancelled = false;
    const refresh = () => {
      void window.aya.ptyCwd(activeTabId).then(async (cwd) => {
        if (cancelled || !cwd) return;
        // Same cwd as last tick — the resolved root can't have changed, so skip
        // the `git rev-parse`. Only a cd (or the first read) pays for it.
        if (cwd === liveCwdRef.current) return;
        const root = await window.aya.getGitRoot(cwd);
        if (cancelled) return;
        liveCwdRef.current = cwd;
        setLiveCheckout(root);
      });
    };
    const stop = pollVisible(refresh, GIT_STATUS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      stop();
    };
  }, [activeTabId, activeProjectCheckout]);

  // The checkout the status bar's git surface describes, in priority order:
  // what the user pinned in the picker, else where the console actually is,
  // else the terminal's spawn cwd (a worktree binding or the project dir).
  // null = nothing to read (no project, or a remote one).
  const activeGitDirectory = useMemo(() => {
    if (!activeProjectCheckout) return null;
    const pinned = activeProjectId ? pinnedCheckout[activeProjectId] : null;
    return pinned ?? liveCheckout ?? activeProjectCheckout;
  }, [activeProjectCheckout, activeProjectId, pinnedCheckout, liveCheckout]);

  // Status-bar branch / dirty count goes stale once you `git checkout` in a
  // shell or commit something — there's no inotify watch, just a small poll
  // for the active checkout. ~50ms subprocess, 3s cadence; cancelled on
  // project / worktree-tab switch.
  useEffect(() => {
    if (!activeGitDirectory) return;
    let cancelled = false;
    const refresh = () => {
      if (cancelled) return;
      void window.aya.getGitInfo(activeGitDirectory).then((info) => {
        if (cancelled) return;
        setGit((g) => mergeGitInfo(g, activeGitDirectory, info));
      });
    };
    const stop = pollVisible(refresh, GIT_STATUS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      stop();
    };
  }, [activeGitDirectory]);

  // Poll the active local project's worktrees (with branch + dirty count). It
  // used to load once per project switch, which meant a worktree an agent
  // created during the session stayed invisible until you switched away and
  // back. `git worktree list` is ~8ms and the per-worktree status calls only
  // run when there is more than one checkout to tell apart.
  useEffect(() => {
    if (!activeProjectCheckout) {
      setWorktrees([]);
      return;
    }
    let cancelled = false;
    const refresh = () => {
      void window.aya.getGitWorktreeStatus(activeProjectCheckout).then((list) => {
        if (cancelled) return;
        setWorktrees((prev) => (samePollPayload(prev, list) ? prev : list));
      });
    };
    const stop = pollVisible(refresh, GIT_STATUS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      stop();
    };
  }, [activeProjectCheckout, worktreeNudge]);

  // Drop a pin whose worktree is gone (removed, or the project now points at a
  // different repo). Left in place it would aim the whole git surface at a dead
  // path, and with no branch to render there would be no chip left to click to
  // undo it. Only acts on a non-empty list, so a failed read doesn't unpin.
  useEffect(() => {
    if (!activeProjectId || worktrees.length === 0) return;
    const pinned = pinnedCheckout[activeProjectId];
    if (!pinned || worktrees.some((w) => w.path === pinned)) return;
    setPinnedCheckout((prev) => {
      if (!(activeProjectId in prev)) return prev;
      const next = { ...prev };
      delete next[activeProjectId];
      return next;
    });
  }, [activeProjectId, worktrees, pinnedCheckout]);

  // Re-read the account-wide usage snapshot a user hook writes (~/.aya/usage.json).
  // Aya only reads the file — it never fetches usage or touches any token.
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void window.aya.getUsage().then((u) => {
        if (!cancelled) {
          setUsageAccounts((prev) => (samePollPayload(prev, u) ? prev : u));
        }
      });
      void window.aya.getCodexUsage().then((u) => {
        if (!cancelled) {
          setCodexUsageAccounts((prev) =>
            samePollPayload(prev, u) ? prev : u,
          );
        }
      });
    };
    const stop = pollVisible(refresh, USAGE_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void window.aya.listMonitoredSessions().then((sessions) => {
        if (!cancelled) {
          setMonitoredSessions((prev) =>
            samePollPayload(prev, sessions) ? prev : sessions,
          );
        }
      });
    };
    const stop = pollVisible(refresh, SESSION_MONITOR_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  // Handle "open this directory" requests from main — fired by `aya <dir>`
  // CLI invocations and the initial argv. Subscribed once; uses a ref to
  // always see the latest projects + handlers without resubscribing.
  //
  // The IPC can arrive on `did-finish-load`, which is BEFORE the bootstrap
  // useEffect has populated projects state. If we processed it then, the
  // "find by directory" check sees an empty list and falls through to
  // auto-create — producing a duplicate next to whatever bootstrap loads.
  // So we buffer requests until bootstrap signals ready, then drain.
  const openProjectRef = useRef<(dir: string) => void>(() => {});
  const bootReadyRef = useRef(false);
  const pendingOpenRef = useRef<string[]>([]);
  useEffect(() => {
    return window.aya.onOpenProject((dir) => {
      if (!bootReadyRef.current) {
        pendingOpenRef.current.push(dir);
        return;
      }
      openProjectRef.current(dir);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.aya.scanHarnesses().then((found) => {
      if (cancelled) return;
      setFoundHarnessCount(found.length);
      setHarnessScanDone(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Drain the open-project queue once bootstrap commits. Running this in a
  // useEffect (not inline after setDidBootstrap) guarantees React has flushed
  // setProjects → projectsRef.current before the handler tries to match by
  // directory. Without this gate the drain raced the commit and "aya <known
  // project path>" auto-created a duplicate, hitting the slug-collision error.
  useEffect(() => {
    if (!didBootstrap) return;
    bootReadyRef.current = true;
    const queued = pendingOpenRef.current;
    pendingOpenRef.current = [];
    for (const dir of queued) openProjectRef.current(dir);
  }, [didBootstrap]);

  // Track fullscreen state so platform chrome can change without hiding
  // Aya's normal project tabs and controls.
  useEffect(() => {
    let active = true;
    void window.aya.isFullScreen().then((fs) => {
      if (active) setIsFullScreen(fs);
    });
    const unsubscribe = window.aya.onFullScreenChange((fs) => {
      setIsFullScreen(fs);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let active = true;
    void window.aya.isMaximized().then((maximized) => {
      if (active) setIsMaximized(maximized);
    });
    const unsubscribe = window.aya.onMaximizedChange((maximized) => {
      setIsMaximized(maximized);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  // Reload config when one of the user-editable files under ~/.aya/ is edited while
  // Aya is running. Without this, an edit made by hand to snippets/presets/themes.json
  // would be overwritten by the next save in the app
  useEffect(() => {
    return window.aya.onConfigChange(({ slice }) => {
      if (slice === "snippets") {
        void window.aya
          .listSnippets()
          .then(setSnippets)
          .catch((e) =>
            console.warn(
              "config hot-reload (snippets) failed; keeping current state",
              e,
            ),
          );
      } else if (slice === "presets") {
        void window.aya
          .listPresets()
          .then(setPresets)
          .catch((e) =>
            console.warn(
              "config hot-reload (presets) failed; keeping current state",
              e,
            ),
          );
      } else if (slice === "themes") {
        void window.aya
          .listThemes()
          .then((file) => {
            setThemes(file.themes);
            setActiveThemeId(file.activeId);
          })
          .catch((e) =>
            console.warn(
              "config hot-reload (themes) failed; keeping current state",
              e,
            ),
          );
      } else if (slice === "projects") {
        // External edit to projects/*.json (#4). Disk wins for config, but the
        // merge never kills running terminals: removed tabs keep their live
        // rows, added tabs appear without spawning, a deleted file of an OPEN
        // project leaves it in place as unsaved.
        void window.aya
          .listProjects()
          .then((disk) => {
            const openSlugs = new Set(
              projectsRef.current.map((p) => p.slug),
            );
            const merged = mergeProjectsFromDisk(
              disk,
              allProjectsRef.current,
              openSlugs,
            );
            setAllProjects(merged);
            setProjects((prev) =>
              prev.map(
                (p) => merged.find((m) => m.slug === p.slug) ?? p,
              ),
            );
            setTerminals((prev) =>
              applyExternalProjectEdits(prev, merged, openSlugs),
            );
          })
          .catch((e) =>
            console.warn(
              "config hot-reload (projects) failed; keeping current state",
              e,
            ),
          );
      }
    });
  }, []);

  const terminalsRef = useRef(terminals);
  terminalsRef.current = terminals;
  const allProjectsRef = useRef(allProjects);
  allProjectsRef.current = allProjects;
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const projectStateRef = useRef(projectState);
  projectStateRef.current = projectState;
  // Mirrors the active-tab map. closeTerminal advances this ref itself, so a
  // close arriving before the re-render still resolves the CURRENT active tab
  // rather than the one just closed.
  const activeTabByProjectRef = useRef(activeTabByProject);
  activeTabByProjectRef.current = activeTabByProject;
  const activeProjectIdRef = useRef(activeProjectId);
  activeProjectIdRef.current = activeProjectId;
  // Split panes are unsupported in the experimental "projects-left" layout. The
  // ref lets the split callbacks below (defined before the render-time gating)
  // bail out, so keyboard shortcuts and pane clicks can't create or reshape a
  // split that would only surface after switching back to the classic layout.
  const splitEnabled = layoutMode !== "projects-left";
  const splitEnabledRef = useRef(splitEnabled);
  splitEnabledRef.current = splitEnabled;
  const presetsRef = useRef(presets);
  presetsRef.current = presets;
  const remotePresetsByProjectRef = useRef(remotePresetsByProject);
  remotePresetsByProjectRef.current = remotePresetsByProject;
  const terminalOutputRef = useRef<Record<string, string[]>>({});
  const localSummariesEnabledRef = useRef(localSummariesEnabled);
  localSummariesEnabledRef.current = localSummariesEnabled;
  const ayaIntelligenceRef = useRef(ayaIntelligence);
  ayaIntelligenceRef.current = ayaIntelligence;
  const summaryMetaRef = useRef<
    Record<
      string,
      { hash: string; updatedAt: number; inFlight: boolean; lineCount: number }
    >
  >({});
  const summaryTimersRef = useRef<Record<string, number>>({});

  const runAutomaticSummary = useCallback(
    async (
      key: string,
      kind: "terminal" | "project",
      lines: string[],
      apply: (summary: string) => void,
    ) => {
      const intelligence = ayaIntelligenceRef.current;
      if (
        !localSummariesEnabledRef.current ||
        (intelligence.provider === "apple" && window.aya.platform !== "darwin")
      ) {
        return;
      }
      const recent = lines.slice(-LOCAL_SUMMARY_MAX_LINES);
      if (recent.length < 2) {
        setAutoSummaryStatus((prev) => ({
          ...prev,
          lastEvent: `${kind}: not enough output (${recent.length} line${recent.length === 1 ? "" : "s"}).`,
        }));
        return;
      }
      const hash = summaryHash(recent);
      const meta = summaryMetaRef.current[key];
      if (meta?.inFlight || meta?.hash === hash) return;
      if (
        meta &&
        Date.now() - meta.updatedAt < LOCAL_SUMMARY_MIN_UPDATE_MS &&
        recent.length - meta.lineCount < LOCAL_SUMMARY_MIN_NEW_LINES
      ) {
        return;
      }
      summaryMetaRef.current[key] = {
        hash,
        updatedAt: Date.now(),
        inFlight: true,
        lineCount: recent.length,
      };
      try {
        const result = await window.aya.summarizeLocal({
          kind,
          lines: recent,
          intelligence,
        });
        if (!result.available) {
          const message = localSummaryUnavailableMessage(
            result.error,
            intelligence.provider,
          );
          setAutoSummaryStatus((prev) => ({
            ...prev,
            lastEvent: `${kind}: ${message}`,
          }));
          return;
        }
        if (!result.useful) {
          setAutoSummaryStatus((prev) => ({
            ...prev,
            lastEvent: `${kind}: provider returned no useful summary.`,
          }));
          return;
        }
        apply(result.summary);
        setAutoSummaryStatus((prev) => ({
          ...prev,
          lastEvent: `${kind}: ${result.summary}`,
        }));
      } catch {
        setAutoSummaryStatus((prev) => ({
          ...prev,
          lastEvent: `${kind}: request failed.`,
        }));
      } finally {
        const current = summaryMetaRef.current[key];
        if (current?.hash === hash) {
          summaryMetaRef.current[key] = {
            ...current,
            updatedAt: Date.now(),
            inFlight: false,
            lineCount: recent.length,
          };
        }
      }
    },
    [],
  );

  const scheduleTerminalSummary = useCallback(
    (terminalId: string) => {
      window.clearTimeout(summaryTimersRef.current[terminalId]);
      summaryTimersRef.current[terminalId] = window.setTimeout(() => {
        const terminal = terminalsRef.current[terminalId];
        if (!terminal) return;
        const terminalLines = terminalOutputRef.current[terminalId] ?? [];
        const outputEntries = Object.values(terminalOutputRef.current);
        setAutoSummaryStatus((prev) => ({
          ...prev,
          terminalCount: Object.keys(terminalsRef.current).length,
          terminalsWithLines: outputEntries.filter((lines) => lines.length > 0)
            .length,
          totalLines: outputEntries.reduce((sum, lines) => sum + lines.length, 0),
        }));
        void runAutomaticSummary(
          `terminal:${terminalId}`,
          "terminal",
          terminalLines,
          (summary) =>
            setTerminalSummaries((prev) => ({
              ...prev,
              [terminalId]: summary,
            })),
        );
        const projectLines = Object.values(terminalsRef.current)
          .filter((item) => item.projectSlug === terminal.projectSlug)
          .flatMap((item) => terminalOutputRef.current[item.id] ?? []);
        void runAutomaticSummary(
          `project:${terminal.projectSlug}`,
          "project",
          projectLines,
          (summary) =>
            setProjectSummaries((prev) => ({
              ...prev,
              [terminal.projectSlug]: summary,
            })),
        );
      }, LOCAL_SUMMARY_DEBOUNCE_MS);
    },
    [runAutomaticSummary],
  );

  const rememberTerminalOutput = useCallback((terminalId: string, chunk: string) => {
    // Summaries are opt-in; when off, skip the regex cleaning, buffering, and
    // scheduling entirely so PTY output isn't taxed on its hot path.
    if (!localSummariesEnabledRef.current) return;
    const lines = cleanTerminalOutput(chunk);
    if (lines.length === 0) return;
    const current = terminalOutputRef.current[terminalId] ?? [];
    terminalOutputRef.current[terminalId] = [...current, ...lines].slice(
      -LOCAL_SUMMARY_BUFFER_LINES,
    );
    // scheduleTerminalSummary already debounces the actual summary work off
    // refs (no per-chunk render). The account-wide "refresh all" effect is
    // driven by mount / its interval / settings changes / the manual button —
    // bumping state on every chunk just re-rendered the whole app for nothing.
    scheduleTerminalSummary(terminalId);
  }, [scheduleTerminalSummary]);

  useEffect(() => {
    if (!activeProjectId) return;
    setWarmProjectSlugs((prev) => [
      activeProjectId,
      ...prev.filter((slug) => slug !== activeProjectId),
    ].slice(0, WARM_PROJECT_TERMINAL_CACHE_SIZE));
  }, [activeProjectId]);

  const appendProjectEvent = useCallback(
    (event: Omit<ProjectEvent, "id" | "createdAt"> & { createdAt?: number }) => {
      setProjectEvents((prev) => [
        {
          ...event,
          id: uuid(),
          createdAt: event.createdAt ?? Date.now(),
        },
        ...prev,
      ].slice(0, MAX_PROJECT_EVENTS));
    },
    [],
  );

  const handlePtyTimelineEvent = useCallback(
    (event: PtyEvent) => {
      const terminal = terminalsRef.current[event.ptyId];
      if (!terminal) return;
      if (event.type === "data" && !event.replay) {
        rememberTerminalOutput(event.ptyId, event.chunk);
      }
      if (event.type === "spawn-failed") {
        appendProjectEvent({
          projectSlug: terminal.projectSlug,
          terminalId: terminal.id,
          level: "error",
          title: `${terminal.name} failed to launch`,
          detail: event.detail,
        });
        return;
      }
      if (event.type === "exit") {
        appendProjectEvent({
          projectSlug: terminal.projectSlug,
          terminalId: terminal.id,
          level: event.exitCode === 0 ? "done" : "error",
          title:
            event.exitCode === 0
              ? `${terminal.name} exited`
              : `${terminal.name} exited with error`,
          detail: `exit ${event.exitCode}`,
        });
        return;
      }
      if (event.type === "data" && detectApproval(event.chunk)) {
        appendProjectEvent({
          projectSlug: terminal.projectSlug,
          terminalId: terminal.id,
          level: "waiting",
          title: `${terminal.name} is waiting`,
          detail: "Approval or input needed",
        });
        return;
      }
      if (event.type === "osc-status") {
        appendProjectEvent({
          projectSlug: terminal.projectSlug,
          terminalId: terminal.id,
          level: event.level === "active" ? "active" : event.level,
          title: controlStatusEventTitle(terminal.name, event.level),
          detail: event.text,
          createdAt: event.updatedAt,
        });
      }
    },
    [appendProjectEvent, rememberTerminalOutput],
  );

  const { lastActivityRef, recentlyActiveIds } = useRecentTerminalActivity();
  useDockBadge(terminals);
  // Notification clicks focus a terminal through the same cell-aware path as the
  // sidebar/search/attention-center (focusTerminal, assigned below) - via a ref
  // because focusTerminal is defined later. Tab-only selection here would leave
  // the active pane/keyboard focus on the wrong terminal in a split.
  const focusTerminalRef = useRef<(slug: string, terminalId: string) => void>(
    () => {},
  );
  const focusTerminalFromNotification = useCallback(
    (slug: string, terminalId: string) => focusTerminalRef.current(slug, terminalId),
    [],
  );
  useTerminalNotifications({
    projects,
    terminals,
    onSelectTerminal: focusTerminalFromNotification,
  });

  // Update the order/open/recent collection state. Persistence is centralised in
  // the single writer effect below, so this only updates in-memory state — it
  // never writes to disk itself (no scattered saves that can race or drop
  // fields). The active project / terminal / view live in their own state and
  // are persisted by the same writer.
  const updateProjectCollection = useCallback(
    (next: ProjectCollectionState) => {
      setProjectState({
        version: PROJECT_STATE_VERSION,
        order: dedupeSlugs(next.order),
        open: dedupeSlugs(next.open),
        recent: dedupeSlugs(next.recent),
      });
    },
    [],
  );

  // === Single persistence owner for projects-state.json ===
  // Everything that can change the persisted UI state — order/open/recent AND
  // the active project / terminal / view — flows through here and nowhere else.
  // Before this, the file was written from several places (bootstrap, the
  // collection setter, per-feature handlers); they raced, and because each
  // hand-built the payload, the active selections were dropped — that's the
  // root of #18. One debounced writer, keyed on all the inputs, makes the disk
  // a pure function of state and removes the race by construction.
  useEffect(() => {
    if (!didBootstrap) return;
    const handle = window.setTimeout(() => {
      void window.aya.saveProjectState({
        version: PROJECT_STATE_VERSION,
        order: projectState.order,
        open: projectState.open,
        recent: projectState.recent,
        activeProject: activeProjectId,
        activeTab: compactRecord(activeTabByProject),
        singleView: compactRecord(singleViewByProject),
      });
    }, PROJECT_STATE_SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [
    didBootstrap,
    projectState,
    activeProjectId,
    activeTabByProject,
    singleViewByProject,
  ]);

  // ---------------------------------------------------------------------------
  // Hydration helper — instantiates TerminalStates for a project's saved tabs.
  // Pulled out of bootstrap so the missing-dir modal can defer hydration until
  // the user decides what to do.
  // ---------------------------------------------------------------------------
  const hydrateProjectTerminals = useCallback(
    (project: ProjectConfig, effectiveCwd: string) => {
      setTerminals((prev) => {
        const next = { ...prev };
        for (const tab of project.tabs) {
          next[tab.id] = {
            id: tab.id,
            projectSlug: project.slug,
            presetId: tab.presetId,
            name: tab.name,
            // Restore the tab's worktree cwd if it had one, else the project dir.
            cwd: tab.cwd ?? effectiveCwd,
            status: "running",
            bell: false,
            exitCode: null,
            restored: true,
            ...(tab.sessionId ? { sessionId: tab.sessionId } : {}),
          };
        }
        return next;
      });
      // Default the active tab to the first one ONLY when this project has no
      // valid active tab yet. A restored selection (set from the persisted
      // activeTab on boot) must survive hydration — clobbering it here is what
      // reset the active terminal to the first tab on restart (#18).
      setActiveTabByProject((prev) => {
        const existing = prev[project.slug];
        const stillValid =
          !!existing && project.tabs.some((t) => t.id === existing);
        return {
          ...prev,
          [project.slug]: stillValid ? existing : (project.tabs[0]?.id ?? null),
        };
      });
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  useEffect(() => {
    (async () => {
      const [
        cwd,
        loadedProjects,
        loadedProjectState,
        loadedPresets,
        home,
        loadedThemes,
        loadedSnippets,
      ] =
        await Promise.all([
          window.aya.getCwd(),
          window.aya.listProjects(),
          window.aya.listProjectState(),
          window.aya.listPresets(),
          window.aya.getHomeDir(),
          window.aya.listThemes(),
          window.aya.listSnippets(),
        ]);
      setPresets(loadedPresets);
      setDefaultPresets(loadedPresets);
      setSnippets(loadedSnippets);
      setHomeDir(home);
      setThemes(loadedThemes.themes);
      setActiveThemeId(loadedThemes.activeId);

      const fallbackPreset = loadedPresets[0] ?? BUILTIN_SHELL;

      // Auto-add a shell tab to projects that have none (and persist).
      const seededProjects: ProjectConfig[] = [];
      for (const project of loadedProjects) {
        if (project.tabs.length === 0) {
          const shellTab: WorkingTab = {
            id: uuid(),
            presetId: fallbackPreset.id,
            name: defaultTabName(fallbackPreset),
          };
          const updated = { ...project, tabs: [shellTab] };
          seededProjects.push(updated);
          void window.aya.updateProject(updated);
        } else {
          seededProjects.push(project);
        }
      }
      setAllProjects(seededProjects);
      const seededSlugs = new Set(seededProjects.map((p) => p.slug));
      const order =
        loadedProjectState.order.length > 0
          ? loadedProjectState.order
          : seededProjects.map((p) => p.slug);
      const open =
        loadedProjectState.open.length > 0
          ? loadedProjectState.open
          : loadedProjectState.secondaryWindow
            ? [] // an empty secondary window is intentional, not a first run
            : seededProjects.map((p) => p.slug);
      const recent =
        loadedProjectState.recent.length > 0 ? loadedProjectState.recent : order;
      // Restore the persisted active selections, but validate them against the
      // projects/terminals that actually exist now — a deleted project or tab
      // must not leave the active pointer dangling (it would fall through to a
      // stale id instead of the first tab).
      const savedActiveTab = loadedProjectState.activeTab ?? {};
      const savedSingleView = loadedProjectState.singleView ?? {};
      const validActiveTab: Record<string, string> = {};
      const validSingleView: Record<string, string> = {};
      for (const p of seededProjects) {
        const tabIds = new Set(p.tabs.map((t) => t.id));
        if (tabIds.has(savedActiveTab[p.slug])) {
          validActiveTab[p.slug] = savedActiveTab[p.slug];
        }
        if (tabIds.has(savedSingleView[p.slug])) {
          validSingleView[p.slug] = savedSingleView[p.slug];
        }
      }
      const savedActiveProject =
        loadedProjectState.activeProject &&
        seededSlugs.has(loadedProjectState.activeProject)
          ? loadedProjectState.activeProject
          : null;

      const normalizedState: ProjectCollectionState = {
        version: PROJECT_STATE_VERSION,
        order: dedupeSlugs(order).filter((slug) => seededSlugs.has(slug)),
        open: dedupeSlugs(open).filter((slug) => seededSlugs.has(slug)),
        recent: dedupeSlugs(recent).filter((slug) => seededSlugs.has(slug)),
        activeProject: savedActiveProject,
        activeTab: validActiveTab,
        singleView: validSingleView,
      };
      // Seed in-memory state; the single writer effect persists it once
      // didBootstrap flips (no direct save here — that used to race the writer).
      setProjectState(normalizedState);
      setActiveTabByProject(validActiveTab);
      setSingleViewByProject(validSingleView);
      const openSlugSet = new Set(normalizedState.open);
      const openProjects = seededProjects.filter((p) => openSlugSet.has(p.slug));
      setProjects(openProjects);

      // Validate each project's directory in parallel.
      const dirChecks = await Promise.all(
        openProjects.map((p) =>
          p.remote ? Promise.resolve(true) : window.aya.dirExists(p.directory),
        ),
      );
      const queue: MissingDirEntry[] = [];
      for (let i = 0; i < openProjects.length; i++) {
        const project = openProjects[i];
        if (project.remote) {
          hydrateProjectTerminals(project, project.remote.directory);
          void window.aya
            .listRemotePresets(project.remote.sshTarget)
            .then((remotePresets) => {
              setRemotePresetsByProject((prev) => ({
                ...prev,
                [project.slug]: remotePresets,
              }));
            })
            .catch(() => undefined);
          continue;
        }
        if (dirChecks[i]) {
          // Dir exists — hydrate terminals normally.
          hydrateProjectTerminals(project, project.directory);
        } else {
          // Missing dir — defer hydration until the user decides.
          queue.push({
            slug: project.slug,
            name: project.name,
            directory: project.directory,
          });
        }
      }
      setMissingDirQueue(queue);

      const cwdProject = openProjects.find((p) => p.directory === cwd);
      if (cwdProject) {
        // An explicit `aya <dir>` launch still wins over the saved selection.
        setActiveProjectId(cwdProject.slug);
      } else if (savedActiveProject && openSlugSet.has(savedActiveProject)) {
        setActiveProjectId(savedActiveProject);
      } else if (openProjects.length > 0) {
        setActiveProjectId(openProjects[0].slug);
      } else {
        setActiveProjectId(null);
      }

      for (const p of openProjects) {
        if (!p.remote && dirChecks[openProjects.indexOf(p)]) {
          void window.aya.getGitInfo(p.directory).then((info) => {
            setGit((g) => mergeGitInfo(g, p.directory, info));
          });
        }
      }

      // Bootstrap fully resolved — flip didBootstrap. The drain runs in a
      // separate useEffect keyed on didBootstrap, which fires AFTER React
      // commits the setProjects above and updates projectsRef.current. A
      // setTimeout(0) here would race with that commit and find an empty
      // projectsRef, causing `aya <existingProjectPath>` to fall through to
      // create-new with a colliding slug ("Project 'agent' already exists").
      setDidBootstrap(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  usePtyEventRouter({
    currentTerminalsRef: terminalsRef,
    lastActivityRef,
    setTerminals,
    onPtyEvent: handlePtyTimelineEvent,
  });

  useEffect(() => {
    const liveIds = new Set(Object.keys(terminals));
    for (const id of Object.keys(terminalOutputRef.current)) {
      if (!liveIds.has(id)) delete terminalOutputRef.current[id];
    }
    setTerminalSummaries((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const id of Object.keys(next)) {
        if (!liveIds.has(id)) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [terminals]);

  useEffect(() => {
    try {
      const now = Date.now();
      const terminal = Object.fromEntries(
        Object.entries(terminalSummaries)
          .filter(([, summary]) => summary.trim())
          .map(([id, summary]) => [id, { summary: summary.trim(), updatedAt: now }]),
      );
      const project = Object.fromEntries(
        Object.entries(projectSummaries)
          .filter(([, summary]) => summary.trim())
          .map(([slug, summary]) => [
            slug,
            { summary: summary.trim(), updatedAt: now },
          ]),
      );
      localStorage.setItem(
        LOCAL_SUMMARY_CACHE_STORAGE_KEY,
        JSON.stringify({ terminal, project }),
      );
    } catch {
      /* ignore — summaries are a cache only */
    }
  }, [terminalSummaries, projectSummaries]);

  useEffect(() => {
    if (
      !localSummariesEnabled ||
      (ayaIntelligence.provider === "apple" && window.aya.platform !== "darwin")
    ) {
      return;
    }

    let cancelled = false;
    const runOne = async (
      key: string,
      kind: "terminal" | "project",
      lines: string[],
      apply: (summary: string) => void,
    ) => {
      const recent = lines.slice(-LOCAL_SUMMARY_MAX_LINES);
      if (recent.length < 2) {
        setAutoSummaryStatus((prev) => ({
          ...prev,
          lastEvent: `${kind}: not enough output (${recent.length} line${recent.length === 1 ? "" : "s"}).`,
        }));
        return;
      }
      const hash = summaryHash(recent);
      const meta = summaryMetaRef.current[key];
      if (meta?.inFlight || meta?.hash === hash) return;
      if (
        meta &&
        Date.now() - meta.updatedAt < LOCAL_SUMMARY_MIN_UPDATE_MS &&
        recent.length - meta.lineCount < LOCAL_SUMMARY_MIN_NEW_LINES
      ) {
        return;
      }
      summaryMetaRef.current[key] = {
        hash,
        updatedAt: Date.now(),
        inFlight: true,
        lineCount: recent.length,
      };
      try {
        const result = await window.aya.summarizeLocal({
          kind,
          lines: recent,
          intelligence: ayaIntelligence,
        });
        if (cancelled) {
          delete summaryMetaRef.current[key];
          return;
        }
        if (!result.available) {
          setAutoSummaryStatus((prev) => ({
            ...prev,
            lastEvent: `${kind}: provider unavailable${result.error ? ` (${result.error})` : ""}.`,
          }));
          return;
        }
        if (!result.useful) {
          setAutoSummaryStatus((prev) => ({
            ...prev,
            lastEvent: `${kind}: provider returned no useful summary.`,
          }));
          return;
        }
        apply(result.summary);
        setAutoSummaryStatus((prev) => ({
          ...prev,
          lastEvent: `${kind}: ${result.summary}`,
        }));
      } catch {
        setAutoSummaryStatus((prev) => ({
          ...prev,
          lastEvent: `${kind}: request failed.`,
        }));
      } finally {
        const current = summaryMetaRef.current[key];
        if (current?.hash === hash) {
          summaryMetaRef.current[key] = {
            ...current,
            updatedAt: Date.now(),
            inFlight: false,
            lineCount: recent.length,
          };
        }
      }
    };

    const linesForTerminal = async (terminalId: string): Promise<string[]> => {
      const existing = terminalOutputRef.current[terminalId] ?? [];
      if (existing.length >= 2) return existing;
      try {
        const buffered = await window.aya.ptyBuffer(terminalId);
        const lines = cleanTerminalOutput(buffered);
        if (lines.length > existing.length) {
          terminalOutputRef.current[terminalId] = lines.slice(
            -LOCAL_SUMMARY_BUFFER_LINES,
          );
          return terminalOutputRef.current[terminalId];
        }
      } catch {
        // best effort; live event collection still covers new output
      }
      return existing;
    };

    const refresh = () => {
      const terminalList = Object.values(terminalsRef.current);
      const outputEntries = Object.values(terminalOutputRef.current);
      setAutoSummaryStatus((prev) => ({
        ...prev,
        terminalCount: terminalList.length,
        terminalsWithLines: outputEntries.filter((lines) => lines.length > 0).length,
        totalLines: outputEntries.reduce((sum, lines) => sum + lines.length, 0),
      }));
      for (const terminal of terminalList) {
        void linesForTerminal(terminal.id).then((lines) =>
          runOne(`terminal:${terminal.id}`, "terminal", lines, (summary) =>
            setTerminalSummaries((prev) => ({
              ...prev,
              [terminal.id]: summary,
            })),
          ),
        );
      }

      for (const project of projectsRef.current) {
        const projectTerminals = terminalList.filter(
          (terminal) => terminal.projectSlug === project.slug,
        );
        void Promise.all(
          projectTerminals.map((terminal) => linesForTerminal(terminal.id)),
        ).then((lineGroups) => {
          const lines = lineGroups.flat().slice(-LOCAL_SUMMARY_MAX_LINES);
          return runOne(`project:${project.slug}`, "project", lines, (summary) =>
            setProjectSummaries((prev) => ({
              ...prev,
              [project.slug]: summary,
            })),
          );
        });
      }
    };

    const timeout = window.setTimeout(
      refresh,
      summaryNudge === 0 ? 0 : LOCAL_SUMMARY_DEBOUNCE_MS,
    );
    const id = window.setInterval(refresh, LOCAL_SUMMARY_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      window.clearInterval(id);
    };
  }, [ayaIntelligence, localSummariesEnabled, summaryNudge]);

  useEffect(() => {
    return window.aya.onControlStatus((update) => {
      setTerminals((prev) => {
        const entry = findStatusTarget(prev, update);
        if (!entry) return prev;
        const [id, terminal] = entry;
        if (update.level === "clear") {
          // Fall back to PTY-lifecycle truth, not the stale agent status.
          // Keeping `terminal.status` left an agent-set "error" stuck forever,
          // so `aya status clear` could never clear a red dot (#34).
          return { ...prev, [id]: clearedTerminalStatus(terminal) };
        }
        const text = update.text?.trim();
        if (!text) return prev;
        appendProjectEvent({
          projectSlug: terminal.projectSlug,
          terminalId: terminal.id,
          level: update.level === "active" ? "active" : update.level,
          title: controlStatusEventTitle(terminal.name, update.level),
          detail: text,
          createdAt: update.updatedAt,
        });
        return {
          ...prev,
          [id]: {
            ...terminal,
            status: controlLevelToTerminalStatus(update.level),
            bell: update.level === "waiting",
            externalStatus: {
              level: update.level,
              text,
              updatedAt: update.updatedAt,
            },
          },
        };
      });
    });
  }, [appendProjectEvent]);

  useEffect(() => {
    if (!didBootstrap || !activeProjectId) return;
    const project = projectsRef.current.find((p) => p.slug === activeProjectId);
    if (!project) return;
    if (project.remote) return;
    const ignoredKey = `aya:repo-config-ignored:${project.directory}`;
    if (localStorage.getItem(ignoredKey) === "1") return;
    let cancelled = false;
    void window.aya.readRepoProjectConfig(project.directory).then((config) => {
      if (cancelled || !config || config.presets.length === 0) return;
      const existingCommands = new Set(
        presetsRef.current.map((preset) => preset.command.trim()),
      );
      const existingNames = new Set(
        presetsRef.current.map((preset) => preset.name.trim().toLowerCase()),
      );
      const suggestions = config.presets.filter((preset) => {
        const command = preset.command.trim();
        const name = preset.name.trim().toLowerCase();
        return command && !existingCommands.has(command) && !existingNames.has(name);
      });
      if (suggestions.length === 0) {
        localStorage.setItem(ignoredKey, "1");
        return;
      }
      setPendingRepoImport({ project, presets: suggestions.slice(0, MAX_SUGGESTED_PRESETS) });
    });
    return () => {
      cancelled = true;
    };
  }, [activeProjectId, didBootstrap]);

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  const persistProject = useCallback(
    (slug: string, nextTerminals: Record<string, TerminalState>) => {
      const project = projectsRef.current.find((p) => p.slug === slug);
      if (!project) return;
      const tabs: WorkingTab[] = Object.values(nextTerminals)
        .filter((t) => t.projectSlug === slug)
        .map((t) => tabFromTerminal(t, projectBaseCwd(project)));
      const tree = projectSplitTree(project);
      const splitTree = tree
        ? compactTree(
            normalizeTreeForTabs(
              tree,
              new Set(tabs.map((tab) => tab.id)),
              tabs[0]?.id ?? null,
              uuid(),
            ),
          )
        : undefined;
      const updated: ProjectConfig = {
        ...project,
        tabs,
        // The legacy grid is dropped on the first save after migration.
        splitLayout: undefined,
        ...(splitTree ? { splitTree } : { splitTree: undefined }),
      };
      setAllProjects((ps) => ps.map((p) => (p.slug === slug ? updated : p)));
      setProjects((ps) => ps.map((p) => (p.slug === slug ? updated : p)));
      void window.aya.updateProject(updated);
    },
    [],
  );

  // A session id arrives asynchronously (OSC 9001) while a terminal is already
  // running, so it needs its own persist trigger — the others (launch, rename,
  // close) may never fire again before the app quits, and an unsaved id means
  // the next restore silently falls back to "latest session".
  const sessionIdSignature = Object.values(terminals)
    .filter((t) => t.sessionId)
    .map((t) => `${t.id}:${t.sessionId}`)
    .sort()
    .join("\n");
  useEffect(() => {
    if (!didBootstrap || !sessionIdSignature) return;
    const slugs = new Set(
      Object.values(terminalsRef.current)
        .filter((t) => t.sessionId)
        .map((t) => t.projectSlug),
    );
    for (const slug of slugs) persistProject(slug, terminalsRef.current);
  }, [sessionIdSignature, didBootstrap, persistProject]);

  /** The single write funnel for a project's pane layout. `updater` gets a
   *  tree already reconciled against the project's live tabs and the id of the
   *  focused pane, and returns the next tree (optionally moving focus). */
  const updateProjectSplitTree = useCallback(
    (
      slug: string,
      updater: (
        tree: SplitNode,
        activeLeafId: string,
        project: ProjectConfig,
      ) => { tree: SplitNode; activeLeafId?: string },
    ) => {
      const project = projectsRef.current.find((p) => p.slug === slug);
      if (!project) return;
      const fallbackId = activeTabByProject[slug] ?? project.tabs[0]?.id ?? null;
      const tabIds = new Set(project.tabs.map((tab) => tab.id));
      const current = normalizeTreeForTabs(
        projectSplitTree(project),
        tabIds,
        fallbackId,
        uuid(),
      );
      const currentActive = resolveActiveLeafId(
        current,
        activeLeafByProject[slug],
        fallbackId,
      );
      const result = updater(current, currentActive, project);
      const normalized = normalizeTreeForTabs(result.tree, tabIds, fallbackId, uuid());
      const splitTree = compactTree(normalized);
      const updated: ProjectConfig = {
        ...project,
        splitLayout: undefined,
        ...(splitTree ? { splitTree } : { splitTree: undefined }),
      };
      setSingleViewByProject((prev) => ({ ...prev, [slug]: null }));
      setAllProjects((ps) => ps.map((p) => (p.slug === slug ? updated : p)));
      setProjects((ps) => ps.map((p) => (p.slug === slug ? updated : p)));
      void window.aya.updateProject(updated);
      // The requested pane may have been collapsed away by normalization, so
      // resolve against the tree that actually survived.
      const nextActive = resolveActiveLeafId(
        normalized,
        result.activeLeafId ?? currentActive,
        fallbackId,
      );
      setActiveLeafByProject((prev) => ({ ...prev, [slug]: nextActive }));
      const activeTerminalId = leaves(normalized).find((l) => l.id === nextActive)
        ?.terminalId;
      if (activeTerminalId) {
        setActiveTabByProject((prev) => ({ ...prev, [slug]: activeTerminalId }));
      }
    },
    [activeTabByProject, activeLeafByProject],
  );

  /** Resolve the effective cwd for a project at terminal-launch time. Honors
   *  any session fallback (e.g. "Use home for now"). */
  const effectiveCwd = useCallback(
    (project: ProjectConfig): string => {
      return projectFallbacks[project.slug] ?? project.directory;
    },
    [projectFallbacks],
  );

  const launchTerminal = useCallback(
    (preset: Preset, cwd?: string) => {
      const slug = activeProjectIdRef.current;
      if (!slug) return;
      const project = findProject(projectsRef.current, slug);
      if (!project) return;
      const id = uuid();
      const command = remoteTerminalCommand(project, preset);
      // Default the new tab's display name to the preset's current name (not
      // its id, which stays the same when the user renames a preset).
      const term: TerminalState = {
        id,
        projectSlug: slug,
        presetId: preset.id,
        name: defaultTabName(preset),
        cwd:
          cwd ??
          (project.remote ? project.remote.directory : effectiveCwd(project)),
        status: "running",
        bell: false,
        exitCode: null,
      };
      setTerminals((prev) => {
        const next = { ...prev, [id]: term };
        const tabs: WorkingTab[] = Object.values(next)
          .filter((t) => t.projectSlug === slug)
          .map((t) => tabFromTerminal(t, projectBaseCwd(project)));
        // In the projects-left layout splits are disabled, so leave the saved
        // tree untouched (don't claim a pane for the new terminal, and don't
        // clear it) - it should come back unchanged in the classic layout.
        const existingTree = projectSplitTree(project);
        const currentTree =
          splitEnabledRef.current && existingTree
            ? normalizeTreeForTabs(
                existingTree,
                new Set(tabs.map((tab) => tab.id)),
                activeTabByProject[slug] ?? project.tabs[0]?.id ?? null,
                uuid(),
              )
            : null;
        const splitTree = currentTree
          ? compactTree(
              assignTerminal(
                currentTree,
                resolveActiveLeafId(
                  currentTree,
                  activeLeafByProject[slug],
                  activeTabByProject[slug] ?? null,
                ),
                id,
              ),
            )
          : undefined;
        const updated: ProjectConfig = {
          ...project,
          tabs,
          ...(splitEnabledRef.current
            ? { splitLayout: undefined, ...(splitTree ? { splitTree } : { splitTree: undefined }) }
            : {}),
        };
        setAllProjects((ps) => ps.map((p) => (p.slug === slug ? updated : p)));
        setProjects((ps) => ps.map((p) => (p.slug === slug ? updated : p)));
        void window.aya.updateProject(updated);
        return next;
      });
      setActiveTabByProject((prev) => ({ ...prev, [slug]: id }));
      setSingleViewByProject((prev) => ({
        ...prev,
        [slug]: projectSplitTree(project) && prev[slug] ? id : null,
      }));
      appendProjectEvent({
        projectSlug: slug,
        terminalId: id,
        level: "active",
        title: `${term.name} started`,
        detail: command,
      });
    },
    [activeTabByProject, appendProjectEvent, effectiveCwd],
  );

  const closeTerminal = useCallback(
    (id: string) => {
      const t = terminalsRef.current[id];
      if (!t) return;
    // Drop the confirmed-session marker so the id doesn't linger (and can't be
    // mistaken for a re-mount if the id were ever reused).
    forgetSpawn(id);
    // Drop the restart-trigger counter too - entries are tiny, but a
    // long-lived session cycling many tabs would otherwise retain one per
    // closed id forever (#94).
    setRestartTriggers((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    void window.aya.ptyKill(id);
    appendProjectEvent({
      projectSlug: t.projectSlug,
      terminalId: t.id,
      level: "info",
      title: `${t.name} closed`,
    });
    // Advance the refs now instead of waiting for the re-render. Closes can
    // arrive back-to-back - two quick Cmd+W, a script driving the control
    // socket - and the next one resolves "the active tab" through these refs.
    // While they still named the tab we just closed, that second close looked
    // up a terminal that was already gone and silently did nothing.
    const nextTerminals = { ...terminalsRef.current };
    delete nextTerminals[id];
    terminalsRef.current = nextTerminals;
    if (activeTabByProjectRef.current[t.projectSlug] === id) {
      const remaining = Object.values(nextTerminals).filter(
        (x) => x.projectSlug === t.projectSlug,
      );
      const nextActive =
        remaining.length > 0 ? remaining[remaining.length - 1].id : null;
      activeTabByProjectRef.current = {
        ...activeTabByProjectRef.current,
        [t.projectSlug]: nextActive,
      };
      setActiveTabByProject((p) =>
        p[t.projectSlug] === id ? { ...p, [t.projectSlug]: nextActive } : p,
      );
    }
    setTerminals((prev) => {
        const next = { ...prev };
        delete next[id];
        persistProject(t.projectSlug, next);
        return next;
      });
    },
    [appendProjectEvent, persistProject],
  );

  // Drop a terminal's agent status overlay once the user attends to it (#34,
  // Part 1). The overlay is an attention signal for terminals you are NOT
  // looking at, so the act of focusing the terminal IS the acknowledgement -
  // there is deliberately no separate "dismiss" control. Same
  // fall-back-to-PTY-truth as the control-socket `clear`; a real exit/spawn
  // error has no overlay and stays untouched. Returns `prev` when there is
  // nothing to clear so React can skip the re-render. The project-tab badge is
  // a pure aggregate over its terminals, so it keeps glowing until the last
  // flagged terminal is visited - no separate project-level clear needed.
  const clearTerminalStatus = useCallback((id: string) => {
    setTerminals((prev) => {
      const t = prev[id];
      if (!t || !t.externalStatus) return prev;
      return { ...prev, [id]: clearedTerminalStatus(t) };
    });
  }, []);

  // Switching to a terminal (sidebar click, keyboard tab-switch, split-pane
  // focus) acknowledges its overlay. Keyed on the active-tab map, so it fires
  // on the transition TO a terminal; clearTerminalStatus no-ops when there is
  // no overlay. Does not depend on `terminals`, so clearing can't re-trigger it.
  useEffect(() => {
    const id = activeProjectId ? activeTabByProject[activeProjectId] : null;
    if (id) clearTerminalStatus(id);
  }, [activeProjectId, activeTabByProject, clearTerminalStatus]);

  // Restart the detached PTY host (#28). This necessarily kills every running
  // terminal process - their PTYs are children of the host - so we mark all
  // terminals as exited rather than auto-respawning (maintainer decision:
  // leave tabs stopped; the user restarts each with Shift+Enter). Used by both
  // the stale-host banner and the Settings action.
  const restartPtyHost = useCallback(async () => {
    try {
      await window.aya.restartPtyHost();
    } catch {
      // Restart failed (host unreachable or already dead). The IPC handler
      // only clears the stale flag on success, so the amber icon stays and
      // the user can retry via "Restart Aya" from the menu.
      return;
    }
    setTerminals((prev) => {
      const next: typeof prev = {};
      for (const [id, t] of Object.entries(prev)) {
        // `stopped` (not a fake exitCode 0) marks the PTY as killed-by-restart:
        // shows idle + restartable via Shift+Enter, without masquerading as a
        // clean "done" finish in the project badges or event log.
        next[id] = { ...t, status: "idle", stopped: true, bell: false };
      }
      return next;
    });
  }, []);

  const renameTerminal = useCallback(
    (id: string, name: string) => {
      setTerminals((prev) => {
        const t = prev[id];
        if (!t) return prev;
        const next = { ...prev, [id]: { ...t, name } };
        persistProject(t.projectSlug, next);
        return next;
      });
    },
    [persistProject],
  );

  const assignTerminalToActiveSplitCell = useCallback((id: string) => {
    const terminal = terminalsRef.current[id];
    if (!terminal) return;
    setActiveTabByProject((prev) => ({ ...prev, [terminal.projectSlug]: id }));
    updateProjectSplitTree(terminal.projectSlug, (tree, activeLeafId) => ({
      tree: assignTerminal(tree, activeLeafId, id),
    }));
  }, [updateProjectSplitTree]);

  const assignTerminalToSplitCell = useCallback(
    (id: string, leafId: string) => {
      const terminal = terminalsRef.current[id];
      if (!terminal) return;
      setSingleViewByProject((prev) => ({ ...prev, [terminal.projectSlug]: null }));
      setActiveTabByProject((prev) => ({ ...prev, [terminal.projectSlug]: id }));
      updateProjectSplitTree(terminal.projectSlug, (tree) => ({
        tree: assignTerminal(tree, leafId, id),
        activeLeafId: leafId,
      }));
    },
    [updateProjectSplitTree],
  );

  const collapseToSingleTerminal = useCallback((terminal: TerminalState) => {
    setActiveTabByProject((prev) => ({ ...prev, [terminal.projectSlug]: terminal.id }));
    setSingleViewByProject((prev) => ({
      ...prev,
      [terminal.projectSlug]: terminal.id,
    }));
    setTerminals((prev) => {
      const cur = prev[terminal.id];
      if (!cur || !cur.bell) return prev;
      return { ...prev, [terminal.id]: { ...cur, bell: false } };
    });
  }, []);

  const selectTerminalFromSidebar = useCallback(
    (id: string) => {
      const terminal = terminalsRef.current[id];
      if (!terminal) return;
      const project = projectsRef.current.find((p) => p.slug === terminal.projectSlug);
      if (!project) return;
      const existing = projectSplitTree(project);
      const tree = normalizeTreeForTabs(
        existing,
        new Set(project.tabs.map((tab) => tab.id)),
        activeTabByProject[project.slug] ?? project.tabs[0]?.id ?? null,
        uuid(),
      );
      const holding = findLeafByTerminal(tree, id);
      if (existing && holding) {
        // Already on screen: just move focus to its pane.
        setSingleViewByProject((prev) => ({ ...prev, [project.slug]: null }));
        updateProjectSplitTree(project.slug, (current) => ({
          tree: current,
          activeLeafId: findLeafByTerminal(current, id)?.id,
        }));
        setActiveTabByProject((prev) => ({ ...prev, [project.slug]: id }));
        return;
      }
      collapseToSingleTerminal(terminal);
    },
    [activeTabByProject, collapseToSingleTerminal, updateProjectSplitTree],
  );

  const addTerminalSplit = useCallback(
    (id: string, direction: "right" | "below") => {
      const terminal = terminalsRef.current[id];
      if (!terminal) return;
      setSingleViewByProject((prev) => ({ ...prev, [terminal.projectSlug]: null }));
      setActiveTabByProject((prev) => ({ ...prev, [terminal.projectSlug]: id }));
      // The whole grid-shuffling dance this replaced existed only because a
      // split had to insert a full row/column. A tree divides just this pane.
      updateProjectSplitTree(terminal.projectSlug, (tree, activeLeafId) => {
        const newLeafId = uuid();
        const withPane = assignTerminal(tree, activeLeafId, id);
        return {
          tree: splitLeaf(
            withPane,
            activeLeafId,
            direction === "right" ? "row" : "column",
            uuid(),
            newLeafId,
          ),
          activeLeafId: newLeafId,
        };
      });
    },
    [updateProjectSplitTree],
  );

  const removeTerminalFromSplit = useCallback(
    (id: string) => {
      const terminal = terminalsRef.current[id];
      if (!terminal) return;
      updateProjectSplitTree(terminal.projectSlug, (tree) => ({
        tree: removeTerminal(tree, id),
      }));
    },
    [updateProjectSplitTree],
  );

  /** Focus a pane by id (mouse click on a pane, or filling an empty one).
   *  Keeping the active terminal in sync is what makes the sidebar highlight
   *  and the clear-on-focus effect follow a click, not just keyboard nav. */
  const setActiveSplitCell = useCallback(
    (slug: string, leafId: string) => {
      if (!splitEnabledRef.current) return;
      setSingleViewByProject((prev) => ({ ...prev, [slug]: null }));
      updateProjectSplitTree(slug, (tree) => ({ tree, activeLeafId: leafId }));
    },
    [updateProjectSplitTree],
  );

  const resizeSplit = useCallback(
    (slug: string, splitId: string, ratio: number) => {
      updateProjectSplitTree(slug, (tree, activeLeafId) => ({
        tree: resizeSplitNode(tree, splitId, ratio),
        activeLeafId,
      }));
    },
    [updateProjectSplitTree],
  );

  /** Directional pane navigation. Geometric rather than grid arithmetic: with
   *  a tree the panes no longer line up in rows and columns, so "the pane to
   *  the right" is whichever rectangle actually sits there. */
  const focusSplitPane = useCallback(
    (direction: "left" | "right" | "up" | "down") => {
      if (!splitEnabledRef.current) return;
      if (!activeProjectId) return;
      const project = projectsRef.current.find((p) => p.slug === activeProjectId);
      if (!project) return;
      const existing = projectSplitTree(project);
      if (!existing) return;
      const fallbackId = activeTabByProject[project.slug] ?? project.tabs[0]?.id ?? null;
      const tree = normalizeTreeForTabs(
        existing,
        new Set(project.tabs.map((tab) => tab.id)),
        fallbackId,
        uuid(),
      );
      const from = resolveActiveLeafId(
        tree,
        activeLeafByProject[project.slug],
        fallbackId,
      );
      const target = focusDirection(tree, from, direction);
      if (!target) return; // at the edge — a no-op, never a wrap-around
      setSingleViewByProject((prev) => ({ ...prev, [project.slug]: null }));
      updateProjectSplitTree(project.slug, (current) => ({
        tree: current,
        activeLeafId: target,
      }));
    },
    [activeProjectId, activeTabByProject, activeLeafByProject, updateProjectSplitTree],
  );

  const splitActivePane = useCallback(
    (direction: "right" | "below") => {
      if (!splitEnabledRef.current) return;
      if (!activeProjectId) return;
      const project = projectsRef.current.find((p) => p.slug === activeProjectId);
      if (!project) return;
      const fallbackId = activeTabByProject[project.slug] ?? project.tabs[0]?.id ?? null;
      const tree = normalizeTreeForTabs(
        projectSplitTree(project),
        new Set(project.tabs.map((tab) => tab.id)),
        fallbackId,
        uuid(),
      );
      const activeLeafId = resolveActiveLeafId(
        tree,
        activeLeafByProject[project.slug],
        fallbackId,
      );
      const terminalId =
        singleViewByProject[project.slug] ??
        leaves(tree).find((l) => l.id === activeLeafId)?.terminalId ??
        fallbackId;
      if (terminalId) addTerminalSplit(terminalId, direction);
    },
    [
      activeProjectId,
      activeTabByProject,
      activeLeafByProject,
      addTerminalSplit,
      singleViewByProject,
    ],
  );

  /** Reorder project tabs. Persists the new slug order to disk so a
   *  restart preserves the user's choice. */
  const reorderProjects = useCallback(async (orderedSlugs: string[]) => {
    const nextOrder = dedupeSlugs([
      ...orderedSlugs,
      ...projectStateRef.current.order.filter(
        (slug) => !orderedSlugs.includes(slug),
      ),
    ]);
    setProjects((prev) => {
      const bySlug = new Map(prev.map((p) => [p.slug, p]));
      const out: ProjectConfig[] = [];
      // Reordered ones first in their new order
      for (const slug of orderedSlugs) {
        const p = bySlug.get(slug);
        if (p) out.push(p);
      }
      // Then anything not mentioned (shouldn't happen normally) goes after
      for (const p of prev) {
        if (!orderedSlugs.includes(p.slug)) out.push(p);
      }
      return out;
    });
    updateProjectCollection({
      ...projectStateRef.current,
      order: nextOrder,
    });
  }, [updateProjectCollection]);

  /** Reorder a project's terminal tabs. Walks the terminals map and
   *  rebuilds it with the new key order — `project.tabs` is derived from
   *  this map's filter+map so persistence comes along for free. */
  const reorderTerminalsInProject = useCallback(
    (slug: string, orderedIds: string[]) => {
      setTerminals((prev) => {
        const next: Record<string, TerminalState> = {};
        for (const id of orderedIds) {
          const t = prev[id];
          if (t && t.projectSlug === slug) next[id] = t;
        }
        for (const [id, t] of Object.entries(prev)) {
          if (!(id in next)) next[id] = t;
        }
        persistProject(slug, next);
        return next;
      });
    },
    [persistProject],
  );

  /** Rename a project — updates the JSON's `name` field. The slug (file
   *  identity) stays the same so existing references aren't broken. */
  const renameProject = useCallback(
    async (slug: string, newName: string) => {
      const trimmed = newName.trim();
      if (!trimmed) return;
      const project = projectsRef.current.find((p) => p.slug === slug);
      if (!project || project.name === trimmed) return;
      const updated = { ...project, name: trimmed };
      setAllProjects((prev) =>
        prev.map((p) => (p.slug === slug ? updated : p)),
      );
      setProjects((prev) =>
        prev.map((p) => (p.slug === slug ? updated : p)),
      );
      try {
        await window.aya.updateProject(updated);
      } catch (err) {
        console.error("renameProject failed:", err);
      }
    },
    [],
  );

  /** Close the project tab without deleting its JSON config. Closed projects
   *  stay available from search / recent projects but do not auto-reopen. */
  /** Create a worktree for the active project. Git's own error text is shown
   *  verbatim — "a branch named 'x' already exists" is exactly what the user
   *  needs, and a silent failure would look like a broken button. */
  const createWorktreeForProject = useCallback(async () => {
    const project = projectsRef.current.find((p) => p.slug === activeProjectId);
    if (!project || project.remote) return;
    const branch = window.prompt("New worktree — branch name:")?.trim();
    if (!branch) return;
    const parent = project.directory.replace(/\/+$/, "");
    const suggested = `${parent}-${branch.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
    const path = window.prompt("Worktree directory:", suggested)?.trim();
    if (!path) return;
    const result = await window.aya.createWorktree({
      directory: project.directory,
      path,
      branch,
    });
    if (!result.ok) {
      window.alert(`Could not create the worktree:\n\n${result.error}`);
      return;
    }
    setWorktreeNudge((n) => n + 1);
  }, [activeProjectId]);

  const removeWorktreeForProject = useCallback(
    async (worktree: Worktree) => {
      const project = projectsRef.current.find((p) => p.slug === activeProjectId);
      if (!project || worktree.isMain) return;
      if (
        !window.confirm(
          `Remove the worktree at ${worktree.path}?\n\nThe branch itself is kept.`,
        )
      ) {
        return;
      }
      let result = await window.aya.removeWorktree({
        directory: project.directory,
        path: worktree.path,
      });
      // Git refuses while the checkout is dirty. Losing uncommitted work is
      // the user's call to make, so ask rather than forcing by default.
      if (!result.ok && /contains modified or untracked files|not empty/i.test(result.error)) {
        if (
          !window.confirm(
            `${result.error}\n\nDiscard those changes and remove it anyway?`,
          )
        ) {
          return;
        }
        result = await window.aya.removeWorktree({
          directory: project.directory,
          path: worktree.path,
          force: true,
        });
      }
      if (!result.ok) {
        window.alert(`Could not remove the worktree:\n\n${result.error}`);
        return;
      }
      setWorktreeNudge((n) => n + 1);
    },
    [activeProjectId],
  );

  const closeProject = useCallback(async (slug: string) => {
    const owned = Object.values(terminalsRef.current).filter(
      (t) => t.projectSlug === slug,
    );
    for (const t of owned) {
      void window.aya.ptyKill(t.id);
    }
    setTerminals((prev) => {
      const next = { ...prev };
      for (const t of owned) delete next[t.id];
      return next;
    });
      setActiveTabByProject((prev) => {
        const next = { ...prev };
        delete next[slug];
        return next;
      });
    setSingleViewByProject((prev) => {
      const next = { ...prev };
      delete next[slug];
      return next;
    });
    setWarmProjectSlugs((prev) => prev.filter((s) => s !== slug));
    const remaining = projectsRef.current.filter((p) => p.slug !== slug);
    setProjects(remaining);
    updateProjectCollection({
      ...projectStateRef.current,
      open: remaining.map((p) => p.slug),
      recent: dedupeSlugs([slug, ...projectStateRef.current.recent]),
    });
    setActiveProjectId((cur) => {
      if (cur !== slug) return cur;
      return remaining[0]?.slug ?? null;
    });
    setGit((prev) => {
      const next = { ...prev };
      delete next[slug];
      return next;
    });
    setProjectFallbacks((prev) => {
      const next = { ...prev };
      delete next[slug];
      return next;
    });
  }, []);

  /** Hand a project to another window: drop ALL local state for it WITHOUT
   *  killing its PTYs (they live in the detached host; the adopting window
   *  re-attaches like after an app restart) and WITHOUT touching recent (the
   *  project stays open - just elsewhere). Mirrors closeProject minus the
   *  ptyKill loop and the recent bump. */
  const releaseProject = useCallback((slug: string) => {
    const owned = Object.values(terminalsRef.current).filter(
      (t) => t.projectSlug === slug,
    );
    setTerminals((prev) => {
      const next = { ...prev };
      for (const t of owned) delete next[t.id];
      return next;
    });
    setActiveTabByProject((prev) => {
      const next = { ...prev };
      delete next[slug];
      return next;
    });
    setSingleViewByProject((prev) => {
      const next = { ...prev };
      delete next[slug];
      return next;
    });
    setWarmProjectSlugs((prev) => prev.filter((s) => s !== slug));
    const remaining = projectsRef.current.filter((p) => p.slug !== slug);
    setProjects(remaining);
    updateProjectCollection({
      ...projectStateRef.current,
      open: remaining.map((p) => p.slug),
    });
    setActiveProjectId((cur) => {
      if (cur !== slug) return cur;
      return remaining[0]?.slug ?? null;
    });
    setGit((prev) => {
      const next = { ...prev };
      delete next[slug];
      return next;
    });
    setProjectFallbacks((prev) => {
      const next = { ...prev };
      delete next[slug];
      return next;
    });
  }, []);

  /** Move a project (its tab + running terminals) to another Aya window, or
   *  tear it out into a new one. Local projects only for now - a remote
   *  project's directory lives on the remote host, so the adopt-by-directory
   *  flow can't resolve it there. */
  const moveProjectToWindow = useCallback(
    (slug: string, target: number | "new", at?: { x: number; y: number }) => {
      const project = projectsRef.current.find((p) => p.slug === slug);
      if (!project || project.remote) return;
      // Chrome semantics: a window that loses its last tab closes itself.
      // Without this the emptied window lingers (often hidden behind another)
      // and keeps showing up as a phantom "Move to window…" target.
      const emptiesThisWindow =
        projectsRef.current.filter((p) => p.slug !== slug).length === 0;
      releaseProject(slug);
      void window.aya
        .adoptProjectInWindow(project.directory, target, at)
        .then(() => {
          if (emptiesThisWindow) void window.aya.closeWindow();
        });
    },
    [releaseProject],
  );

  const openKnownProject = useCallback(
    async (project: ProjectConfig) => {
      const alreadyOpen = projectsRef.current.find(
        (p) => p.slug === project.slug,
      );
      if (alreadyOpen) {
        setActiveProjectId(alreadyOpen.slug);
        return;
      }
      const nextProjects = [...projectsRef.current, project];
      setProjects(nextProjects);
      setActiveProjectId(project.slug);
      updateProjectCollection({
        ...projectStateRef.current,
        order: dedupeSlugs([...projectStateRef.current.order, project.slug]),
        open: nextProjects.map((p) => p.slug),
        recent: dedupeSlugs([project.slug, ...projectStateRef.current.recent]),
      });

      if (project.remote) {
        // No git entry for remotes: activeGitDirectory is null for them, so the
        // status bar has nothing to look up and renders no git strip.
        hydrateProjectTerminals(project, project.remote.directory);
        void window.aya
          .listRemotePresets(project.remote.sshTarget)
          .then((remotePresets) => {
            setRemotePresetsByProject((prev) => ({
              ...prev,
              [project.slug]: remotePresets,
            }));
          })
          .catch(() => undefined);
        return;
      }
      const exists = await window.aya.dirExists(project.directory);
      if (exists) {
        hydrateProjectTerminals(project, project.directory);
        void window.aya.getGitInfo(project.directory).then((info) => {
          setGit((g) => mergeGitInfo(g, project.directory, info));
        });
      } else {
        setMissingDirQueue((prev) => [
          ...prev,
          {
            slug: project.slug,
            name: project.name,
            directory: project.directory,
          },
        ]);
      }
    },
    [hydrateProjectTerminals, updateProjectCollection],
  );

  const onCreateProject = useCallback(
    async (name: string, directory: string) => {
      try {
        const project = await window.aya.createProject(name, directory);
        const fallbackPreset = presetsRef.current[0] ?? BUILTIN_SHELL;
        const shellTab: WorkingTab = {
          id: uuid(),
          presetId: fallbackPreset.id,
          name: defaultTabName(fallbackPreset),
        };
        const withTabs: ProjectConfig = { ...project, tabs: [shellTab] };
        void window.aya.updateProject(withTabs);
        setAllProjects((prev) => [...prev, withTabs]);
        const nextProjects = [...projectsRef.current, withTabs];
        setProjects(nextProjects);
        updateProjectCollection({
          ...projectStateRef.current,
          order: dedupeSlugs([...projectStateRef.current.order, withTabs.slug]),
          open: nextProjects.map((p) => p.slug),
          recent: dedupeSlugs([withTabs.slug, ...projectStateRef.current.recent]),
        });
        setTerminals((prev) => ({
          ...prev,
          [shellTab.id]: {
            id: shellTab.id,
            projectSlug: withTabs.slug,
            presetId: shellTab.presetId,
            name: shellTab.name,
            cwd: withTabs.directory,
            status: "running",
            bell: false,
            exitCode: null,
          },
        }));
        setActiveTabByProject((prev) => ({
          ...prev,
          [withTabs.slug]: shellTab.id,
        }));
        setActiveProjectId(withTabs.slug);
        void window.aya.getGitInfo(withTabs.directory).then((info) =>
          setGit((g) => mergeGitInfo(g, withTabs.directory, info)),
        );
        setNewProjectModal(null);
      } catch (err) {
        console.error(err);
        alert(err instanceof Error ? err.message : String(err));
      }
    },
    [updateProjectCollection],
  );

  const onCreateRemoteProject = useCallback(
    async (result: RemoteProjectCreateResult, sshTarget: string) => {
      try {
        const remoteProject = result.project;
        const localProject = await window.aya.createRemoteProject({
          name: remoteProject.name,
          directory: remoteProject.directory,
          hostId: result.host.id,
          label: result.host.name || result.host.id,
          sshTarget,
        });
        // Replace any existing entry with the same slug rather than append:
        // createRemoteProject is idempotent now (re-opening an existing remote
        // project returns it), so a blind push would duplicate it.
        setAllProjects((prev) => [
          ...prev.filter((p) => p.slug !== localProject.slug),
          localProject,
        ]);
        const nextProjects = [
          ...projectsRef.current.filter((p) => p.slug !== localProject.slug),
          localProject,
        ];
        setProjects(nextProjects);
        updateProjectCollection({
          ...projectStateRef.current,
          order: dedupeSlugs([
            ...projectStateRef.current.order,
            localProject.slug,
          ]),
          open: nextProjects.map((p) => p.slug),
          recent: dedupeSlugs([
            localProject.slug,
            ...projectStateRef.current.recent,
          ]),
        });
        setRemotePresetsByProject((prev) => ({
          ...prev,
          [localProject.slug]: result.presets,
        }));
        setActiveProjectId(localProject.slug);
        setNewProjectModal(null);
      } catch (err) {
        console.error(err);
        alert(err instanceof Error ? err.message : String(err));
      }
    },
    [updateProjectCollection],
  );

  const onSavePresets = useCallback(async (next: Preset[]) => {
    await window.aya.savePresets(next);
    setPresets(next);
  }, []);

  const onSaveSnippets = useCallback(async (next: Snippet[]) => {
    await window.aya.saveSnippets(next);
    // Reflect exactly what was persisted (normalized: capped, deduped) rather
    // than the raw draft, so the in-memory list can't drift from disk.
    setSnippets(await window.aya.listSnippets());
  }, []);

  // Most preferences now persist through usePersistentPreference's setter
  // directly; only ones with extra side effects keep a wrapper.
  const updateTerminalFontFamily = useCallback((next: string) => {
    setTerminalFontFamily(next);
    if (next.trim()) {
      localStorage.setItem(TERMINAL_FONT_FAMILY_STORAGE_KEY, next);
    } else {
      localStorage.removeItem(TERMINAL_FONT_FAMILY_STORAGE_KEY);
    }
  }, []);

  const updateShowGitHubLink = useCallback(
    (next: boolean) => {
      setShowGitHubLink(next);
      if (!next) setGithubLinks({}); // drop resolved links once the chip is off
    },
    [setShowGitHubLink],
  );

  const updateAyaIntelligence = useCallback((next: AyaIntelligenceConfig) => {
    setAyaIntelligence(next);
    summaryMetaRef.current = {};
    setSummaryNudge((n) => n + 1);
    try {
      localStorage.setItem(AYA_INTELLIGENCE_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore — localStorage can be unavailable in odd embedded contexts */
    }
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (appThemePreference === "system") {
      root.removeAttribute("data-theme");
    } else {
      root.dataset.theme = appThemePreference;
    }
  }, [appThemePreference]);

  /** Called by TerminalView when the user presses Shift+Enter in a
   *  cleanly-exited terminal. Clears the exit state so the PTY event router
   *  can resume updating status when the new PTY emits data. */
  const restartTerminal = useCallback((id: string) => {
    const terminal = terminalsRef.current[id];
    // Continuity across in-session respawns: if this tab already ran a session
    // (confirmed live output - wasSpawned, #67), the respawn must carry the
    // agent resume arg exactly like a boot-restored tab, or a launcher-opened
    // claude/codex tab comes back as a brand-new EMPTY session and the
    // conversation is lost. Flipping `restored` is the one gate
    // terminalCommand already reads. A deliberately fresh session = close the
    // tab and open a new one from the launcher.
    //
    // spawnFailure veto: the host paints the failure banner as a synthetic
    // `data` event (pty.ts reportSpawnFailure) which can mark wasSpawned
    // before the spawn-failed state lands in the ref the router guards on -
    // and a tab whose spawn FAILED has no session to resume. Without the
    // veto, the banner's Restart would append --continue and resume an
    // unrelated conversation from the same cwd. A tab that had a REAL
    // session before a failed respawn keeps continuity through the sticky
    // `restored` flag flipped by that earlier restart.
    const hadSession = wasSpawned(id) && !terminal?.spawnFailure;
    // Same marker hygiene as forceRestartTerminal (after hadSession is read):
    // an explicit restart means the NEXT mount of this id must plain-spawn.
    // Leaving the no-session marker set would let a remount that races the
    // trigger spawn attach-probe again and re-stick `stopped` onto a live
    // process; the host's in-flight/ptys guards make a double plain spawn
    // safe, so forgetting is the strictly better side of that race. The
    // unconditional forget also subsumes the #87 veto fix: a poisoned
    // wasSpawned marker from a failed spawn's banner is dropped here too,
    // so it can never latch `restored` on a later restart.
    forgetSpawn(id);
    setTerminals((prev) => {
      const t = prev[id];
      if (!t) return prev;
      return {
        ...prev,
        [id]: {
          ...t,
          exitCode: null,
          status: "running",
          bell: false,
          spawnFailure: undefined,
          stopped: undefined,
          restored: t.restored || hadSession,
        },
      };
    });
    // Spawn via the restartTrigger effect in TerminalView - it fires AFTER
    // this state batch re-renders, so the command it reads already carries the
    // resume arg from the restored flip above. Spawning directly in the
    // caller (the old way) raced the re-render and lost the -c.
    setRestartTriggers((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));
    // Also clear the activity timestamp so the dot doesn't claim "recently
    // active" until the new PTY actually writes something.
    delete lastActivityRef.current[id];
    if (terminal) {
      appendProjectEvent({
        projectSlug: terminal.projectSlug,
        terminalId: terminal.id,
        level: "active",
        title: `${terminal.name} restarted`,
      });
    }
  }, [appendProjectEvent]);

  // Per-terminal counter — bumped each time we forcibly restart (right-click
  // → Restart). TerminalView watches the prop and triggers a fresh ptySpawn
  // on change, reusing the existing xterm instance + scrollback.
  const [restartTriggers, setRestartTriggers] = useState<Record<string, number>>(
    {},
  );

  /** Right-click → "Restart" handler. Kills the PTY if it can still be
   *  alive (see the maybeAlive gate) and asks TerminalView to spawn a
   *  fresh one. */
  const forceRestartTerminal = useCallback(async (id: string) => {
    const t = terminalsRef.current[id];
    if (!t) return;
    // Read the had-a-session marker BEFORE the kill and forgetSpawn below wipe
    // it - the respawned agent tab must resume its conversation (see
    // restartTerminal for the rationale, including the spawnFailure veto).
    const hadSession = wasSpawned(id) && !t.spawnFailure;
    // Kill only a possibly-live PTY. For an already-dead tab (exited - which
    // includes spawn failures, they emit a synthetic exit - or stopped by a
    // host restart) the host map has no entry, so killPty would arm its
    // pending-kill marker (the closed-tab race guard) and that marker would
    // swallow the respawn the trigger below requests - a silent "Restart did
    // nothing" for up to the marker's TTL. A death the renderer has not seen
    // yet (exit event still in flight) can still hit that window; the gate
    // covers every state the user can actually observe when clicking.
    const maybeAlive = t.exitCode === null && !t.stopped;
    if (maybeAlive) {
      // Await the kill so the main-side ptys map is empty by the time the
      // new spawn IPC arrives — otherwise spawnPty treats it as a re-mount
      // and replays the old buffer instead of starting fresh.
      try {
        await window.aya.ptyKill(id);
      } catch {
        /* ignore — best effort */
      }
    }
    // Forget the confirmed-session marker AFTER the kill: a still-alive process
    // can emit output between the request and the kill landing, which would
    // re-mark the id; clearing it last (once the PTY is dead, no more output)
    // ensures an UNMOUNTED tab's next mount spawns fresh instead of attaching-
    // only to a killed PTY (which would no-session it and stick it as stopped).
    forgetSpawn(id);
    setTerminals((prev) => {
      const cur = prev[id];
      if (!cur) return prev;
      return {
        ...prev,
        [id]: {
          ...cur,
          exitCode: null,
          status: "running",
          bell: false,
          spawnFailure: undefined,
          stopped: undefined,
          restored: cur.restored || hadSession,
        },
      };
    });
    delete lastActivityRef.current[id];
    appendProjectEvent({
      projectSlug: t.projectSlug,
      terminalId: t.id,
      level: "active",
      title: `${t.name} restarted`,
    });
    setRestartTriggers((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));
  }, [appendProjectEvent]);

  /** Open a shell terminal in the active project. Used by Cmd/Ctrl+T. Falls
   *  back to BUILTIN_SHELL if the user has deleted their shell preset so the
   *  shortcut always works. */
  const openShellTab = useCallback(() => {
    const slug = activeProjectIdRef.current;
    if (!slug) return;
    const project = projectsRef.current.find((p) => p.slug === slug);
    const sourcePresets =
      project?.remote
        ? (remotePresetsByProjectRef.current[slug] ?? presetsRef.current)
        : presetsRef.current;
    const shellPreset =
      sourcePresets.find((p) => p.id === "shell") ?? sourcePresets[0] ?? BUILTIN_SHELL;
    launchTerminal(shellPreset);
  }, [launchTerminal]);

  /** Cycle through the active project's terminal tabs in display order. */
  const cycleActiveProjectTab = useCallback((delta: number) => {
    const slug = activeProjectIdRef.current;
    if (!slug) return;
    const tabs = Object.values(terminalsRef.current).filter(
      (t) => t.projectSlug === slug,
    );
    if (tabs.length < 2) return;
    const currentId = activeTabByProject[slug];
    const idx = tabs.findIndex((t) => t.id === currentId);
    if (idx < 0) return;
    const next = (idx + delta + tabs.length) % tabs.length;
    // Route through selectTerminalFromSidebar (not a bare setActiveTabByProject)
    // so that in a SPLIT the active cell + keyboard focus follow to the next
    // terminal instead of silently changing only the active-tab pointer (the
    // active-tab-vs-active-cell divergence - same class as BUG-1). In single
    // view it collapses to show the cycled-to terminal, as before.
    selectTerminalFromSidebar(tabs[next].id);
  }, [activeTabByProject, selectTerminalFromSidebar]);

  const onSaveThemes = useCallback(
    async (nextThemes: Theme[], nextActiveId: string) => {
      const activeId = nextThemes.some((t) => t.id === nextActiveId)
        ? nextActiveId
        : (nextThemes[0]?.id ?? "");
      await window.aya.saveThemes({ themes: nextThemes, activeId });
      setThemes(nextThemes);
      setActiveThemeId(activeId);

      // Sweep presets for themeId references that point at themes no longer
      // in the list — otherwise presets.json keeps dangling pointers and the
      // Settings UI shows "Default" for them (because resolution falls back)
      // but the data on disk lies.
      const liveIds = new Set(nextThemes.map((t) => t.id));
      const currentPresets = presetsRef.current;
      let dirty = false;
      const swept = currentPresets.map((p) => {
        if (p.themeId && !liveIds.has(p.themeId)) {
          dirty = true;
          const { themeId: _drop, ...rest } = p;
          void _drop;
          return rest;
        }
        return p;
      });
      if (dirty) {
        await window.aya.savePresets(swept);
        setPresets(swept);
      }
    },
    [],
  );

  const onImportTheme = useCallback(async (): Promise<Theme | null> => {
    return window.aya.importTheme();
  }, []);

  // ---------------------------------------------------------------------------
  // Missing-dir modal handlers
  // ---------------------------------------------------------------------------
  const dequeueMissingDir = useCallback(() => {
    setMissingDirQueue((q) => q.slice(1));
  }, []);

  const handleCreateMissingDir = useCallback(async () => {
    const entry = missingDirQueue[0];
    if (!entry) return;
    await window.aya.createDir(entry.directory);
    const project = projectsRef.current.find((p) => p.slug === entry.slug);
    if (project) {
      hydrateProjectTerminals(project, project.directory);
      void window.aya.getGitInfo(project.directory).then((info) => {
        setGit((g) => mergeGitInfo(g, project.directory, info));
      });
    }
    dequeueMissingDir();
  }, [missingDirQueue, hydrateProjectTerminals, dequeueMissingDir]);

  const handleUseHomeForMissingDir = useCallback(() => {
    const entry = missingDirQueue[0];
    if (!entry) return;
    setProjectFallbacks((prev) => ({ ...prev, [entry.slug]: homeDir }));
    const project = projectsRef.current.find((p) => p.slug === entry.slug);
    if (project) {
      hydrateProjectTerminals(project, homeDir);
    }
    dequeueMissingDir();
  }, [missingDirQueue, homeDir, hydrateProjectTerminals, dequeueMissingDir]);

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------
  const activeProject = activeProjectId
    ? findProject(projects, activeProjectId)
    : null;
  const activePresets =
    activeProject?.remote && activeProjectId
      ? (remotePresetsByProject[activeProjectId] ?? presets)
      : presets;
  // The derived collections below are memoized: App re-renders on every poll
  // tick and PTY status flip, and rebuilding these arrays/Sets/records each time
  // both wastes O(terminals) work several times over AND hands children fresh
  // object identities, which would defeat React.memo on them.
  const closedProjects = useMemo(() => {
    const openProjectSlugs = new Set(projects.map((p) => p.slug));
    return allProjects.filter((p) => !openProjectSlugs.has(p.slug));
  }, [projects, allProjects]);
  // useStable on the terminals-derived collections below: the memos recompute
  // whenever the terminals MAP identity changes (any terminal's status/bell
  // flip, in any project), but the derived contents are often the very same
  // object refs — e.g. a background project's flip leaves the active
  // project's list untouched. Reusing the previous identity then keeps
  // Sidebar/TopBar's memo warm instead of re-rendering them for nothing.
  const projectTerminals: TerminalState[] = useStable(
    useMemo(
      () =>
        Object.values(terminals).filter(
          (t) => activeProjectId && t.projectSlug === activeProjectId,
        ),
      [terminals, activeProjectId],
    ),
    sameArrayItems,
  );
  // (activeTabId / activeTerminal are derived up with the git-surface effects.)
  const terminalSoundPrefs = useMemo(
    () => ({
      enabled: terminalSoundsEnabled,
      overrides: terminalSoundOverrides,
      customWaitingPath: customWaitingSound,
      customDonePath: customDoneSound,
    }),
    [
      terminalSoundsEnabled,
      terminalSoundOverrides,
      customWaitingSound,
      customDoneSound,
    ],
  );
  useTerminalSounds({
    terminals,
    activeTerminalId: activeTabId,
    prefs: terminalSoundPrefs,
  });
  const snippetsOpenForActiveTerminal =
    !!activeTerminal && snippetDrawerTerminalId === activeTerminal.id;
  // Git surface (branch, dirty, diff, GitHub link) reads the active terminal's
  // checkout — see activeGitDirectory — so all of it is keyed by directory.
  const activeGit = activeGitDirectory ? (git[activeGitDirectory] ?? null) : null;
  const activeGithubLink = activeGitDirectory
    ? (githubLinks[activeGitDirectory] ?? null)
    : null;
  // Resolve the PR/branch link only when the active checkout or its branch
  // changes — `gh pr view` hits the GitHub API, so we deliberately keep it off
  // the 3s git poll. Local repos only; remote projects have no working tree.
  const activeBranch = activeGit?.branch ?? null;
  useEffect(() => {
    if (!showGitHubLink || !activeGitDirectory) return;
    let cancelled = false;
    void window.aya.getGitHubLink(activeGitDirectory).then((link) => {
      if (cancelled) return;
      setGithubLinks((prev) => ({ ...prev, [activeGitDirectory]: link }));
    });
    return () => {
      cancelled = true;
    };
  }, [showGitHubLink, activeGitDirectory, activeBranch]);
  // Split panes are not supported in the experimental "projects-left" layout
  // (terminals live in a top tab strip there). Ignore any saved split so the
  // body shows a single terminal, and disable the split actions. The project's
  // stored splitLayout is left untouched, so switching back to the classic
  // layout restores it. (splitEnabled is defined up near the refs above.)
  const savedSplitTree = useMemo(
    () =>
      splitEnabled && activeProject && activeProjectId
        ? normalizeTreeForTabs(
            projectSplitTree(activeProject),
            new Set(activeProject.tabs.map((tab) => tab.id)),
            activeTabId,
            uuid(),
          )
        : null,
    [splitEnabled, activeProject, activeProjectId, activeTabId],
  );
  const hasStoredSplit =
    !!activeProject && !!projectSplitTree(activeProject) && splitEnabled;
  const singleViewTerminalId =
    activeProjectId && singleViewByProject[activeProjectId] && terminals[singleViewByProject[activeProjectId]!]
      ? singleViewByProject[activeProjectId]
      : null;
  /** The tree actually rendered: a single-terminal view collapses to one pane,
   *  and a project with no stored split still renders through the same path so
   *  panes and the unsplit view share one code path. */
  const splitTree = useMemo(() => {
    if (savedSplitTree && singleViewTerminalId) {
      return leaf(SINGLE_VIEW_LEAF_ID, singleViewTerminalId);
    }
    if (savedSplitTree) return savedSplitTree;
    return activeTabId ? leaf(SINGLE_VIEW_LEAF_ID, activeTabId) : null;
  }, [savedSplitTree, singleViewTerminalId, activeTabId]);
  const isSplit =
    !!splitTree && !singleViewTerminalId && hasStoredSplit && leafCount(splitTree) > 1;
  const paneRects = useMemo(
    () => (splitTree ? layoutRects(splitTree) : []),
    [splitTree],
  );
  const paneDividers = useMemo(
    () => (isSplit && splitTree ? dividerRects(splitTree) : []),
    [isSplit, splitTree],
  );
  /** Pane number per terminal, for the sidebar chip. Positional, so it tracks
   *  what the user sees rather than tree structure. */
  const splitAssignments: Record<string, number> = useMemo(() => {
    const out: Record<string, number> = {};
    if (!hasStoredSplit) return out;
    paneRects.forEach((pane, index) => {
      if (pane.terminalId) out[pane.terminalId] = index;
    });
    return out;
  }, [paneRects, hasStoredSplit]);
  const activeLeafId = useMemo(
    () =>
      splitTree && activeProjectId
        ? resolveActiveLeafId(
            splitTree,
            activeLeafByProject[activeProjectId],
            activeTabId,
          )
        : null,
    [splitTree, activeProjectId, activeLeafByProject, activeTabId],
  );
  // One cap now, not separate row/column limits: a tree has no tracks.
  const canSplit =
    splitEnabled && !!splitTree && leafCount(splitTree) < MAX_SPLIT_LEAVES;

  useEffect(() => {
    if (!activeProject?.remote || !activeProjectId) return;
    if (remotePresetsByProject[activeProjectId]?.length) return;
    let cancelled = false;
    void window.aya
      .listRemotePresets(activeProject.remote.sshTarget)
      .then((remotePresets) => {
        if (cancelled) return;
        setRemotePresetsByProject((prev) => ({
          ...prev,
          [activeProjectId]: remotePresets,
        }));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeProject, activeProjectId, remotePresetsByProject]);

  const visibleTerminalIds = useStable(
    useMemo(
      () =>
        splitTree
          ? paneRects
              .map((pane) => pane.terminalId)
              .filter((id): id is string => !!id && !!terminals[id])
          : activeTabId
            ? [activeTabId]
            : [],
      [splitTree, paneRects, activeTabId, terminals],
    ),
    sameArrayItems,
  );
  // spawnDeferred tabs (added by an external config edit, #4) stay out of the
  // hidden pool: a hidden TerminalView mounts an xterm and spawns the PTY,
  // and those tabs must not get a process until first activated.
  //
  // Keep all terminals for the active/recent projects warm, plus the active
  // terminal for each other open project. That preserves fast project switches
  // in the common working set without mounting every terminal in every project
  // as hidden xterm DOM/WebGL state.
  const { hiddenTerminals: hiddenTerminalsNext, assignableProjectTerminals: assignableProjectTerminalsNext } =
    useMemo(() => {
      const visibleSet = new Set(visibleTerminalIds);
      const mountedSet = new Set(visibleTerminalIds);
      const warmProjectSlugSet = new Set(warmProjectSlugs);
      for (const terminal of projectTerminals) {
        mountedSet.add(terminal.id);
      }
      for (const terminal of Object.values(terminals)) {
        if (warmProjectSlugSet.has(terminal.projectSlug)) {
          mountedSet.add(terminal.id);
        }
      }
      for (const project of projects) {
        const terminalId =
          activeTabByProject[project.slug] ?? project.tabs[0]?.id;
        if (terminalId) mountedSet.add(terminalId);
      }
      return {
        hiddenTerminals: Object.values(terminals).filter(
          (terminal) =>
            mountedSet.has(terminal.id) &&
            !visibleSet.has(terminal.id) &&
            !terminal.spawnDeferred,
        ),
        assignableProjectTerminals: projectTerminals.filter(
          (terminal) => !visibleSet.has(terminal.id),
        ),
      };
    }, [
      visibleTerminalIds,
      warmProjectSlugs,
      projectTerminals,
      terminals,
      projects,
      activeTabByProject,
    ]);
  const hiddenTerminals = useStable(hiddenTerminalsNext, sameArrayItems);
  const assignableProjectTerminals = useStable(
    assignableProjectTerminalsNext,
    sameArrayItems,
  );

  // The first time a deferred tab becomes visible (sidebar activation or
  // split assignment), drop the flag - from then on it mounts and spawns like
  // any other terminal, including via the hidden pool.
  const visibleTerminalsKey = visibleTerminalIds.join("\n");
  useEffect(() => {
    setTerminals((prev) => {
      let next = prev;
      for (const id of visibleTerminalsKey.split("\n")) {
        const t = next[id];
        if (!t?.spawnDeferred) continue;
        if (next === prev) next = { ...prev };
        next[id] = { ...t, spawnDeferred: undefined };
      }
      return next;
    });
  }, [visibleTerminalsKey]);

  const {
    projectBadges: projectBadgesNext,
    monitoredSessionsByProject: monitoredSessionsByProjectNext,
    attentionCount,
  } = useMemo(() => {
      const badges: Record<string, { count: number; level: ProjectBadgeLevel }> =
        {};
      const severityRank = { active: 0, done: 1, waiting: 2, error: 3 } as const;
      const addProjectBadge = (
        projectSlug: string,
        level: ProjectBadgeLevel,
      ) => {
        const current = badges[projectSlug];
        badges[projectSlug] = {
          count: (current?.count ?? 0) + 1,
          level:
            !current || severityRank[level] > severityRank[current.level]
              ? level
              : current.level,
        };
      };
      for (const t of Object.values(terminals)) {
        let level: ProjectBadgeLevel | null = null;
        if (
          t.status === "error" ||
          t.externalStatus?.level === "error" ||
          t.spawnFailure
        ) {
          level = "error";
        } else if (
          t.bell ||
          t.status === "waiting" ||
          t.externalStatus?.level === "waiting"
        ) {
          level = "waiting";
        } else if (isTerminalDone(t)) {
          level = "done";
        } else if (t.externalStatus?.level === "active") {
          level = "active";
        }
        if (!level) continue;
        addProjectBadge(t.projectSlug, level);
      }
      const byProject: Record<string, MonitoredSession[]> = {};
      for (const session of monitoredSessions) {
        const projectSlug = findProjectSlugForSession(session, projects);
        if (!projectSlug) continue;
        addProjectBadge(projectSlug, session.level);
        byProject[projectSlug] = [...(byProject[projectSlug] ?? []), session];
      }
      return {
        projectBadges: badges,
        monitoredSessionsByProject: byProject,
        attentionCount: Object.values(badges).reduce(
          (sum, badge) => sum + (badge.level === "active" ? 0 : badge.count),
          0,
        ),
      };
    }, [terminals, monitoredSessions, projects]);
  // Badge/session records rebuild with fresh value objects every recompute;
  // compare by content so an output-only flip (same badges) doesn't hand
  // TopBar/Sidebar a new record identity.
  const projectBadges = useStable(projectBadgesNext, sameProjectBadges);
  const monitoredSessionsByProject = useStable(
    monitoredSessionsByProjectNext,
    sameSessionRecords,
  );

  // Stable handlers for the chrome components (TopBar / Sidebar /
  // ProjectsLeftLayout / StatusBar). These were inline arrows at the call
  // sites, which hands the memoized children a fresh prop identity on every
  // App render and defeats their React.memo.
  const openProjectBySlug = useCallback(
    (slug: string) => {
      const project = allProjects.find((p) => p.slug === slug);
      if (project) void openKnownProject(project);
    },
    [allProjects, openKnownProject],
  );
  const openSearch = useCallback(() => setShowSearch(true), []);
  // Status-bar checkout picker: pin a worktree, or go back to following the
  // console. Pinning by path (not index) so a worktree added or removed between
  // renders can't silently repoint the pin at a different checkout.
  const pinCheckout = useCallback(
    (path: string | null) => {
      const slug = activeProjectIdRef.current;
      if (!slug) return;
      setPinnedCheckout((prev) => {
        if (!path) {
          if (!(slug in prev)) return prev;
          const next = { ...prev };
          delete next[slug];
          return next;
        }
        return prev[slug] === path ? prev : { ...prev, [slug]: path };
      });
    },
    [],
  );
  const minimizeWindow = useCallback(
    () => void window.aya.minimizeWindow(),
    [],
  );
  const toggleMaximizeWindow = useCallback(
    () => void window.aya.toggleMaximizeWindow(),
    [],
  );
  const toggleFullScreenWindow = useCallback(
    () => void window.aya.setFullScreen(!isFullScreen),
    [isFullScreen],
  );
  const closeWindow = useCallback(() => void window.aya.closeWindow(), []);
  const reorderActiveProjectTerminals = useCallback(
    (orderedIds: string[]) => {
      const slug = activeProjectIdRef.current;
      if (slug) reorderTerminalsInProject(slug, orderedIds);
    },
    [reorderTerminalsInProject],
  );
  const splitTerminalRight = useCallback(
    (id: string) => addTerminalSplit(id, "right"),
    [addTerminalSplit],
  );
  const splitTerminalBelow = useCallback(
    (id: string) => addTerminalSplit(id, "below"),
    [addTerminalSplit],
  );
  const toggleSnippetsDrawer = useCallback(() => {
    if (!activeTerminal) return;
    setSnippetDrawerTerminalId((current) =>
      current === activeTerminal.id ? null : activeTerminal.id,
    );
  }, [activeTerminal]);
  const openAttentionCenter = useCallback(
    () => setShowAttentionCenter(true),
    [],
  );
  const openProjectDirectory = useCallback((directory: string) => {
    void window.aya.openPath(directory);
  }, []);

  const focusTerminal = useCallback(
    (slug: string, terminalId: string) => {
      setActiveProjectId(slug);
      // Move the active split CELL + keyboard focus to the target (or collapse
      // to single view for a hidden terminal) - not just the active tab. Without
      // this, focusing from the AttentionCenter / timeline in a split left the
      // active pane and keyboard focus on the old terminal.
      selectTerminalFromSidebar(terminalId);
      setTerminals((prev) => {
        const terminal = prev[terminalId];
        if (!terminal || !terminal.bell) return prev;
        return {
          ...prev,
          [terminalId]: {
            ...terminal,
            bell: false,
          },
        };
      });
    },
    [selectTerminalFromSidebar],
  );
  focusTerminalRef.current = focusTerminal;

  const currentMissingDir = missingDirQueue[0] ?? null;
  const chromeBlocked = !!currentMissingDir || !!newProjectModal;
  // Any overlay that should hold focus instead of the terminal. While one is
  // open, no terminal is "active" for focus purposes; closing the last one
  // hands focus back to the active terminal (via TerminalView's isActive effect).
  const anyOverlayOpen =
    chromeBlocked ||
    showSettings ||
    showSearch ||
    showAttentionCenter ||
    !!pendingRepoImport;
  const closeFindPane = useCallback(() => setFindInPaneFor(null), []);
  const ignoreSnippetsOpenChange = useCallback(() => undefined, []);

  const activeTheme = themes.find((t) => t.id === activeThemeId) ?? themes[0];
  const activeThemeColors: ThemeColors =
    activeTheme?.colors ?? FALLBACK_THEME_COLORS;
  const isEmpty =
    didBootstrap && projects.length === 0 && missingDirQueue.length === 0;

  const showNewProjectModal = useCallback(() => {
    setNewProjectModal({
      defaults: { directory: "~/" },
      lockDirectory: false,
      title: "Open project",
      hint: "Type a project directory. Press Tab to complete paths.",
    });
  }, []);

  const submitProjectFromModal = useCallback(
    async (directory: string) => {
      const exists = await window.aya.dirExists(directory);
      if (!exists) {
        throw new Error("Directory does not exist.");
      }
      const absDir = await window.aya.expandPath(directory);
      const existing = allProjectsRef.current.find(
        (p) => p.directory === absDir,
      );
      if (existing) {
        await openKnownProject(existing);
        setNewProjectModal(null);
        return;
      }
      await onCreateProject(
        uniqueProjectName(allProjectsRef.current, absDir),
        absDir,
      );
    },
    [onCreateProject, openKnownProject],
  );

  // Refresh the open-project handler so it sees the latest projects + state.
  openProjectRef.current = async (rawDir: string) => {
    const absDir = await window.aya.expandPath(rawDir);
    // 1. Exact directory match: just switch (no-op if already active).
    const existing = allProjectsRef.current.find((p) => p.directory === absDir);
    if (existing) {
      await openKnownProject(existing);
      return;
    }
    // 2. Auto-create silently from basename. If the slug would collide with
    //    another project, append a numeric suffix. The top tab can be renamed
    //    later, so no modal is needed for the common path.
    const name = uniqueProjectName(allProjectsRef.current, absDir);
    await onCreateProject(name, absDir);
  };

  useAppShortcuts({
    newShell: openShellTab,
    closeCurrentTab: () => {
      // Through the refs, not render state: a burst of closes must each act on
      // the tab that is active by then, not on a snapshot from the last render.
      const slug = activeProjectIdRef.current;
      const id = slug ? activeTabByProjectRef.current[slug] : null;
      if (id) closeTerminal(id);
    },
    search: () => {
      if (!chromeBlocked) setShowSearch(true);
    },
    openSettings: () => openSettings(),
    prevTab: () => cycleActiveProjectTab(-1),
    nextTab: () => cycleActiveProjectTab(1),
    selectProject: (oneBasedIndex) => {
      const target = projects[oneBasedIndex - 1];
      if (target) setActiveProjectId(target.slug);
    },
    findInPane: () => {
      if (activeTabId) setFindInPaneFor(activeTabId);
    },
    focusPane: focusSplitPane,
    splitPaneRight: () => splitActivePane("right"),
    splitPaneBelow: () => splitActivePane("below"),
  });

  useDoubleShiftSearch({
    enabled: !chromeBlocked,
    onToggle: () => setShowSearch((s) => !s),
  });

  return (
    <div
      className={[
        "aya-app",
        window.aya.platform === "darwin" ? "aya-app--macos" : "",
        isFullScreen ? "aya-app--fullscreen" : "",
      ].filter(Boolean).join(" ")}
      data-theme={
        appThemePreference === "system" ? undefined : appThemePreference
      }
      data-accent="green"
    >
      {(() => {
        const loadingNode = (
          <main className="aya-empty aya-empty--loading" aria-busy="true">
            <div className="aya-empty-mark" aria-hidden="true">
              <span />
            </div>
            <h1>Opening Aya...</h1>
          </main>
        );
        const emptyStateNode = (
          <EmptyState
            showNoHarnessHint={
              harnessScanDone && foundHarnessCount === 0 && !hideNoHarnessHint
            }
            onOpenProject={showNewProjectModal}
            onOpenSettings={openSettings}
            onDismissNoHarnessHint={() => {
              localStorage.setItem("aya:no-harness-hint-dismissed", "1");
              setHideNoHarnessHint(true);
            }}
          />
        );
        const panesNode = (
          <div className={`aya-panes ${isSplit ? "aya-panes--split" : ""}`}>
            {paneRects.map(({ leafId, terminalId, rect }) => {
              const terminal = terminalId ? terminals[terminalId] : null;
              // Panes are positioned from the tree's rectangles rather than
              // nested to match it: nesting would move each TerminalView in
              // the React tree on every reshape and remount the terminal.
              const paneStyle = isSplit
                ? {
                    left: `${rect.left}%`,
                    top: `${rect.top}%`,
                    width: `${rect.width}%`,
                    height: `${rect.height}%`,
                  }
                : undefined;
              if (!terminal) {
                return (
                  <div
                    key={`empty-${leafId}`}
                    style={paneStyle}
                    className={`aya-pane aya-pane-empty ${
                      activeLeafId === leafId ? "aya-pane-empty--active" : ""
                    }`}
                    onClick={() => {
                      if (!activeProjectId) return;
                      setActiveSplitCell(activeProjectId, leafId);
                    }}
                  >
                    <div className="aya-pane-header">
                      <span className="aya-pane-header-title">Empty pane</span>
                    </div>
                    <div className="aya-pane-empty-body">
                      {assignableProjectTerminals.length === 0 ? (
                        <div className="aya-pane-empty-hint">No hidden terminals</div>
                      ) : (
                        <div className="aya-pane-empty-list">
                          {assignableProjectTerminals.map((candidate) => {
                            const preset = getPreset(activePresets, candidate.presetId);
                            return (
                              <button
                                key={candidate.id}
                                className="aya-pane-empty-terminal"
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  assignTerminalToSplitCell(candidate.id, leafId);
                                }}
                              >
                                <span
                                  className="aya-sidebar-icon"
                                  style={preset.color ? { color: preset.color } : undefined}
                                >
                                  {preset.icon}
                                </span>
                                <span>{candidate.name}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                );
              }
              const preset = getPreset(activePresets, terminal.presetId);
              // Per-preset theme override (set in Settings) wins over the
              // global active theme. Missing override → fall back to the
              // default the user picked. Missing theme entirely → fallback.
              const overrideTheme = preset.themeId
                ? themes.find((th) => th.id === preset.themeId)
                : null;
              const colorsForTerminal: ThemeColors =
                overrideTheme?.colors ?? activeThemeColors;
              return (
                <TerminalView
                  key={terminal.id}
                  paneStyle={paneStyle}
                  terminal={terminal}
                  preset={preset}
                  command={terminalCommand(activeProject, preset, terminal)}
                  snippets={snippets}
                  snippetsOpen={snippetDrawerTerminalId === terminal.id}
                  onSnippetsOpenChange={(open) =>
                    setSnippetDrawerTerminalId(open ? terminal.id : null)
                  }
                  isVisible
                  cwd={activeProject?.remote ? homeDir : terminal.cwd}
                  lastActivity={lastActivityRef.current[terminal.id]}
                  fontFamily={effectiveTerminalFontFamily}
                  fontSize={fontSize}
                  themeColors={colorsForTerminal}
                  findOpen={findInPaneFor === terminal.id}
                  onCloseFind={closeFindPane}
                  historySearchEnabled={
                    harnessSearchEnabled && !activeProject?.remote
                  }
                  onOpenSettings={openSettings}
                  onCloseProject={closeProject}
                  onRequestRestart={() => restartTerminal(terminal.id)}
                  restartTrigger={restartTriggers[terminal.id] ?? 0}
                  macOptionKeyMode={macOptionKeyMode}
                  isActivePane={isSplit && activeLeafId === leafId}
                  isActive={(isSplit ? activeLeafId === leafId : true) && !anyOverlayOpen}
                  onActivatePane={() =>
                    activeProjectId && setActiveSplitCell(activeProjectId, leafId)
                  }
                  enableWebgl={!isSplit}
                />
              );
            })}
            {hiddenTerminals.map((t) => {
              const project = findProject(projects, t.projectSlug);
              const projectPresets =
                project?.remote && remotePresetsByProject[t.projectSlug]
                  ? remotePresetsByProject[t.projectSlug]
                  : presets;
              const preset = getPreset(projectPresets, t.presetId);
              const overrideTheme = preset.themeId
                ? themes.find((th) => th.id === preset.themeId)
                : null;
              const colorsForTerminal: ThemeColors =
                overrideTheme?.colors ?? activeThemeColors;
              return (
                <TerminalView
                  key={t.id}
                  terminal={t}
                  preset={preset}
                  command={terminalCommand(project, preset, t)}
                  snippets={snippets}
                  snippetsOpen={false}
                  onSnippetsOpenChange={ignoreSnippetsOpenChange}
                  isVisible={false}
                  cwd={project?.remote ? homeDir : t.cwd}
                  lastActivity={lastActivityRef.current[t.id]}
                  fontFamily={effectiveTerminalFontFamily}
                  fontSize={fontSize}
                  themeColors={colorsForTerminal}
                  findOpen={false}
                  onCloseFind={closeFindPane}
                  onOpenSettings={openSettings}
                  onCloseProject={closeProject}
                  onRequestRestart={() => restartTerminal(t.id)}
                  restartTrigger={restartTriggers[t.id] ?? 0}
                  macOptionKeyMode={macOptionKeyMode}
                  enableWebgl={false}
                />
              );
            })}
            {activeProjectId &&
              paneDividers.map((divider) => (
                <SplitResizeHandle
                  key={divider.splitId}
                  divider={divider}
                  onResize={(ratio) => resizeSplit(activeProjectId, divider.splitId, ratio)}
                />
              ))}
            {projectTerminals.length === 0 && activeProject && (
              <div className="aya-pane">
                <div className="aya-pane-header">
                  <span className="aya-pane-header-title">
                    {activeProject.remote
                      ? `Remote project on ${activeProject.remote.label}`
                      : "No terminals yet — launch one to get started."}
                  </span>
                </div>
              </div>
            )}
          </div>
        );
        const body =
          !didBootstrap ? loadingNode : isEmpty ? emptyStateNode : null;
        if (layoutMode === "projects-left") {
          return (
            <ProjectsLeftLayout
              projects={projects}
              closedProjects={closedProjects}
              activeProjectId={activeProjectId}
              homeDir={homeDir}
              isDev={window.aya.isDev}
              platform={window.aya.platform}
              isFullScreen={isFullScreen}
              isMaximized={isMaximized}
              blockChrome={chromeBlocked}
              railWidth={railWidth}
              onRailResize={setRailWidth}
              onSelectProject={setActiveProjectId}
              onOpenProject={openProjectBySlug}
              onNewProject={showNewProjectModal}
              onCloseProject={closeProject}
              onMoveProjectToWindow={moveProjectToWindow}
              onRenameProject={renameProject}
              onReorderProjects={reorderProjects}
              onOpenSearch={openSearch}
              onOpenSettings={openSettings}
              onMinimizeWindow={minimizeWindow}
              onToggleMaximizeWindow={toggleMaximizeWindow}
              onToggleFullScreenWindow={toggleFullScreenWindow}
              onCloseWindow={closeWindow}
              projectBadges={projectBadges}
              projectSummaries={localSummariesEnabled ? projectSummaries : EMPTY_SUMMARIES}
              usageAccounts={usageAccounts}
              codexUsageAccounts={codexUsageAccounts}
              showUsageHarnessName={showUsageHarnessName}
              terminals={projectTerminals}
              activeTerminalId={activeTabId}
              presets={activePresets}
              recentlyActiveIds={recentlyActiveIds}
              terminalSummaries={localSummariesEnabled ? terminalSummaries : EMPTY_SUMMARIES}
              onSelectTerminal={selectTerminalFromSidebar}
              onCloseTerminal={closeTerminal}
              onRenameTerminal={renameTerminal}
              onLaunchTerminal={launchTerminal}
              onReorderTerminals={reorderActiveProjectTerminals}
              onRestartTerminal={forceRestartTerminal}
              body={body ?? panesNode}
            />
          );
        }
        return (
          <>
            <TopBar
              projects={projects}
              activeProjectId={activeProjectId}
              homeDir={homeDir}
              isDev={window.aya.isDev}
              platform={window.aya.platform}
              isFullScreen={isFullScreen}
              isMaximized={isMaximized}
              blockChrome={chromeBlocked}
              closedProjects={closedProjects}
              onSelectProject={setActiveProjectId}
              onOpenProject={openProjectBySlug}
              onNewProject={showNewProjectModal}
              onCloseProject={closeProject}
              onMoveProjectToWindow={moveProjectToWindow}
              onRenameProject={renameProject}
              onReorderProjects={reorderProjects}
              onOpenSearch={openSearch}
              onOpenSettings={openSettings}
              onMinimizeWindow={minimizeWindow}
              onToggleMaximizeWindow={toggleMaximizeWindow}
              onToggleFullScreenWindow={toggleFullScreenWindow}
              onCloseWindow={closeWindow}
              projectBadges={projectBadges}
              monitoredSessionsByProject={monitoredSessionsByProject}
              projectSummaries={localSummariesEnabled ? projectSummaries : EMPTY_SUMMARIES}
              usageAccounts={usageAccounts}
              codexUsageAccounts={codexUsageAccounts}
              showUsageHarnessName={showUsageHarnessName}
            />
            {body ?? (
              <div
                className="aya-main"
                style={{ gridTemplateColumns: `${sidebarWidth}px 1fr` }}
              >
                <Sidebar
                  terminals={projectTerminals}
                  activeId={activeTabId}
                  sidebarWidth={sidebarWidth}
                  presets={activePresets}
                  recentlyActiveIds={recentlyActiveIds}
                  summaries={localSummariesEnabled ? terminalSummaries : EMPTY_SUMMARIES}
                  splitAssignments={splitAssignments}
                  onSelect={selectTerminalFromSidebar}
                  onClose={closeTerminal}
                  onRename={renameTerminal}
                  onLaunch={launchTerminal}
                  worktreesEnabled={worktreesEnabled}
                  worktrees={worktrees}
                  projectDir={
                    activeProject ? projectBaseCwd(activeProject) : undefined
                  }
                  onCreateWorktree={createWorktreeForProject}
                  onRemoveWorktree={removeWorktreeForProject}
                  onResize={setSidebarWidth}
                  onReorder={reorderActiveProjectTerminals}
                  onRestart={forceRestartTerminal}
                  canSplitRight={canSplit}
                  canSplitBelow={canSplit}
                  onAssignToSplit={assignTerminalToActiveSplitCell}
                  onSplitRight={splitTerminalRight}
                  onSplitBelow={splitTerminalBelow}
                  onRemoveFromSplit={removeTerminalFromSplit}
                  statusRail={
                    <StatusRail
                      projects={projects}
                      terminals={terminals}
                      collapsed={statusRailCollapsed}
                      onCollapsedChange={setStatusRailCollapsed}
                      onSelectTerminal={focusTerminalFromNotification}
                    />
                  }
                />
                {panesNode}
              </div>
            )}
          </>
        );
      })()}
      <StatusBar
        project={activeProject}
        git={activeGit}
        gitDirectory={activeGitDirectory}
        worktrees={worktrees}
        checkoutPinned={
          !!activeProjectId && !!pinnedCheckout[activeProjectId]
        }
        onPickCheckout={pinCheckout}
        githubLink={activeGithubLink}
        showGitHubLink={showGitHubLink}
        terminal={activeTerminal}
        attentionCount={attentionCount}
        snippetsOpen={snippetsOpenForActiveTerminal}
        snippetsDisabled={!activeTerminal}
        onToggleSnippets={toggleSnippetsDrawer}
        onOpenAttentionCenter={openAttentionCenter}
        onOpenProjectDirectory={openProjectDirectory}
      />
      {currentMissingDir && (
        <MissingDirModal
          key={currentMissingDir.slug}
          projectName={currentMissingDir.name}
          directory={currentMissingDir.directory}
          homeDir={homeDir}
          onCreate={handleCreateMissingDir}
          onUseHome={handleUseHomeForMissingDir}
          onClose={handleUseHomeForMissingDir}
        />
      )}
      {newProjectModal && !currentMissingDir && (
        <NewProjectModal
          defaultDirectory={newProjectModal.defaults?.directory}
          lockDirectory={newProjectModal.lockDirectory}
          title={newProjectModal.title}
          hint={newProjectModal.hint}
          pathHint={newProjectModal.pathHint}
          onPickDirectory={window.aya.pickDirectory}
          onCompletePath={window.aya.completePath}
          onDirectoryExists={window.aya.dirExists}
          onCreateDirectory={window.aya.createDir}
          onListRemoteDirectory={window.aya.listRemoteDirectory}
          onCreateRemoteProject={window.aya.createRemoteProjectOnHost}
          onCreateRemoteDirectory={window.aya.createRemoteDirectory}
          onCheckRemoteHealth={window.aya.checkRemoteHealth}
          onSubmitRemote={onCreateRemoteProject}
          onSubmit={submitProjectFromModal}
          onCancel={() => {
            setNewProjectModal(null);
          }}
        />
      )}
      {showSearch && (
        <SearchModal
          projects={projects}
          allProjects={allProjects}
          activeProject={activeProject}
          terminals={terminals}
          events={projectEvents}
          presets={presets}
          lastActivity={lastActivityRef.current}
          onSelectProject={(slug) => {
            const project = allProjects.find((p) => p.slug === slug);
            if (project) void openKnownProject(project);
          }}
          onSelectTerminal={(slug, terminalId) => {
            // Activate the project, then reuse the sidebar selection logic so a
            // jump into a split also moves the active CELL (and keyboard focus)
            // to the target pane - not just the active tab.
            setActiveProjectId(slug);
            selectTerminalFromSidebar(terminalId);
          }}
          onRunPreset={(presetId) => {
            const preset = presets.find((p) => p.id === presetId);
            if (preset) launchTerminal(preset);
          }}
          onClose={() => setShowSearch(false)}
        />
      )}
      {showAttentionCenter && (
        <AttentionCenter
          projects={projects}
          terminals={terminals}
          events={projectEvents}
          onSelectTerminal={focusTerminal}
          onRestartTerminal={(terminalId) => void forceRestartTerminal(terminalId)}
          onCloseTerminal={closeTerminal}
          onClose={() => setShowAttentionCenter(false)}
        />
      )}
      {pendingRepoImport && !chromeBlocked && (
        <ProjectPresetImportModal
          project={pendingRepoImport.project}
          presets={pendingRepoImport.presets}
          onIgnore={() => {
            localStorage.setItem(
              `aya:repo-config-ignored:${pendingRepoImport.project.directory}`,
              "1",
            );
            setPendingRepoImport(null);
          }}
          onImport={() => {
            const project = pendingRepoImport.project;
            const base = [...presetsRef.current];
            const imported = pendingRepoImport.presets.map((preset) => {
              const nextPreset = {
                ...preset,
                id: uniquePresetId(base, project, preset),
              };
              base.push(nextPreset);
              return nextPreset;
            });
            const next = base;
            void window.aya.savePresets(next).then(() => {
              setPresets(next);
              localStorage.setItem(
                `aya:repo-config-ignored:${project.directory}`,
                "1",
              );
              appendProjectEvent({
                projectSlug: project.slug,
                level: "info",
                title: "Project launchers imported",
                detail: `${imported.length} launcher${imported.length === 1 ? "" : "s"}`,
              });
              setPendingRepoImport(null);
            });
          }}
        />
      )}
      {showSettings && (
        <SettingsModal
          presets={presets}
          defaults={defaultPresets}
          snippets={snippets}
          themes={themes}
          activeThemeId={activeThemeId}
          appThemePreference={appThemePreference}
          onAppThemePreferenceChange={setAppThemePreference}
          terminalFontFamily={terminalFontFamily}
          onTerminalFontFamilyChange={updateTerminalFontFamily}
          showUsageHarnessName={showUsageHarnessName}
          onShowUsageHarnessNameChange={setShowUsageHarnessName}
          showGitHubLink={showGitHubLink}
          onShowGitHubLinkChange={updateShowGitHubLink}
          layoutMode={layoutMode}
          onLayoutModeChange={setLayoutMode}
          worktreesEnabled={worktreesEnabled}
          onWorktreesEnabledChange={setWorktreesEnabled}
          harnessSearchEnabled={harnessSearchEnabled}
          onHarnessSearchEnabledChange={setHarnessSearchEnabled}
          terminalSoundsEnabled={terminalSoundsEnabled}
          onTerminalSoundsEnabledChange={setTerminalSoundsEnabled}
          terminalSoundOverrides={terminalSoundOverrides}
          onTerminalSoundOverridesChange={(next) =>
            setTerminalSoundOverrides(normalizeSoundOverrides(next))
          }
          customWaitingSound={customWaitingSound}
          customDoneSound={customDoneSound}
          onCustomSoundChange={(cue, path) =>
            cue === "waiting"
              ? setCustomWaitingSound(path)
              : setCustomDoneSound(path)
          }
          localSummariesEnabled={localSummariesEnabled}
          onLocalSummariesEnabledChange={setLocalSummariesEnabled}
          ayaIntelligence={ayaIntelligence}
          onAyaIntelligenceChange={updateAyaIntelligence}
          autoSummaryStatus={autoSummaryStatus}
          onRefreshSummaries={() => setSummaryNudge((n) => n + 1)}
          macOptionKeyMode={macOptionKeyMode}
          onMacOptionKeyModeChange={setMacOptionKeyMode}
          initialTab={settingsInitialTab}
          onRestartPtyHost={restartPtyHost}
          onClose={() => setShowSettings(false)}
          onSave={onSavePresets}
          onSaveSnippets={onSaveSnippets}
          onSaveThemes={onSaveThemes}
          onImportTheme={onImportTheme}
        />
      )}
    </div>
  );
}
