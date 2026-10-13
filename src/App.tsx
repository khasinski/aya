import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sharingPaneIds } from "./agentPreset";
import { projectBaseCwd, tabFromTerminal } from "./worktree";
import { findStatusTarget } from "./control-status-target";
import {
  applyReportedStatus,
  clearedTerminalStatus,
  controlLevelToTerminalStatus,
  controlStatusEventTitle,
} from "./pty-event-reducer";
import { forgetSpawn, wasSpawned } from "./spawnSession";
import {
  applyExternalProjectEdits,
  mergeProjectsFromDisk,
} from "./project-reload";
import {
  dedupeSlugs,
  defaultTabName,
  findProject,
  findProjectSlugForSession,
  mergeGitInfo,
  remoteTerminalCommand,
  samePollPayload,
  sameProjectBadges,
  sameSessionRecords,
  sessionDir,
  terminalSpawn,
  uniquePresetId,
  uniqueProjectName,
  type MissingDirEntry,
  type NewProjectModalState,
  type PendingRepoImport,
} from "./project-helpers";
import { SplitResizeHandle } from "./components/SplitResizeHandle";
import { AttentionCenter } from "./components/AttentionCenter";
import { TeamsModal } from "./components/TeamsModal";
import { TeamAssignPrompt } from "./components/TeamRole";
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
import { useAppShortcuts } from "./hooks/useAppShortcuts";
import { useDoubleShiftSearch } from "./hooks/useDoubleShiftSearch";
import { usePtyEventRouter } from "./hooks/usePtyEventRouter";
import { useStable } from "./hooks/useStableIdentity";
import { sameArrayItems } from "./stable-identity";
import { useAppTheme } from "./hooks/useAppTheme";
import { useConfigReload } from "./hooks/useConfigReload";
import { EMPTY_SUMMARIES } from "./local-summaries";
import { useLocalSummaries, useLocalSummaryEffects } from "./hooks/useLocalSummaries";
import { PROJECT_STATE_VERSION } from "./main-mirrors";
import type { SettingsTab } from "./settings-tabs";
import {
  useDockBadge,
  useRecentTerminalActivity,
  useTerminalNotifications,
} from "./hooks/useTerminalSignals";
import { useTerminalSounds } from "./hooks/useTerminalSounds";
import { useTeams } from "./hooks/useTeams";
import { useProjectPersistence, useProjectSessionPersistence } from "./hooks/useProjectPersistence";
import { useHarnessScan, useUsagePolling } from "./hooks/useUsagePolling";
import { useWindowChrome } from "./hooks/useWindowChrome";
import { pollVisible } from "./poll-visible";
import { useGitHubLinkEffect, useGitStatus } from "./hooks/useGitStatus";
import { PRESET_ID_SHELL } from "./preset-ids";
import {
  NO_HARNESS_HINT_DISMISSED_STORAGE_KEY,
  repoConfigIgnoredKey,
} from "./storage-keys";
import { GPU_RELAUNCHED_EVENT } from "./window-events";
import { uuid } from "./uuid";
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
  projectSplitTree,
  resolveActiveLeafId,
  type SplitNode,
} from "./split-tree";
import { useAppPreferences, useAppPreferenceActions } from "./hooks/useAppPreferences";
import { useProjectTimeline, usePtyTimelineEvents } from "./hooks/useProjectTimeline";
import { waitingPanesOf } from "./team-view";
import { calculateProjectBadges } from "./project-badges";
import {
  calculateTerminalLists,
  calculateVisibleTerminalIds,
} from "./terminal-visibility";
import {
  BUILTIN_SHELL,
  WAITING_ON,
  type Snippet,
  getPreset,
  type Preset,
  type ProjectCollectionState,
  type ProjectConfig,
  type RemoteProjectCreateResult,
  type TerminalState,
  type WaitingPanes,
  type Theme,
  type ThemeColors,
  type WorkingTab,
} from "./types";

