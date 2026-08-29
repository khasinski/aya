// Aya Emulator — window.aya implemented entirely from a static scenario.
//
// Mirrors the AyaApi surface of electron/preload.ts and src/web/bridge.ts, but
// instead of forwarding to a host it serves emulated in-memory state. The
// renderer (../App and every component) is unchanged, so a screenshot of the
// emulator is pixel-identical to the desktop app in the scripted state.
//
// Render-path methods (listProjects/State/Presets/Themes, git, usage, and the
// pty/control event streams) return real scenario-derived data. Everything else
// (native dialogs, window chrome, updater, Settings-only queries) is a typed
// no-op, exactly as Aya Web stubs the calls a browser session can't make.

import type {
  AyaApi,
  ControlStatusUpdate,
  ProjectCollectionState,
  ProjectConfig,
  ProjectGitInfo,
  PtyEvent,
} from "../types";
import type { SplitNode } from "../split-tree";
import { EMULATOR_PRESETS } from "./presets";
import { EMULATOR_THEMES } from "./theme";
import { balancedSplitTree, type EmScenario, type EmTab } from "./scenario";

/** Derived, ready-to-serve state for one scenario. */
interface Derived {
  projects: ProjectConfig[];
  state: ProjectCollectionState;
  gitBySlug: Map<string, ProjectGitInfo>;
  tabsById: Map<string, { tab: EmTab; projectSlug: string; cwd: string }>;
  /** First rendered line of a tab's content -> its Apple-Intelligence summary.
   *  Used by summarizeLocal to re-apply a terminal summary after App's prune
   *  effect (which wipes summaries for terminals absent at first render, before
   *  hydration) has run. */
  termSummaryByFirstLine: Map<string, string>;
}

const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;
function firstRenderedLine(text: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(ANSI_SGR_RE, "").trim();
    if (line) return line;
  }
  return "";
}

function deriveSplit(project: EmScenario["projects"][number]): SplitNode | undefined {
  if (project.split) return project.split;
  const ids = project.tabs.map((t) => t.id);
  // A lone tab renders as a single pane with no stored split.
  if (ids.length <= 1) return undefined;
  return balancedSplitTree(ids);
}

function derive(scenario: EmScenario): Derived {
  const homeDir = scenario.homeDir ?? "/Users/you";
  const gitBySlug = new Map<string, ProjectGitInfo>();
  const tabsById = new Map<
    string,
    { tab: EmTab; projectSlug: string; cwd: string }
  >();
  const termSummaryByFirstLine = new Map<string, string>();

  const projects: ProjectConfig[] = scenario.projects.map((p) => {
    if (p.git) gitBySlug.set(p.slug, p.git);
    for (const tab of p.tabs) {
      tabsById.set(tab.id, {
        tab,
        projectSlug: p.slug,
        cwd: tab.cwd ?? p.directory,
      });
      if (tab.summary && tab.content) {
        const key = firstRenderedLine(tab.content);
        if (key) termSummaryByFirstLine.set(key, tab.summary);
      }
    }
    return {
      slug: p.slug,
      name: p.name,
      directory: p.directory,
      tabs: p.tabs.map((t) => ({
        id: t.id,
        presetId: t.presetId,
        name: t.name,
        ...(t.cwd ? { cwd: t.cwd } : {}),
      })),
      ...(deriveSplit(p) ? { splitTree: deriveSplit(p) } : {}),
    };
  });

  const slugs = scenario.projects.map((p) => p.slug);
  const activeProject =
    scenario.activeProjectSlug ?? slugs[0] ?? null;
  const activeTab: Record<string, string> = {};
  const singleView: Record<string, string> = {};
  for (const p of scenario.projects) {
    activeTab[p.slug] = p.activeTabId ?? p.tabs[0]?.id ?? "";
    if (p.singleViewTabId) singleView[p.slug] = p.singleViewTabId;
  }

  const state: ProjectCollectionState = {
    version: 1,
    order: slugs,
    open: slugs,
    recent: slugs,
    activeProject,
    activeTab,
    singleView,
  };

  void homeDir;
  return { projects, state, gitBySlug, tabsById, termSummaryByFirstLine };
}

