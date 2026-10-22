import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sharingPaneIds } from "./agentPreset";
import { projectBaseCwd } from "./worktree";
import { findStatusTarget } from "./control-status-target";
import {
  applyReportedStatus,
  clearedTerminalStatus,
  controlLevelToTerminalStatus,
  controlStatusEventTitle,
} from "./pty-event-reducer";
import {
  applyExternalProjectEdits,
  mergeProjectsFromDisk,
} from "./project-reload";
import {
  findProject,
  findProjectSlugForSession,
  mergeGitInfo,
  resumePanesForProjects,
  samePollPayload,
  sameProjectBadges,
  sameSessionRecords,
  uniquePresetId,
  type MissingDirEntry,
  type NewProjectModalState,
  type PendingRepoImport,
} from "./project-helpers";
import { PaneGrid } from "./components/PaneGrid";
import { AttentionCenter } from "./components/AttentionCenter";
import { TeamsModal } from "./components/TeamsModal";
import { TeamAssignPrompt } from "./components/TeamRole";
import { StatusRail } from "./components/StatusRail";
import { EmptyState, LoadingState } from "./components/EmptyState";
import { MissingDirModal } from "./components/MissingDirModal";
import { NewProjectModal } from "./components/NewProjectModal";
import { ProjectPresetImportModal } from "./components/ProjectPresetImportModal";
import { SearchModal } from "./components/SearchModal";
import { SettingsModal } from "./components/SettingsModal";
import {
  CommandRailLayout,
  CommandRailProjects,
  CommandRailSidebarHeader,
  CommandRailUsage,
} from "./components/CommandRailLayout";
import { ProjectsLeftLayout } from "./components/ProjectsLeftLayout";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TopBar } from "./components/TopBar";
import { WebWaitingBanners } from "./components/WebWaitingBanners";
import { useAppShortcuts } from "./hooks/useAppShortcuts";
import { useDoubleShiftSearch } from "./hooks/useDoubleShiftSearch";
import { usePtyEventRouter } from "./hooks/usePtyEventRouter";
import { useStable } from "./hooks/useStableIdentity";
import { sameArrayItems } from "./stable-identity";
import { useProjectActions } from "./hooks/useProjectActions";
import { useOpenQueue, useOpenQueueDrain } from "./hooks/useOpenQueue";
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
import { useTerminalActions } from "./hooks/useTerminalActions";
import { useSplitLayout, useSplitLayoutView } from "./hooks/useSplitLayout";
import { useHarnessScan, useUsagePolling } from "./hooks/useUsagePolling";
import { useWindowChrome } from "./hooks/useWindowChrome";
import { pollVisible } from "./poll-visible";
import { useGitHubLinkEffect, useGitStatus } from "./hooks/useGitStatus";
import {
  NO_HARNESS_HINT_DISMISSED_STORAGE_KEY,
  repoConfigIgnoredKey,
} from "./storage-keys";
import { GPU_RELAUNCHED_EVENT } from "./window-events";
import { uuid } from "./uuid";
import type { ReviewTarget } from "./diff-review";
import { normalizeSoundOverrides } from "./terminal-sound-prefs";
import { findLeafByTerminal, normalizeTreeForTabs, projectSplitTree } from "./split-tree";
import { useAppPreferences, useAppPreferenceActions } from "./hooks/useAppPreferences";
import { useProjectTimeline, usePtyTimelineEvents } from "./hooks/useProjectTimeline";
import { waitingPanesOf } from "./team-view";
import { calculateProjectBadges } from "./project-badges";
import {
  calculateTerminalLists,
  calculateVisibleTerminalIds,
} from "./terminal-visibility";
import {
  WAITING_ON,
  type Snippet,
  type Preset,
  type ProjectCollectionState,
  type ProjectConfig,
  type TerminalState,
  type WaitingPanes,
  type Theme,
  type UpdateStatus,
} from "./types";

// Cap on preset suggestions offered during repo preset import.
const MAX_SUGGESTED_PRESETS = 8;
const DEFAULT_SIDEBAR_WIDTH_PX = 240;
const DEFAULT_RAIL_WIDTH_PX = 220;

const TERMINAL_FONT_SIZE_PX = 13;
const WARM_PROJECT_TERMINAL_CACHE_SIZE = 4;