// Cap on preset suggestions offered during repo preset import.
const MAX_SUGGESTED_PRESETS = 8;
const DEFAULT_SIDEBAR_WIDTH_PX = 240;
const DEFAULT_RAIL_WIDTH_PX = 220;

const TERMINAL_FONT_SIZE_PX = 13;
/** Leaf id for the synthetic one-pane tree used when a project has no stored
 *  split (or is showing a single terminal). Constant so React keys and focus
 *  stay stable across renders. */
const SINGLE_VIEW_LEAF_ID = "single";
const WARM_PROJECT_TERMINAL_CACHE_SIZE = 4;



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
  const { projectEvents, appendProjectEvent } = useProjectTimeline();
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
  // The terminal that inherited the active slot from a closed one. It is shown
  // but gets no keyboard focus until the user picks it: keys typed across the
  // close were meant for the closed pane and must not answer a prompt here.
  const [closeFocusHold, setCloseFocusHold] = useState<
    { slug: string; terminalId: string } | null
  >(null);
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
  const {
    appThemePreference,
    setAppThemePreference,
    macOptionKeyMode,
    setMacOptionKeyMode,
    terminalFontFamily,
    setTerminalFontFamily,
    showUsageHarnessName,
    setShowUsageHarnessName,
    showGitHubLink,
    setShowGitHubLink,
    layoutMode,
    setLayoutMode,
    worktreesEnabled,
    setWorktreesEnabled,
    harnessSearchEnabled,
    setHarnessSearchEnabled,
    terminalSoundsEnabled,
    setTerminalSoundsEnabled,
    statusRailCollapsed,
    setStatusRailCollapsed,
    terminalSoundOverrides,
    setTerminalSoundOverrides,
    customWaitingSound,
    setCustomWaitingSound,
    customDoneSound,
    setCustomDoneSound,
  } = useAppPreferences();
  const [railWidth, setRailWidth] = useState(DEFAULT_RAIL_WIDTH_PX);
  const terminalsRef = useRef(terminals);
  const projectsRef = useRef(projects);
  const {
    localSummariesEnabled,
    setLocalSummariesEnabled,
    ayaIntelligence,
    terminalSummaries,
    projectSummaries,
    setSummaryNudge,
    autoSummaryStatus,
    rememberTerminalOutput,
    updateAyaIntelligence,
    effects: localSummaryEffects,
  } = useLocalSummaries({ terminalsRef, projectsRef });
  const effectiveTerminalFontFamily = terminalFontFamily.trim() || undefined;
  const [settingsInitialTab, setSettingsInitialTab] =
    useState<SettingsTab>("general");
  const [showSearch, setShowSearch] = useState(false);
  const [snippetDrawerTerminalId, setSnippetDrawerTerminalId] = useState<
    string | null
  >(null);
  const [showAttentionCenter, setShowAttentionCenter] = useState(false);
  const [showTeams, setShowTeams] = useState(false);
  const [pendingRepoImport, setPendingRepoImport] =
    useState<PendingRepoImport | null>(null);
  const [findInPaneFor, setFindInPaneFor] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH_PX);
  const [didBootstrap, setDidBootstrap] = useState(false);
  const [hideNoHarnessHint, setHideNoHarnessHint] = useState(
    () => localStorage.getItem(NO_HARNESS_HINT_DISMISSED_STORAGE_KEY) === "1",
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
  // Panes whose agent ran `aya status waiting` (with `on`: --on a teammate): the Teams window shows who waits on whom.
  const waitingPanes = useMemo<WaitingPanes>(() => waitingPanesOf(terminals), [terminals]);

  projectsRef.current = projects;
  const activeProjectIdRef = useRef(activeProjectId);
  activeProjectIdRef.current = activeProjectId;
  const {
    setGit,
    worktrees,
    pinnedCheckout,
    activeGitDirectory,
    activeGit,
    activeGithubLink,
    activeBranch,
    setGithubLinks,
    createWorktreeForProject,
    removeWorktreeForProject,
    pinCheckout,
  } = useGitStatus({
    projects,
    activeProjectId,
    projectFallbacks,
    activeTerminal,
    activeTabId,
    projectsRef,
    activeProjectIdRef,
    findProject,
    pollVisible,
    samePollPayload,
  });

  const { usageAccounts, codexUsageAccounts, grokUsage, monitoredSessions } =
    useUsagePolling(samePollPayload);

  // Handle "open this directory" requests from main — fired by `aya <dir>`
  // CLI invocations and the initial argv. Subscribed once; uses a ref to
  // always see the latest projects + handlers without resubscribing. The
  // preload holds opens sent before this subscribes and hands them over here.
  //
  // The IPC can arrive on `did-finish-load`, which is BEFORE the bootstrap
  // useEffect has populated projects state. If we processed it then, the
  // "find by directory" check sees an empty list and falls through to
  // auto-create — producing a duplicate next to whatever bootstrap loads.
  // So requests queue until bootstrap signals ready, then run one at a time.
  const openProjectRef = useRef<(dir: string) => Promise<void>>(async () => {});
  const [openQueue, setOpenQueue] = useState<string[]>([]);
  const openRunningRef = useRef(false);
  // Opens the page finished but whose project state the writer below has not saved:
  // main sends them again after a reload until this page says they are on disk.
  const unsavedOpensRef = useRef<string[]>([]);
  const [unsavedOpensTick, setUnsavedOpensTick] = useState(0);
  useEffect(() => {
    return window.aya.onOpenProject((dir) => {
      setOpenQueue((queue) => [...queue, dir]);
    });
  }, []);

  const { foundHarnessCount, harnessScanDone } = useHarnessScan();

  // Drain the open-project queue once bootstrap commits. Running this in a
  // useEffect (not inline after setDidBootstrap) guarantees React has flushed
  // setProjects → projectsRef.current before the handler tries to match by
  // directory. Without this gate the drain raced the commit and "aya <known
  // project path>" auto-created a duplicate, hitting the slug-collision error.
  // One open per commit for the same reason: two concurrent opens each built on
  // the same stale project list, and the second dropped the first.
  useEffect(() => {
    if (!didBootstrap || openRunningRef.current || openQueue.length === 0) return;
    openRunningRef.current = true;
    const dir = openQueue[0];
    void openProjectRef.current(dir).catch((err) => {
      console.warn(`[aya] could not open ${dir}:`, err);
    }).finally(() => {
      unsavedOpensRef.current.push(dir);
      setUnsavedOpensTick((tick) => tick + 1);
      openRunningRef.current = false;
      setOpenQueue((queue) => queue.slice(1));
    });
  }, [didBootstrap, openQueue]);

  const {
    isFullScreen,
    isMaximized,
    minimizeWindow,
    toggleMaximizeWindow,
    toggleFullScreenWindow,
    closeWindow,
  } = useWindowChrome();

  // GPU helper relaunch (#79): the main process signals when Chromium's GPU
  // process died and came back. Relay it as a window event so each visible
  // TerminalView re-runs its WebGL/PTY repair (it already listens for the same
  // kind of wake/focus events). One subscription for the whole renderer.
  useEffect(() => {
    return window.aya.onGpuRelaunched(() => {
      window.dispatchEvent(new Event(GPU_RELAUNCHED_EVENT));
    });
  }, []);

  const reloadProjects = useCallback(() => {
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
  }, []);
  useConfigReload({
    setSnippets,
    setPresets,
    setThemes,
    setActiveThemeId,
    reloadProjects,
  });

  terminalsRef.current = terminals;
  const allProjectsRef = useRef(allProjects);
  allProjectsRef.current = allProjects;
  const projectStateRef = useRef(projectState);
  projectStateRef.current = projectState;
  // Mirrors the active-tab map. closeTerminal advances this ref itself, so a
  // close arriving before the re-render still resolves the CURRENT active tab
  // rather than the one just closed.
  const activeTabByProjectRef = useRef(activeTabByProject);
  activeTabByProjectRef.current = activeTabByProject;
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
  useEffect(() => {
    if (!activeProjectId) return;
    setWarmProjectSlugs((prev) => [
      activeProjectId,
      ...prev.filter((slug) => slug !== activeProjectId),
    ].slice(0, WARM_PROJECT_TERMINAL_CACHE_SIZE));
  }, [activeProjectId]);

  const { handlePtyTimelineEvent } = usePtyTimelineEvents({
    terminalsRef,
    rememberTerminalOutput,
    appendProjectEvent,
  });

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

  const { updateProjectCollection, hydrateProjectTerminals, persistProject } =
    useProjectPersistence({
      didBootstrap,
      projectState,
      activeProjectId,
      activeTabByProject,
      singleViewByProject,
      unsavedOpensTick,
      unsavedOpensRef,
      projectsRef,
      setProjectState,
      setTerminals,
      setActiveTabByProject,
      setPresets,
      setDefaultPresets,
      setSnippets,
      setHomeDir,
      setThemes,
      setActiveThemeId,
      setAllProjects,
      setSingleViewByProject,
      setProjects,
      setRemotePresetsByProject,
      setMissingDirQueue,
      setActiveProjectId,
      setGit,
      setDidBootstrap,
    });

  usePtyEventRouter({
    currentTerminalsRef: terminalsRef,
    lastActivityRef,
    setTerminals,
    onPtyEvent: handlePtyTimelineEvent,
  });

  useLocalSummaryEffects(terminals, localSummaryEffects);

  // Questions an agent asked before Aya was last closed are still questions: put them back on their panes.
  useEffect(() => {
    if (!didBootstrap) return;
    void window.aya.agentWaiting().then((asked) => {
      setTerminals((prev) => {
        const entries = Object.entries(asked).filter(([id]) => prev[id] && !prev[id].externalStatus);
        if (entries.length === 0) return prev;
        const next = { ...prev };
        for (const [id, { text, since, restart }] of entries) {
          next[id] = applyReportedStatus(prev[id], { level: "waiting", text, updatedAt: since, restart });
        }
        return next;
      });
    }).catch(() => {});
  }, [didBootstrap]);

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
        const next = applyReportedStatus(terminal, { level: update.level, text, updatedAt: update.updatedAt, restart: update.restart, on: update.on });
        // A dialog still on screen: the pane did not finish, so no "finished" row either.
        if (next.status === controlLevelToTerminalStatus(update.level)) {
          appendProjectEvent({
            projectSlug: terminal.projectSlug,
            terminalId: terminal.id,
            level: update.level === "active" || update.level === WAITING_ON ? "active" : update.level,
            title: controlStatusEventTitle(terminal.name, update.level, update.on),
            detail: text,
            createdAt: update.updatedAt,
          });
        }
        return { ...prev, [id]: next };
      });
    });
  }, [appendProjectEvent]);

  useEffect(() => {
    if (!didBootstrap || !activeProjectId) return;
    const project = projectsRef.current.find((p) => p.slug === activeProjectId);
    if (!project) return;
    if (project.remote) return;
    const ignoredKey = repoConfigIgnoredKey(project.directory);
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
    }).catch(() => {
      // A repo file Aya cannot read (say, no permission) offers nothing, as a missing one does.
    });
    return () => {
      cancelled = true;
    };
  }, [activeProjectId, didBootstrap]);

  useProjectSessionPersistence({ terminals, didBootstrap, terminalsRef, persistProject });

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
    (preset: Preset, cwd?: string, sshTarget?: string) => {
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
        name: sshTarget ? `ssh ${sshTarget}` : defaultTabName(preset),
        cwd:
          cwd ??
          (project.remote ? project.remote.directory : effectiveCwd(project)),
        status: "running",
        bell: false,
        exitCode: null,
        ...(sshTarget ? { sshTarget } : {}),
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
    [activeTabByProject, activeLeafByProject, appendProjectEvent, effectiveCwd],
  );

  // aya team open / Apply panes: main picked the ids and assigns the roles
  // once the project is saved with the new tabs.
  useEffect(
    () =>
      window.aya.onTeamOpenPanes(({ requestId, projectSlug, panes }) => {
        const open = async () => {
          const project = findProject(projectsRef.current, projectSlug);
          if (!project) throw new Error(`project ${projectSlug} is not open in this window`);
          const added: Record<string, TerminalState> = {};
          for (const pane of panes) {
            if (!presetsRef.current.some((p) => p.id === pane.presetId)) throw new Error(`no preset "${pane.presetId}" in this window`);
            added[pane.id] = {
              id: pane.id,
              projectSlug,
              presetId: pane.presetId,
              name: pane.name,
              cwd: effectiveCwd(project),
              status: "running",
              bell: false,
              exitCode: null,
              ...(pane.teamLaunch ? { teamLaunch: true } : {}),
            };
          }
          // Refs first, as closeTerminal does: a save racing this one must see the new tabs.
          const next = { ...terminalsRef.current, ...added };
          terminalsRef.current = next;
          const tabs = Object.values(next)
            .filter((t) => t.projectSlug === projectSlug)
            .map((t) => tabFromTerminal(t, projectBaseCwd(project)));
          const updated: ProjectConfig = { ...project, tabs };
          setTerminals((prev) => ({ ...prev, ...added }));
          setAllProjects((ps) => ps.map((p) => (p.slug === projectSlug ? updated : p)));
          setProjects((ps) => ps.map((p) => (p.slug === projectSlug ? updated : p)));
          try {
            await window.aya.updateProject(updated);
          } catch (err) {
            // An unsaved tab would stay on screen with a running agent that main never assigns.
            const kept = { ...terminalsRef.current };
            for (const id of Object.keys(added)) delete kept[id];
            terminalsRef.current = kept;
            setTerminals((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => !(id in added))));
            setAllProjects((ps) => ps.map((p) => (p.slug === projectSlug ? project : p)));
            setProjects((ps) => ps.map((p) => (p.slug === projectSlug ? project : p)));
            for (const id of Object.keys(added)) void window.aya.ptyKill(id);
            throw err;
          }
          for (const pane of panes) {
            appendProjectEvent({ projectSlug, terminalId: pane.id, level: "active", title: `${pane.name} started` });
          }
        };
        void open().then(
          () => window.aya.teamPanesOpened(requestId, null),
          (err: unknown) => window.aya.teamPanesOpened(requestId, err instanceof Error ? err.message : String(err)),
        );
      }),
    [appendProjectEvent, effectiveCwd],
  );

  const closeTerminal = useCallback(
    (id: string) => {
      const t = terminalsRef.current[id];
      if (!t) return;
    // A closed tab plays no team role; a restart keeps it (same tab).
    void window.aya.teamReleasePane(t.projectSlug, id).catch(() => {});
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
      if (nextActive && activeProjectIdRef.current === t.projectSlug) {
        setCloseFocusHold({ slug: t.projectSlug, terminalId: nextActive });
      }
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
  const restartPtyHost = useCallback(async (): Promise<string | null> => {
    try {
      await window.aya.restartPtyHost();
    } catch (err) {
      // Restart failed or did not finish (the old host still runs, or the user cancelled). The panes are left as
      // they are, the red dot on Restart Aya stays, and Settings shows why.
      const reason = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") : String(err);
      // Saying no to the confirmation is not a failure to report.
      return reason === "restart cancelled" ? null : reason;
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
    return null;
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
      setCloseFocusHold(null);
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
      // Before the split guard: a click on the pane is the pick that ends a hold in any layout.
      setCloseFocusHold(null);
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
  }, [updateProjectCollection, setGit]);

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
  }, [updateProjectCollection, setGit]);

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
    [hydrateProjectTerminals, updateProjectCollection, setGit],
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
    [updateProjectCollection, setGit],
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
    // Reflect exactly what was persisted (deduped, malformed rows dropped)
    // rather than the raw draft, so the in-memory list can't drift from disk.
    setSnippets(await window.aya.listSnippets());
  }, []);

  const { updateTerminalFontFamily, updateShowGitHubLink } =
    useAppPreferenceActions({ setTerminalFontFamily, setShowGitHubLink, setGithubLinks });

  const { skinThemeColors, onSaveThemes, onImportTheme, activeThemeColors } =
    useAppTheme({
      appThemePreference,
      themes,
      activeThemeId,
      setThemes,
      setActiveThemeId,
      presetsRef,
      setPresets,
    });

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
  }, [appendProjectEvent, lastActivityRef]);

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
    // A live pane's background tasks and monitors stop with it: asked first when its screen shows some.
    if (maybeAlive && !(await window.aya.confirmPaneRestart(id).catch(() => true))) return;
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
  }, [appendProjectEvent, lastActivityRef]);

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
      sourcePresets.find((p) => p.id === PRESET_ID_SHELL) ?? sourcePresets[0] ?? BUILTIN_SHELL;
    launchTerminal(shellPreset);
  }, [launchTerminal]);

  /** A tab on one of the user's machines, from the machines popover: `ssh -- <target>` in the active project. */
  const openMachineTerminal = useCallback(
    (sshTarget: string) => launchTerminal(getPreset(presetsRef.current, PRESET_ID_SHELL), undefined, sshTarget),
    [launchTerminal],
  );

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
  }, [missingDirQueue, hydrateProjectTerminals, dequeueMissingDir, setGit]);

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

  const activeProject = activeProjectId
    ? findProject(projects, activeProjectId)
    : null;
  const activePresets =
    activeProject?.remote && activeProjectId
      ? (remotePresetsByProject[activeProjectId] ?? presets)
      : presets;
  const resumePanes = useMemo(
    () =>
      Object.values(terminals).map((t) => {
        const project = findProject(projects, t.projectSlug);
        const list = project?.remote ? (remotePresetsByProject[t.projectSlug] ?? presets) : presets;
        return { id: t.id, preset: getPreset(list, t.presetId), cwd: sessionDir(project, t) };
      }),
    [terminals, projects, presets, remotePresetsByProject],
  );
  // Once two panes of an agent have shared a folder, neither may ever "continue
  // the latest" there again, even after the other is closed.
  useEffect(() => {
    const sharing = sharingPaneIds(resumePanes);
    setTerminals((prev) => {
      const marked = Object.values(prev).filter((t) => sharing.has(t.id) && !t.sharedDir);
      if (marked.length === 0) return prev;
      const next = { ...prev };
      for (const t of marked) next[t.id] = { ...t, sharedDir: true as const };
      return next;
    });
  }, [resumePanes]);
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
  useGitHubLinkEffect({
    showGitHubLink,
    activeGitDirectory,
    activeBranch,
    setGithubLinks,
  });
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
        calculateVisibleTerminalIds(splitTree, paneRects, activeTabId, terminals),
      [splitTree, paneRects, activeTabId, terminals],
    ),
    sameArrayItems,
  );
  const { hiddenTerminals: hiddenTerminalsNext, assignableProjectTerminals: assignableProjectTerminalsNext } =
    useMemo(
      () => calculateTerminalLists(
        visibleTerminalIds,
        warmProjectSlugs,
        projectTerminals,
        terminals,
        projects,
        activeTabByProject,
      ),
      [
        visibleTerminalIds,
        warmProjectSlugs,
        projectTerminals,
        terminals,
        projects,
        activeTabByProject,
      ],
    );
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
  } = useMemo(
    () => calculateProjectBadges(
      terminals,
      monitoredSessions,
      projects,
      findProjectSlugForSession,
    ),
    [terminals, monitoredSessions, projects],
  );
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
  const {
    teamsByProject,
    activeTeams,
    teamToPrompt,
    onAssignTeamRole,
    dismissTeamPrompt,
    onTeamsWindowClosed,
  } = useTeams({ projects, activeProjectId, activeProjectRemote: !!activeProject?.remote });

  // Any overlay that should hold focus instead of the terminal. While one is
  // open, no terminal is "active" for focus purposes; closing the last one
  // hands focus back to the active terminal (via TerminalView's isActive effect).
  const anyOverlayOpen =
    chromeBlocked ||
    showSettings ||
    showSearch ||
    showAttentionCenter ||
    showTeams ||
    !!teamToPrompt ||
    !!pendingRepoImport;
  const closeFindPane = useCallback(() => setFindInPaneFor(null), []);
  useEffect(() => {
    if (closeFocusHold && closeFocusHold.slug !== activeProjectId) setCloseFocusHold(null);
  }, [closeFocusHold, activeProjectId]);
  const ignoreSnippetsOpenChange = useCallback(() => undefined, []);

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
    // Navigation is a pick even when it lands on the held pane (one tab left, edge of a split).
    prevTab: () => {
      setCloseFocusHold(null);
      cycleActiveProjectTab(-1);
    },
    nextTab: () => {
      setCloseFocusHold(null);
      cycleActiveProjectTab(1);
    },
    selectProject: (oneBasedIndex) => {
      const target = projects[oneBasedIndex - 1];
      if (target) setActiveProjectId(target.slug);
    },
    findInPane: () => {
      if (activeTabId) setFindInPaneFor(activeTabId);
    },
    focusPane: (direction) => {
      setCloseFocusHold(null);
      focusSplitPane(direction);
    },
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
              localStorage.setItem(NO_HARNESS_HINT_DISMISSED_STORAGE_KEY, "1");
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
                overrideTheme?.colors ?? skinThemeColors ?? activeThemeColors;
              return (
                <TerminalView
                  key={terminal.id}
                  paneStyle={paneStyle}
                  terminal={terminal}
                  preset={preset}
                  {...terminalSpawn(activeProject, preset, terminal, resumePanes, homeDir)}
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
                  isActive={
                    (isSplit ? activeLeafId === leafId : true) &&
                    !anyOverlayOpen &&
                    closeFocusHold?.terminalId !== terminal.id
                  }
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
                overrideTheme?.colors ?? skinThemeColors ?? activeThemeColors;
              return (
                <TerminalView
                  key={t.id}
                  terminal={t}
                  preset={preset}
                  {...terminalSpawn(project, preset, t, resumePanes, homeDir)}
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
              teamsByProject={teamsByProject}
              onAssignTeamRole={onAssignTeamRole}
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
              grokUsage={grokUsage}
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
              grokUsage={grokUsage}
              showUsageHarnessName={showUsageHarnessName}
            />
            {body ?? (
              <div
                className="aya-main"
                style={{ gridTemplateColumns: `${sidebarWidth}px 1fr` }}
              >
                <Sidebar
                  teams={activeTeams}
                  onAssignTeamRole={onAssignTeamRole}
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
        onOpenTeams={() => setShowTeams(true)}
        onOpenSettings={openSettings}
        onOpenMachineTerminal={activeProject ? openMachineTerminal : undefined}
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
      {showTeams && activeProject && (
        <TeamsModal
          project={activeProject}
          waiting={waitingPanes}
          intelligence={ayaIntelligence}
          onClose={() => {
            setShowTeams(false);
            onTeamsWindowClosed(activeProject.slug);
          }}
        />
      )}
      {!showTeams && teamToPrompt && activeProject && !chromeBlocked && (
        <TeamAssignPrompt
          project={activeProject}
          team={teamToPrompt}
          onOpenTeams={() => {
            dismissTeamPrompt(activeProject.slug, teamToPrompt.name);
            setShowTeams(true);
          }}
          onDismiss={() => dismissTeamPrompt(activeProject.slug, teamToPrompt.name)}
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
            localStorage.setItem(repoConfigIgnoredKey(pendingRepoImport.project.directory), "1");
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
              localStorage.setItem(repoConfigIgnoredKey(project.directory), "1");
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