export function createEmulatorAya(scenario: EmScenario): AyaApi {
  const d = derive(scenario);
  const homeDir = scenario.homeDir ?? "/Users/you";
  const platform = (scenario.platform ?? "darwin") as NodeJS.Platform;

  // --- pty event stream -----------------------------------------------------
  // The bus subscribes exactly once via onPtyEvent; we hold that handler and
  // push scenario content when a TerminalView spawns its (mock) PTY. Spawning
  // happens in the mount effect right after the pane subscribes, so a deferred
  // emit is guaranteed to be seen.
  let ptyHandler: ((e: PtyEvent) => void) | null = null;
  const emit = (event: PtyEvent) => ptyHandler?.(event);

  const emitTabContent = (ptyId: string) => {
    const entry = d.tabsById.get(ptyId);
    if (!entry) return;
    const { tab } = entry;
    if (tab.content) {
      emit({ type: "data", ptyId, chunk: tab.content });
    }
    if (tab.exitCode !== undefined && tab.exitCode !== null) {
      emit({ type: "exit", ptyId, exitCode: tab.exitCode });
    } else if (tab.stopped) {
      emit({ type: "no-session", ptyId });
    }
  };

  // --- control status stream ------------------------------------------------
  // App subscribes once (onControlStatus); we flush the scenario's waiting/
  // error/etc. statuses as soon as it does, so the pane pills, the status rail,
  // and the project-tab badges light up.
  let controlHandler: ((u: ControlStatusUpdate) => void) | null = null;
  const flushStatuses = () => {
    if (!controlHandler) return;
    for (const { tab, projectSlug, cwd } of d.tabsById.values()) {
      if (!tab.status) continue;
      controlHandler({
        terminalId: tab.id,
        projectSlug,
        cwd,
        level: tab.status,
        text: tab.statusText ?? "",
        updatedAt: EMULATOR_NOW,
      });
    }
  };

  const noopAsync = async () => undefined as never;
  const noopSubscription = () => () => {};

  const api: AyaApi = {
    isDev: false,
    platform,

    // pty
    ptySpawn: async (req: { ptyId: string }) => {
      // Defer so the pane's xterm has finished opening before we write.
      setTimeout(() => emitTabContent(req.ptyId), 0);
      return undefined as never;
    },
    ptyWrite: noopAsync,
    ptyResize: noopAsync,
    ptyKill: noopAsync,
    ptyBuffer: noopAsync,
    // No live process to read a cwd from; the status bar falls back to the
    // scenario's spawn cwd (its worktree binding or the project dir).
    ptyCwd: async () => null as never,
    ptySearch: async () => [] as never,
    harnessSearch: async () => [] as never,
    restartPtyHost: noopAsync,
    onPtyEvent: (handler) => {
      ptyHandler = handler as (e: PtyEvent) => void;
      return () => {
        if (ptyHandler === handler) ptyHandler = null;
      };
    },

    // projects
    listProjects: async () => d.projects as never,
    listProjectState: async () => d.state as never,
    saveProjectState: noopAsync,
    listOtherWindows: async () => [] as never,
    adoptProjectInWindow: async () => {
      throw new Error("Multi-window is not available in the emulator");
    },
    resolveProjectDrop: async () => ({ kind: "self" }) as never,
    createProject: noopAsync,
    createRemoteProject: noopAsync,
    listRemoteDirectory: noopAsync,
    createRemoteDirectory: noopAsync,
    listRemotePresets: async () => [] as never,
    checkRemoteHealth: noopAsync,
    createRemoteProjectOnHost: noopAsync,
    updateProject: noopAsync,
    deleteProject: noopAsync,
    readRepoProjectConfig: async () => null as never,

    // presets
    listPresets: async () => EMULATOR_PRESETS as never,
    savePresets: noopAsync,
    scanHarnesses: async () => [] as never,

    // snippets
    listSnippets: async () => (scenario.projects.length ? [] : []) as never,
    saveSnippets: noopAsync,

    // usage + intelligence
    getUsage: async () => (scenario.usage ?? []) as never,
    getCodexUsage: async () => (scenario.codexUsage ?? []) as never,
    usageHookStatus: noopAsync,
    installUsageHook: noopAsync,
    uninstallUsageHook: noopAsync,
    statusHookStatus: noopAsync,
    installStatusHook: noopAsync,
    uninstallStatusHook: noopAsync,
    // Apple Intelligence: App re-summarizes each terminal from its output after
    // hydration (its prune effect wiped the seeded terminal summaries). Match
    // the passed output lines back to the scenario tab and return its label, so
    // the sidebar summary re-appears. Projects keep their seeded cache (they're
    // never pruned), so a "not useful" result there is a harmless no-op.
    summarizeLocal: async (req: { kind: "terminal" | "project"; lines: string[] }) => {
      if (req.kind === "terminal") {
        const first = req.lines.map((l) => l.replace(ANSI_SGR_RE, "").trim()).find(Boolean);
        const summary = first ? d.termSummaryByFirstLine.get(first) : undefined;
        if (summary) {
          return { available: true, useful: true, summary } as never;
        }
      }
      return { available: true, useful: false, summary: "" } as never;
    },
    ollamaStatus: noopAsync,
    pullOllamaModel: noopAsync,
    listMonitoredSessions: async () => [] as never,

    // themes
    listThemes: async () => EMULATOR_THEMES as never,
    saveThemes: noopAsync,
    importTheme: async () => null as never,

    // env / git / fs
    getCwd: async () => (scenario.cwd ?? "") as never,
    getHomeDir: async () => homeDir as never,
    expandPath: async (p: string) => p as never,
    completePath: async () => [] as never,
    getGitInfo: async (directory: string) => {
      const slug = d.projects.find((p) => p.directory === directory)?.slug;
      const info = slug ? d.gitBySlug.get(slug) : undefined;
      return (info ?? { branch: null, dirty: 0 }) as never;
    },
    getGitChangedFiles: async () => [] as never,
    getGitDiff: async () => null as never,
    getGitWorktrees: async () => [] as never,
    // A scenario's directory is already its own checkout root, and it has no
    // extra worktrees to pick between, so the picker never appears.
    getGitRoot: async (directory: string) => directory as never,
    getGitWorktreeStatus: async () => [] as never,
    getGitHubLink: async () => null as never,
    githubCliAvailable: async () => false as never,
    createWorktree: async () => ({ ok: false, error: "Not available in the emulator" }),
    removeWorktree: async () => ({ ok: false, error: "Not available in the emulator" }),
    pickDirectory: async () => null,
    pickSoundFile: async () => null,
    dirExists: async () => true as never,
    createDir: noopAsync,
    openPath: noopAsync,
    openUrl: async (url: string) => {
      window.open(url, "_blank", "noopener");
    },
    readClipboard: async () => "" as never,
    writeClipboard: noopAsync,

    // window chrome + app
    isFullScreen: async () => false as never,
    isMaximized: async () => false as never,
    setDockBadge: noopAsync,
    focusWindow: noopAsync,
    minimizeWindow: noopAsync,
    toggleMaximizeWindow: noopAsync,
    closeWindow: noopAsync,
    setFullScreen: noopAsync,
    showWaitingNotification: noopAsync,
    cliStatus: noopAsync,
    installCli: noopAsync,
    getDiagnostics: noopAsync,
    getUpdateStatus: noopAsync,
    checkForUpdates: noopAsync,
    installUpdate: noopAsync,
    openNotificationSettings: noopAsync,
    micStatus: noopAsync,
    requestMicAccess: noopAsync,
    openMicrophoneSettings: noopAsync,
    onTerminalNotificationSelect: noopSubscription,
    onControlStatus: (handler) => {
      controlHandler = handler as (u: ControlStatusUpdate) => void;
      // Flush after App's terminal map exists (post first render).
      setTimeout(flushStatuses, 0);
      return () => {
        if (controlHandler === handler) controlHandler = null;
      };
    },
    onUpdateStatus: noopSubscription,
    onFullScreenChange: noopSubscription,
    onMaximizedChange: noopSubscription,
    onConfigChange: noopSubscription,
    onShortcut: noopSubscription,
    onOpenProject: noopSubscription,

    // web sharing (Settings-only)
    webStatus: noopAsync,
    configureWeb: noopAsync,
    regenerateWebPassword: noopAsync,
  };

  return api;
}

// A single "now" for the whole scenario so usage chips read fresh and statuses
// share a timestamp. Captured at module load (Date.now via a function so the
// value is stable per bridge instance).
const EMULATOR_NOW = Date.now();