export function App() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const updateVisibleHeight = () => {
      document.documentElement.style.setProperty(
        "--aya-visual-height",
        `${Math.round(viewport.height)}px`,
      );
      document.documentElement.style.setProperty(
        "--aya-visual-top",
        `${Math.round(viewport.offsetTop)}px`,
      );
    };
    updateVisibleHeight();
    viewport.addEventListener("resize", updateVisibleHeight);
    viewport.addEventListener("scroll", updateVisibleHeight);
    return () => {
      viewport.removeEventListener("resize", updateVisibleHeight);
      viewport.removeEventListener("scroll", updateVisibleHeight);
      document.documentElement.style.removeProperty("--aya-visual-height");
      document.documentElement.style.removeProperty("--aya-visual-top");
    };
  }, []);

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
  const [updatePreparing, setUpdatePreparing] = useState(false);
  useEffect(() => {
    let eventVersion = 0;
    const unsubscribe = window.aya.onUpdateStatus((status) => {
      eventVersion += 1;
      setUpdatePreparing(Boolean(status.preparingUpdate));
    });
    const versionAtRead = eventVersion;
    void window.aya.getUpdateStatus().then((status: UpdateStatus) => {
      if (versionAtRead === eventVersion) setUpdatePreparing(Boolean(status.preparingUpdate));
    }).catch(() => {});
    return unsubscribe;
  }, []);
  const settingsOpenerRef = useRef<HTMLElement | null>(null);
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
    chromeStyle,
    setChromeStyle,
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
    const active = document.activeElement;
    settingsOpenerRef.current = active instanceof HTMLElement ? active : null;
    setSettingsInitialTab(tab);
    setShowSettings(true);
  }, []);

  useEffect(() => {
    if (showSettings) return;
    const opener = settingsOpenerRef.current;
    settingsOpenerRef.current = null;
    if (!opener) return;
    const frame = requestAnimationFrame(() => {
      if (opener.isConnected) opener.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [showSettings]);

  const closeSettings = useCallback(() => setShowSettings(false), []);

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
    createWorktreesForProject,
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

  const { usageAccounts, codexUsageAccounts, antigravityUsageAccounts, grokUsage, monitoredSessions } =
    useUsagePolling(samePollPayload);

  const { openProjectRef, unsavedOpensRef, unsavedOpensTick, drain: openQueueDrain } =
    useOpenQueue();

  const { foundHarnessCount, harnessScanDone } = useHarnessScan();

  useOpenQueueDrain({ didBootstrap, ...openQueueDrain });

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

  const {
    updateProjectSplitTree,
    assignTerminalToActiveSplitCell,
    assignTerminalToSplitCell,
    collapseToSingleTerminal,
    removeTerminalFromSplit,
    setActiveSplitCell,
    resizeSplit,
    focusSplitPane,
    splitActivePane,
    splitTerminalRight,
    splitTerminalBelow,
  } = useSplitLayout({
    projectsRef,
    terminalsRef,
    splitEnabledRef,
    activeProjectId,
    activeTabByProject,
    activeLeafByProject,
    singleViewByProject,
    setSingleViewByProject,
    setAllProjects,
    setProjects,
    setActiveLeafByProject,
    setActiveTabByProject,
    setTerminals,
    setCloseFocusHold,
  });

  const {
    launchTerminal,
    closeTerminal,
    restartPtyHost,
    renameTerminal,
    restartTerminal,
    restartTriggers,
    forceRestartTerminal,
    openShellTab,
    openMachineTerminal,
  } = useTerminalActions({
    projectFallbacks,
    activeProjectId,
    activeTabByProject,
    activeLeafByProject,
    activeProjectIdRef,
    activeTabByProjectRef,
    projectsRef,
    terminalsRef,
    presetsRef,
    remotePresetsByProjectRef,
    splitEnabledRef,
    lastActivityRef,
    setTerminals,
    setAllProjects,
    setProjects,
    setActiveTabByProject,
    setSingleViewByProject,
    setCloseFocusHold,
    appendProjectEvent,
    persistProject,
  });

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

  const {
    reorderProjects,
    reorderTerminalsInProject,
    renameProject,
    closeProject,
    moveProjectToWindow,
    openKnownProject,
    onCreateRemoteProject,
    handleCreateMissingDir,
    handleUseHomeForMissingDir,
    showNewProjectModal,
    submitProjectFromModal,
    openProject,
  } = useProjectActions({
    projectsRef,
    allProjectsRef,
    projectStateRef,
    terminalsRef,
    presetsRef,
    setProjects,
    setAllProjects,
    setTerminals,
    setActiveProjectId,
    setActiveTabByProject,
    setSingleViewByProject,
    setWarmProjectSlugs,
    setGit,
    setProjectFallbacks,
    setRemotePresetsByProject,
    setNewProjectModal,
    missingDirQueue,
    setMissingDirQueue,
    homeDir,
    updateProjectCollection,
    persistProject,
    hydrateProjectTerminals,
  });

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

  const activeProject = activeProjectId
    ? findProject(projects, activeProjectId)
    : null;
  const reviewTargets = useMemo<ReviewTarget[]>(() => {
    if (!activeProject || activeProject.remote) return [];
    return activeProject.tabs.flatMap((tab) => {
      const terminal = terminals[tab.id];
      if (!terminal || terminal.projectSlug !== activeProject.slug || terminal.exitCode !== null) return [];
      return [{ id: terminal.id, projectSlug: activeProject.slug, name: terminal.name }];
    });
  }, [activeProject, terminals]);
  const activePresets =
    activeProject?.remote && activeProjectId
      ? (remotePresetsByProject[activeProjectId] ?? presets)
      : presets;
  const resumePanes = useMemo(
    () => resumePanesForProjects(projects, terminals, presets, remotePresetsByProject),
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
  const {
    splitTree,
    isSplit,
    paneRects,
    paneDividers,
    splitAssignments,
    activeLeafId,
    canSplit,
  } = useSplitLayoutView({
    splitEnabled,
    activeProject,
    activeProjectId,
    activeTabId,
    singleViewByProject,
    terminals,
    activeLeafByProject,
    remotePresetsByProject,
    setRemotePresetsByProject,
  });

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
  const closeTabQueue = useRef(Promise.resolve());
  useEffect(() => {
    if (closeFocusHold && closeFocusHold.slug !== activeProjectId) setCloseFocusHold(null);
  }, [closeFocusHold, activeProjectId]);
  const ignoreSnippetsOpenChange = useCallback(() => undefined, []);

  const isEmpty =
    didBootstrap && projects.length === 0 && missingDirQueue.length === 0;

  // Refresh the open-project handler so it sees the latest projects + state.
  openProjectRef.current = openProject;

  useAppShortcuts({
    newShell: openShellTab,
    closeCurrentTab: () => {
      // Through the refs, not render state: a burst of closes must each act on
      // the tab that is active by then, not on a snapshot from the last render.
      closeTabQueue.current = closeTabQueue.current.then(async () => {
        const slug = activeProjectIdRef.current;
        const id = slug ? activeTabByProjectRef.current[slug] : null;
        if (id) await closeTerminal(id);
      }).catch(error => console.warn("close terminal failed", error));
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

  useEffect(() => {
    const onTerminalRegionKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.key !== "Tab" || chromeBlocked) return;
      const active = document.activeElement as HTMLElement | null;
      const terminalInput = active?.matches(".xterm-helper-textarea") ?? false;
      if (event.shiftKey) {
        if (terminalInput) return;
        const pane = isSplit
          ? document.querySelector<HTMLElement>(".aya-pane--active-split")
          : activeTabId
            ? document.querySelector<HTMLElement>(`[data-testid="terminal-pane"][data-terminal-id="${CSS.escape(activeTabId)}"]`)
            : null;
        const textarea = pane?.querySelector<HTMLElement>(".xterm-helper-textarea");
        if (!textarea) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        textarea.focus();
        return;
      }
      if (!terminalInput) return;
      const selector = layoutMode === "projects-left"
        ? '.aya-termtab[role="tab"][aria-selected="true"]'
        : '.aya-sidebar-row[role="listitem"][aria-current="true"]';
      const nextRegion = document.querySelector<HTMLElement>(selector);
      if (!nextRegion) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      nextRegion.focus();
    };
    document.addEventListener("keydown", onTerminalRegionKeyDown, true);
    return () => document.removeEventListener("keydown", onTerminalRegionKeyDown, true);
  }, [activeTabId, chromeBlocked, isSplit, layoutMode]);

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
      data-theme={appThemePreference === "system" ? undefined : appThemePreference}
      data-chrome={chromeStyle === "classic" ? undefined : chromeStyle}
      data-accent="green"
    >
      <WebWaitingBanners
        projects={projects}
        terminals={terminals}
        activeProjectId={activeProjectId}
        activeTerminalId={activeTabId}
        onSelectTerminal={focusTerminal}
      />
      {(() => {
        const loadingNode = <LoadingState />;
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
          <PaneGrid
            isSplit={isSplit}
            paneRects={paneRects}
            terminals={terminals}
            activeLeafId={activeLeafId}
            activeProjectId={activeProjectId}
            setActiveSplitCell={setActiveSplitCell}
            assignableProjectTerminals={assignableProjectTerminals}
            activePresets={activePresets}
            assignTerminalToSplitCell={assignTerminalToSplitCell}
            themes={themes}
            skinThemeColors={skinThemeColors}
            activeThemeColors={activeThemeColors}
            activeProject={activeProject}
            resumePanes={resumePanes}
            homeDir={homeDir}
            snippets={snippets}
            snippetDrawerTerminalId={snippetDrawerTerminalId}
            setSnippetDrawerTerminalId={setSnippetDrawerTerminalId}
            lastActivityRef={lastActivityRef}
            effectiveTerminalFontFamily={effectiveTerminalFontFamily}
            fontSize={fontSize}
            findInPaneFor={findInPaneFor}
            closeFindPane={closeFindPane}
            harnessSearchEnabled={harnessSearchEnabled}
            openSettings={openSettings}
            closeProject={closeProject}
            restartTerminal={restartTerminal}
            onSpawnFailure={(id) => setTerminals((prev) => {
              const terminal = prev[id];
              if (!terminal) return prev;
              return { ...prev, [id]: { ...terminal, status: "idle", stopped: true, exitCode: null, bell: false } };
            })}
            restartTriggers={restartTriggers}
            macOptionKeyMode={macOptionKeyMode}
            anyOverlayOpen={anyOverlayOpen}
            closeFocusHold={closeFocusHold}
            hiddenTerminals={hiddenTerminals}
            projects={projects}
            remotePresetsByProject={remotePresetsByProject}
            presets={presets}
            ignoreSnippetsOpenChange={ignoreSnippetsOpenChange}
            paneDividers={paneDividers}
            resizeSplit={resizeSplit}
            projectTerminals={projectTerminals}
          />
        );
        const commandRail = chromeStyle === "command-rail";
        const sidebarNode = (
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
            updatePreparing={updatePreparing}
            worktrees={worktrees}
            projectDir={
              activeProject ? projectBaseCwd(activeProject) : undefined
            }
            projectId={activeProjectId ?? undefined}
            projectRemote={Boolean(activeProject?.remote)}
            projectRemoteHost={activeProject?.remote?.label}
            onCreateWorktrees={createWorktreesForProject}
            onStartWorktrees={(projectId, preset, checkouts, prompt) => {
              for (const checkout of checkouts) {
                launchTerminal(preset, checkout.path, undefined, prompt, projectId);
              }
            }}
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
            header={
              commandRail ? (
                <CommandRailSidebarHeader
                  project={activeProject ?? null}
                  summary={localSummariesEnabled && activeProjectId ? projectSummaries[activeProjectId] : undefined}
                  homeDir={homeDir}
                  onRename={renameProject}
                />
              ) : undefined
            }
            extraSection={
              commandRail ? (
                <CommandRailProjects
                  projects={projects}
                  activeProjectId={activeProjectId}
                  homeDir={homeDir}
                  projectBadges={projectBadges}
                  projectSummaries={localSummariesEnabled ? projectSummaries : EMPTY_SUMMARIES}
                  onSelectProject={setActiveProjectId}
                />
              ) : undefined
            }
            footer={
              commandRail ? (
                <CommandRailUsage claude={usageAccounts} codex={codexUsageAccounts} antigravity={antigravityUsageAccounts} />
              ) : undefined
            }
          />
        );
        const body =
          !didBootstrap ? loadingNode : isEmpty ? emptyStateNode : null;
        // Variant A (classic layout) gets the avatar-rail shell; variant B
        // (projects-left) keeps its own layout, skinned by the same CSS.
        if (commandRail && layoutMode !== "projects-left") {
          return (
            <CommandRailLayout
              projects={projects}
              closedProjects={closedProjects}
              activeProjectId={activeProjectId}
              homeDir={homeDir}
              isDev={window.aya.isDev}
              platform={window.aya.platform}
              isFullScreen={isFullScreen}
              isMaximized={isMaximized}
              blockChrome={chromeBlocked}
              onSelectProject={setActiveProjectId}
              onOpenProject={openProjectBySlug}
              onNewProject={showNewProjectModal}
              onCloseProject={closeProject}
              onMoveProjectToWindow={moveProjectToWindow}
              onReorderProjects={reorderProjects}
              onOpenSearch={openSearch}
              onOpenSettings={openSettings}
              onMinimizeWindow={minimizeWindow}
              onToggleMaximizeWindow={toggleMaximizeWindow}
              onToggleFullScreenWindow={toggleFullScreenWindow}
              onCloseWindow={closeWindow}
              projectBadges={projectBadges}
              projectSummaries={localSummariesEnabled ? projectSummaries : EMPTY_SUMMARIES}
              teamsByProject={teamsByProject}
              sidebar={sidebarNode}
              sidebarWidth={sidebarWidth}
              panes={panesNode}
              body={body}
              activeProjectName={activeProject?.name}
              activeTerminalName={activeTerminal?.name}
            />
          );
        }
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
              antigravityUsageAccounts={antigravityUsageAccounts}
              grokUsage={grokUsage}
              showUsageHarnessName={showUsageHarnessName}
              commandRail={commandRail}
              worktrees={worktrees}
              terminals={projectTerminals}
              activeTerminalId={activeTabId}
              presets={activePresets}
              recentlyActiveIds={recentlyActiveIds}
              terminalSummaries={localSummariesEnabled ? terminalSummaries : EMPTY_SUMMARIES}
              onSelectTerminal={selectTerminalFromSidebar}
              onCloseTerminal={closeTerminal}
              onRenameTerminal={renameTerminal}
              onLaunchTerminal={launchTerminal}
            updatePreparing={updatePreparing}
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
              antigravityUsageAccounts={antigravityUsageAccounts}
              grokUsage={grokUsage}
              showUsageHarnessName={showUsageHarnessName}
            />
            {body ? (
              <main
                className="aya-main"
                aria-label="Terminal workspace"
                style={{ gridTemplateColumns: "1fr" }}
              >
                <h1 className="aya-visually-hidden">Aya</h1>
                {body}
              </main>
            ) : (
              <main
                className="aya-main"
                aria-label="Terminal workspace"
                style={{ gridTemplateColumns: `${sidebarWidth}px 1fr` }}
              >
                <h1 className="aya-visually-hidden">Aya</h1>
                {sidebarNode}
                {panesNode}
              </main>
            )}
          </>
        );
      })()}
      <StatusBar
        leading={
          chromeStyle === "command-rail" ? (
            <button
              type="button"
              className="aya-statusbar-item aya-statusbar-button aya-cr-cmdk"
              onClick={openSearch}
              disabled={chromeBlocked}
              title="Search (Cmd/Ctrl+K or Shift Shift)"
            >
              <kbd>{window.aya.platform === "darwin" ? "⌘K" : "Ctrl K"}</kbd>
              Jump to a terminal, search, run a command
            </button>
          ) : undefined
        }
        project={activeProject}
        reviewTargets={reviewTargets}
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
        onGitStatusRefresh={async (directory) => {
          const info = await window.aya.getGitInfo(directory);
          setGit((current) => mergeGitInfo(current, directory, info));
        }}
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
            if (updatePreparing) return;
            const preset = presets.find((p) => p.id === presetId);
            if (preset) launchTerminal(preset);
          }}
          launchDisabled={updatePreparing}
          onClose={() => setShowSearch(false)}
        />
      )}
      {showTeams && activeProject && (
        <TeamsModal
          project={activeProject}
          waiting={waitingPanes}
          intelligence={ayaIntelligence}
          onRestartPane={forceRestartTerminal}
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
          chromeStyle={chromeStyle}
          onChromeStyleChange={setChromeStyle}
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
          onClose={closeSettings}
          onSave={onSavePresets}
          onSaveSnippets={onSaveSnippets}
          onSaveThemes={onSaveThemes}
          onImportTheme={onImportTheme}
        />
      )}
    </div>
  );
}
