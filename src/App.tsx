import { useCallback, useEffect, useRef, useState } from "react";
import { detectApproval } from "./bell";
import { findStatusTarget } from "./control-status-target";
import { clearedTerminalStatus } from "./pty-event-reducer";
import {
  applyExternalProjectEdits,
  mergeProjectsFromDisk,
} from "./project-reload";
import { AttentionCenter } from "./components/AttentionCenter";
import { EmptyState } from "./components/EmptyState";
import { MissingDirModal } from "./components/MissingDirModal";
import { NewProjectModal } from "./components/NewProjectModal";
import { ProjectPresetImportModal } from "./components/ProjectPresetImportModal";
import { SearchModal } from "./components/SearchModal";
import { SettingsModal } from "./components/SettingsModal";
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
import type { SettingsTab } from "./settings-tabs";
import {
  useDockBadge,
  useRecentTerminalActivity,
  useTerminalNotifications,
} from "./hooks/useTerminalSignals";
import {
  BUILTIN_SHELL,
  type Snippet,
  getPreset,
  type ProjectEvent,
  type Preset,
  type PtyEvent,
  presetSlug,
  type ProjectCollectionState,
  type ProjectConfig,
  type SplitLayout,
  type TerminalState,
  type Theme,
  type ThemeColors,
  type UsageData,
  type WorkingTab,
} from "./types";

// Cadence for polling the active project's git branch/dirty count (no inotify watch).
const GIT_STATUS_POLL_INTERVAL_MS = 3000;
// Cadence for re-reading the account-wide usage snapshot a user hook writes.
const USAGE_POLL_INTERVAL_MS = 30_000;
// Cap on retained entries in the project event timeline.
const MAX_PROJECT_EVENTS = 200;
// Cap on preset suggestions offered during repo preset import.
const MAX_SUGGESTED_PRESETS = 8;
// Minimum fractional size of a split pane; drives the drag clamp.
const MIN_SPLIT_PANE_FRACTION = 0.18;
// Default sidebar width in pixels.
const DEFAULT_SIDEBAR_WIDTH_PX = 240;
// Default terminal font size in pixels.
const TERMINAL_FONT_SIZE_PX = 13;
// Persisted schema version for ProjectCollectionState.
const PROJECT_STATE_VERSION = 1;
const APP_THEME_STORAGE_KEY = "aya:app-theme";
const MAC_OPTION_KEY_STORAGE_KEY = "aya:mac-option-key";
const TERMINAL_FONT_FAMILY_STORAGE_KEY = "aya:terminal-font-family";

type AppThemePreference = "system" | "light" | "dark";

function readAppThemePreference(): AppThemePreference {
  try {
    const value = localStorage.getItem(APP_THEME_STORAGE_KEY);
    return value === "light" || value === "dark" || value === "system"
      ? value
      : "system";
  } catch {
    return "system";
  }
}

function readMacOptionKeyMode(): MacOptionKeyMode {
  try {
    const value = localStorage.getItem(MAC_OPTION_KEY_STORAGE_KEY);
    return isMacOptionKeyMode(value) ? value : DEFAULT_MAC_OPTION_KEY_MODE;
  } catch {
    return DEFAULT_MAC_OPTION_KEY_MODE;
  }
}

function readTerminalFontFamily(): string {
  return localStorage.getItem(TERMINAL_FONT_FAMILY_STORAGE_KEY) ?? "";
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
  return Math.random().toString(36).slice(2, 10);
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

const MAX_SPLIT_ROWS = 5;
const MAX_SPLIT_COLS = 5;

function normalizeSplitLayoutForTabs(
  layout: SplitLayout | undefined,
  tabs: WorkingTab[],
  fallbackId: string | null,
): SplitLayout {
  const tabIds = new Set(tabs.map((tab) => tab.id));
  if (!layout) {
    return {
      rows: 1,
      cols: 1,
      rowFr: [1],
      colFr: [1],
      cells: [fallbackId && tabIds.has(fallbackId) ? fallbackId : (tabs[0]?.id ?? null)],
      activeCell: 0,
    };
  }
  const rows = Math.max(1, Math.min(MAX_SPLIT_ROWS, layout.rows));
  const cols = Math.max(1, Math.min(MAX_SPLIT_COLS, layout.cols));
  const size = rows * cols;
  const rowFr = layout.rowFr.slice(0, rows);
  const colFr = layout.colFr.slice(0, cols);
  while (rowFr.length < rows) rowFr.push(1);
  while (colFr.length < cols) colFr.push(1);
  const seenCells = new Set<string>();
  const cells = Array.from({ length: size }, (_, idx) => {
    const value = layout.cells[idx];
    if (!value || !tabIds.has(value) || seenCells.has(value)) return null;
    seenCells.add(value);
    return value;
  });
  if (!cells.some(Boolean)) {
    cells[0] = fallbackId && tabIds.has(fallbackId) ? fallbackId : (tabs[0]?.id ?? null);
  }
  return {
    rows,
    cols,
    rowFr,
    colFr,
    cells,
    activeCell: Math.max(0, Math.min(size - 1, layout.activeCell)),
  };
}

function singleTerminalLayout(terminalId: string | null): SplitLayout {
  return {
    rows: 1,
    cols: 1,
    rowFr: [1],
    colFr: [1],
    cells: [terminalId],
    activeCell: 0,
  };
}

function compactSplitLayout(layout: SplitLayout): SplitLayout | undefined {
  const assigned = layout.cells.filter(Boolean).length;
  if (assigned === 0) return undefined;
  if (layout.rows === 1 && layout.cols === 1 && assigned <= 1) return undefined;
  return layout;
}

function pruneEmptySplitTracks(layout: SplitLayout): SplitLayout {
  let rows = layout.rows;
  let cols = layout.cols;
  let rowFr = [...layout.rowFr];
  let colFr = [...layout.colFr];
  let cells = [...layout.cells];
  let activeCell = layout.activeCell;

  for (let row = rows - 1; row >= 0 && rows > 1; row -= 1) {
    const rowCells = cells.slice(row * cols, row * cols + cols);
    if (rowCells.some(Boolean)) continue;
    cells.splice(row * cols, cols);
    rowFr.splice(row, 1);
    rows -= 1;
    const activeRow = Math.floor(activeCell / cols);
    const activeCol = activeCell % cols;
    activeCell =
      activeRow > row
        ? (activeRow - 1) * cols + activeCol
        : Math.min(activeCell, rows * cols - 1);
  }

  for (let col = cols - 1; col >= 0 && cols > 1; col -= 1) {
    let empty = true;
    for (let row = 0; row < rows; row += 1) {
      if (cells[row * cols + col]) {
        empty = false;
        break;
      }
    }
    if (!empty) continue;
    const nextCells: (string | null)[] = [];
    for (let row = 0; row < rows; row += 1) {
      for (let currentCol = 0; currentCol < cols; currentCol += 1) {
        if (currentCol !== col) nextCells.push(cells[row * cols + currentCol]);
      }
    }
    const activeRow = Math.floor(activeCell / cols);
    const activeCol = activeCell % cols;
    colFr.splice(col, 1);
    cols -= 1;
    cells = nextCells;
    activeCell =
      activeCol > col
        ? activeRow * cols + activeCol - 1
        : Math.min(activeRow * cols + Math.min(activeCol, cols - 1), rows * cols - 1);
  }

  activeCell = Math.max(0, Math.min(rows * cols - 1, activeCell));
  return { rows, cols, rowFr, colFr, cells, activeCell };
}

function splitOffset(values: number[], index: number): number {
  const total = values.reduce((sum, value) => sum + value, 0);
  const before = values.slice(0, index + 1).reduce((sum, value) => sum + value, 0);
  return total > 0 ? (before / total) * 100 : 0;
}

function SplitResizeHandle({
  axis,
  index,
  colFr,
  rowFr,
  onResize,
}: {
  axis: "col" | "row";
  index: number;
  colFr: number[];
  rowFr: number[];
  onResize: (deltaPx: number, totalPx: number) => void;
}) {
  const offset = splitOffset(axis === "col" ? colFr : rowFr, index);
  return (
    <div
      className={`aya-split-resize aya-split-resize--${axis}`}
      style={axis === "col" ? { left: `${offset}%` } : { top: `${offset}%` }}
      onMouseDown={(event) => {
        event.preventDefault();
        const host = event.currentTarget.parentElement;
        if (!host) return;
        const rect = host.getBoundingClientRect();
        const start = axis === "col" ? event.clientX : event.clientY;
        const total = axis === "col" ? rect.width : rect.height;
        let lastDelta = 0;
        const move = (moveEvent: MouseEvent) => {
          const current = axis === "col" ? moveEvent.clientX : moveEvent.clientY;
          const delta = current - start;
          onResize(delta - lastDelta, total);
          lastDelta = delta;
        };
        const up = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
          document.body.style.cursor = "";
        };
        document.body.style.cursor = axis === "col" ? "col-resize" : "row-resize";
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
  const [defaultPresets, setDefaultPresets] = useState<Preset[]>([]);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [themes, setThemes] = useState<Theme[]>([]);
  const [activeThemeId, setActiveThemeId] = useState<string>("");
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [terminals, setTerminals] = useState<Record<string, TerminalState>>({});
  const [projectEvents, setProjectEvents] = useState<ProjectEvent[]>([]);
  const [activeTabByProject, setActiveTabByProject] = useState<
    Record<string, string | null>
  >({});
  const [singleViewByProject, setSingleViewByProject] = useState<
    Record<string, string | null>
  >({});
  const [git, setGit] = useState<Record<string, GitInfo>>({});
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [codexUsage, setCodexUsage] = useState<UsageData | null>(null);
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
  const [appThemePreference, setAppThemePreference] =
    useState<AppThemePreference>(readAppThemePreference);
  const [macOptionKeyMode, setMacOptionKeyMode] =
    useState<MacOptionKeyMode>(readMacOptionKeyMode);
  const [terminalFontFamily, setTerminalFontFamily] =
    useState(readTerminalFontFamily);
  const effectiveTerminalFontFamily = terminalFontFamily.trim() || undefined;
  const [settingsInitialTab, setSettingsInitialTab] =
    useState<SettingsTab>("general");
  const [showSearch, setShowSearch] = useState(false);
  const [showAttentionCenter, setShowAttentionCenter] = useState(false);
  const [pendingRepoImport, setPendingRepoImport] =
    useState<PendingRepoImport | null>(null);
  const [findInPaneFor, setFindInPaneFor] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH_PX);
  const [isFullScreen, setIsFullScreen] = useState(false);
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

  // Status-bar branch / dirty count goes stale once you `git checkout` in a
  // shell or commit something — there's no inotify watch, just a small poll
  // for the active project. ~50ms subprocess, 3s cadence; cancelled on
  // project switch.
  useEffect(() => {
    if (!activeProjectId) return;
    let cancelled = false;
    const refresh = () => {
      const project = projectsRef.current.find(
        (p) => p.slug === activeProjectId,
      );
      if (!project || cancelled) return;
      void window.aya.getGitInfo(project.directory).then((info) => {
        if (cancelled) return;
        setGit((g) => ({ ...g, [project.slug]: info }));
      });
    };
    refresh();
    const id = setInterval(refresh, GIT_STATUS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [activeProjectId]);

  // Re-read the account-wide usage snapshot a user hook writes (~/.aya/usage.json).
  // Aya only reads the file — it never fetches usage or touches any token.
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void window.aya.getUsage().then((u) => {
        if (!cancelled) setUsage(u);
      });
      void window.aya.getCodexUsage().then((u) => {
        if (!cancelled) setCodexUsage(u);
      });
    };
    refresh();
    const id = setInterval(refresh, USAGE_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
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

  // Track fullscreen state so the topbar can drop its left padding (the slot
  // for macOS traffic-light buttons, which hide in fullscreen).
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
  const activeProjectIdRef = useRef(activeProjectId);
  activeProjectIdRef.current = activeProjectId;
  const presetsRef = useRef(presets);
  presetsRef.current = presets;

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
      if (detectApproval(event.chunk)) {
        appendProjectEvent({
          projectSlug: terminal.projectSlug,
          terminalId: terminal.id,
          level: "waiting",
          title: `${terminal.name} is waiting`,
          detail: "Approval or input needed",
        });
      }
    },
    [appendProjectEvent],
  );

  const { lastActivityRef, recentlyActiveIds } = useRecentTerminalActivity();
  useDockBadge(terminals);
  useTerminalNotifications({
    projects,
    terminals,
    setActiveProjectId,
    setActiveTabByProject,
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
    }, 150);
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
            cwd: effectiveCwd,
            status: "running",
            bell: false,
            exitCode: null,
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
        openProjects.map((p) => window.aya.dirExists(p.directory)),
      );
      const queue: MissingDirEntry[] = [];
      for (let i = 0; i < openProjects.length; i++) {
        const project = openProjects[i];
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
        if (dirChecks[openProjects.indexOf(p)]) {
          void window.aya.getGitInfo(p.directory).then((info) => {
            setGit((g) => ({ ...g, [p.slug]: info }));
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
    lastActivityRef,
    setTerminals,
    onPtyEvent: handlePtyTimelineEvent,
  });

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
        const nextStatus =
          update.level === "waiting"
            ? "waiting"
            : update.level === "done"
              ? "idle"
              : update.level === "error"
                ? "error"
                : "running";
        appendProjectEvent({
          projectSlug: terminal.projectSlug,
          terminalId: terminal.id,
          level: update.level === "active" ? "active" : update.level,
          title:
            update.level === "waiting"
              ? `${terminal.name} is waiting`
              : update.level === "done"
                ? `${terminal.name} finished`
                : update.level === "error"
                  ? `${terminal.name} reported an error`
                  : `${terminal.name} updated status`,
          detail: text,
          createdAt: update.updatedAt,
        });
        return {
          ...prev,
          [id]: {
            ...terminal,
            status: nextStatus,
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
        .map((t) => ({ id: t.id, presetId: t.presetId, name: t.name }));
      const splitLayout = project.splitLayout
        ? compactSplitLayout(
            pruneEmptySplitTracks(
              normalizeSplitLayoutForTabs(project.splitLayout, tabs, tabs[0]?.id ?? null),
            ),
          )
        : undefined;
      const updated: ProjectConfig = {
        ...project,
        tabs,
        ...(splitLayout ? { splitLayout } : { splitLayout: undefined }),
      };
      setAllProjects((ps) => ps.map((p) => (p.slug === slug ? updated : p)));
      setProjects((ps) => ps.map((p) => (p.slug === slug ? updated : p)));
      void window.aya.updateProject(updated);
    },
    [],
  );

  const updateProjectSplitLayout = useCallback(
    (slug: string, updater: (layout: SplitLayout, project: ProjectConfig) => SplitLayout) => {
      const project = projectsRef.current.find((p) => p.slug === slug);
      if (!project) return;
      const fallbackId = activeTabByProject[slug] ?? project.tabs[0]?.id ?? null;
      const current = normalizeSplitLayoutForTabs(project.splitLayout, project.tabs, fallbackId);
      const normalized = normalizeSplitLayoutForTabs(
        updater(current, project),
        project.tabs,
        fallbackId,
      );
      const splitLayout = compactSplitLayout(normalized);
      const updated: ProjectConfig = {
        ...project,
        ...(splitLayout ? { splitLayout } : { splitLayout: undefined }),
      };
      setSingleViewByProject((prev) => ({ ...prev, [slug]: null }));
      setAllProjects((ps) => ps.map((p) => (p.slug === slug ? updated : p)));
      setProjects((ps) => ps.map((p) => (p.slug === slug ? updated : p)));
      void window.aya.updateProject(updated);
      const activeTerminalId = normalized.cells[normalized.activeCell];
      if (activeTerminalId) {
        setActiveTabByProject((prev) => ({ ...prev, [slug]: activeTerminalId }));
      }
    },
    [activeTabByProject],
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
    (preset: Preset) => {
      const slug = activeProjectIdRef.current;
      if (!slug) return;
      const project = findProject(projectsRef.current, slug);
      if (!project) return;
      const id = uuid();
      // Default the new tab's display name to the preset's current name (not
      // its id, which stays the same when the user renames a preset).
      const term: TerminalState = {
        id,
        projectSlug: slug,
        presetId: preset.id,
        name: defaultTabName(preset),
        cwd: effectiveCwd(project),
        status: "running",
        bell: false,
        exitCode: null,
      };
      setTerminals((prev) => {
        const next = { ...prev, [id]: term };
        const tabs: WorkingTab[] = Object.values(next)
          .filter((t) => t.projectSlug === slug)
          .map((t) => ({ id: t.id, presetId: t.presetId, name: t.name }));
        const currentLayout = project.splitLayout
          ? normalizeSplitLayoutForTabs(
              project.splitLayout,
              tabs,
              activeTabByProject[slug] ?? project.tabs[0]?.id ?? null,
            )
          : null;
        const splitLayout = currentLayout
          ? compactSplitLayout({
              ...currentLayout,
              cells: currentLayout.cells.map((cell, idx) =>
                idx === currentLayout.activeCell ? id : cell === id ? null : cell,
              ),
            })
          : undefined;
        const updated: ProjectConfig = {
          ...project,
          tabs,
          ...(splitLayout ? { splitLayout } : { splitLayout: undefined }),
        };
        setAllProjects((ps) => ps.map((p) => (p.slug === slug ? updated : p)));
        setProjects((ps) => ps.map((p) => (p.slug === slug ? updated : p)));
        void window.aya.updateProject(updated);
        return next;
      });
      setActiveTabByProject((prev) => ({ ...prev, [slug]: id }));
      setSingleViewByProject((prev) => ({
        ...prev,
        [slug]: project.splitLayout && prev[slug] ? id : null,
      }));
      appendProjectEvent({
        projectSlug: slug,
        terminalId: id,
        level: "active",
        title: `${term.name} started`,
        detail: preset.command,
      });
    },
    [activeTabByProject, appendProjectEvent, effectiveCwd],
  );

  const closeTerminal = useCallback(
    (id: string) => {
      const t = terminalsRef.current[id];
      if (!t) return;
    void window.aya.ptyKill(id);
    appendProjectEvent({
      projectSlug: t.projectSlug,
      terminalId: t.id,
      level: "info",
      title: `${t.name} closed`,
    });
    setTerminals((prev) => {
        const next = { ...prev };
        delete next[id];
        persistProject(t.projectSlug, next);
        const remaining = Object.values(next).filter(
          (x) => x.projectSlug === t.projectSlug,
        );
        setActiveTabByProject((p) =>
          p[t.projectSlug] === id
            ? {
                ...p,
                [t.projectSlug]:
                  remaining.length > 0
                    ? remaining[remaining.length - 1].id
                    : null,
              }
            : p,
        );
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
    await window.aya.restartPtyHost();
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
      updateProjectSplitLayout(terminal.projectSlug, (layout) => {
        const cells = layout.cells.map((cell) => (cell === id ? null : cell));
        cells[layout.activeCell] = id;
        return { ...layout, cells };
      });
  }, [updateProjectSplitLayout]);

  const assignTerminalToSplitCell = useCallback(
    (id: string, cellIndex: number) => {
      const terminal = terminalsRef.current[id];
      if (!terminal) return;
      setSingleViewByProject((prev) => ({ ...prev, [terminal.projectSlug]: null }));
      setActiveTabByProject((prev) => ({ ...prev, [terminal.projectSlug]: id }));
      updateProjectSplitLayout(terminal.projectSlug, (layout) => {
        const cells = layout.cells.map((cell) => (cell === id ? null : cell));
        const target = Math.max(0, Math.min(cells.length - 1, cellIndex));
        cells[target] = id;
        return { ...layout, cells, activeCell: target };
      });
    },
    [updateProjectSplitLayout],
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
      const layout = normalizeSplitLayoutForTabs(
        project.splitLayout,
        project.tabs,
        activeTabByProject[project.slug] ?? project.tabs[0]?.id ?? null,
      );
      const visibleCell = layout.cells.indexOf(id);
      if (project.splitLayout && visibleCell >= 0) {
        setSingleViewByProject((prev) => ({ ...prev, [project.slug]: null }));
        updateProjectSplitLayout(project.slug, (current) => ({
          ...current,
          activeCell: visibleCell,
        }));
        setActiveTabByProject((prev) => ({ ...prev, [project.slug]: id }));
        return;
      }
      collapseToSingleTerminal(terminal);
    },
    [activeTabByProject, collapseToSingleTerminal, updateProjectSplitLayout],
  );

  const addTerminalSplit = useCallback(
    (id: string, direction: "right" | "below") => {
      const terminal = terminalsRef.current[id];
      if (!terminal) return;
      setSingleViewByProject((prev) => ({ ...prev, [terminal.projectSlug]: null }));
      setActiveTabByProject((prev) => ({ ...prev, [terminal.projectSlug]: id }));
      updateProjectSplitLayout(terminal.projectSlug, (layout) => {
        const activeRow = Math.floor(layout.activeCell / layout.cols);
        const activeCol = layout.activeCell % layout.cols;
        if (direction === "right" && layout.cols >= MAX_SPLIT_COLS) return layout;
        if (direction === "below" && layout.rows >= MAX_SPLIT_ROWS) return layout;

        if (direction === "right") {
          const cols = layout.cols + 1;
          const cells: (string | null)[] = [];
          for (let row = 0; row < layout.rows; row += 1) {
            for (let col = 0; col < cols; col += 1) {
              if (row === activeRow && col === activeCol + 1) {
                cells.push(id);
              } else {
                const oldCol = col > activeCol ? col - 1 : col;
                const value = oldCol < layout.cols ? layout.cells[row * layout.cols + oldCol] : null;
                cells.push(value === id ? null : value);
              }
            }
          }
          return {
            rows: layout.rows,
            cols,
            rowFr: layout.rowFr,
            colFr: [
              ...layout.colFr.slice(0, activeCol + 1),
              layout.colFr[activeCol] ?? 1,
              ...layout.colFr.slice(activeCol + 1),
            ],
            cells,
            activeCell: activeRow * cols + activeCol + 1,
          };
        }

        const rows = layout.rows + 1;
        const cells: (string | null)[] = [];
        for (let row = 0; row < rows; row += 1) {
          for (let col = 0; col < layout.cols; col += 1) {
            if (row === activeRow + 1 && col === activeCol) {
              cells.push(id);
            } else {
              const oldRow = row > activeRow ? row - 1 : row;
              const value = oldRow < layout.rows ? layout.cells[oldRow * layout.cols + col] : null;
              cells.push(value === id ? null : value);
            }
          }
        }
        return {
          rows,
          cols: layout.cols,
          rowFr: [
            ...layout.rowFr.slice(0, activeRow + 1),
            layout.rowFr[activeRow] ?? 1,
            ...layout.rowFr.slice(activeRow + 1),
          ],
          colFr: layout.colFr,
          cells,
          activeCell: (activeRow + 1) * layout.cols + activeCol,
        };
      });
    },
    [updateProjectSplitLayout],
  );

  const removeTerminalFromSplit = useCallback(
    (id: string) => {
      const terminal = terminalsRef.current[id];
      if (!terminal) return;
      updateProjectSplitLayout(terminal.projectSlug, (layout) => {
        const cells = layout.cells.map((cell) => (cell === id ? null : cell));
        const activeCell =
          cells[layout.activeCell] === null
            ? Math.max(0, cells.findIndex(Boolean))
            : layout.activeCell;
        return pruneEmptySplitTracks({
          ...layout,
          cells,
          activeCell: activeCell < 0 ? 0 : activeCell,
        });
      });
    },
    [updateProjectSplitLayout],
  );

  const setActiveSplitCell = useCallback(
    (slug: string, cellIndex: number) => {
      setSingleViewByProject((prev) => ({ ...prev, [slug]: null }));
      updateProjectSplitLayout(slug, (layout) => ({
        ...layout,
        activeCell: Math.max(0, Math.min(layout.cells.length - 1, cellIndex)),
      }));
      // Keep the active terminal in sync with the focused cell, so the sidebar
      // highlight and the clear-on-focus effect both track a mouse click on a
      // pane (not just keyboard/sidebar navigation). Read the layout outside
      // the updater (mirrors focusSplitPane) to avoid a setState-in-updater.
      const project = projectsRef.current.find((p) => p.slug === slug);
      if (!project?.splitLayout) return;
      const layout = normalizeSplitLayoutForTabs(
        project.splitLayout,
        project.tabs,
        activeTabByProject[slug] ?? project.tabs[0]?.id ?? null,
      );
      const activeCell = Math.max(
        0,
        Math.min(layout.cells.length - 1, cellIndex),
      );
      const focusedId = layout.cells[activeCell];
      if (focusedId) {
        setActiveTabByProject((prev) => ({ ...prev, [slug]: focusedId }));
      }
    },
    [activeTabByProject, updateProjectSplitLayout],
  );

  const resizeSplit = useCallback(
    (slug: string, axis: "col" | "row", index: number, deltaPx: number, totalPx: number) => {
      updateProjectSplitLayout(slug, (layout) => {
        const values = axis === "col" ? [...layout.colFr] : [...layout.rowFr];
        if (index < 0 || index >= values.length - 1 || totalPx <= 0) return layout;
        const totalFr = values.reduce((sum, value) => sum + value, 0);
        const deltaFr = (deltaPx / totalPx) * totalFr;
        const min = MIN_SPLIT_PANE_FRACTION;
        const left = Math.max(min, values[index] + deltaFr);
        const right = Math.max(min, values[index + 1] - deltaFr);
        values[index] = left;
        values[index + 1] = right;
        return axis === "col"
          ? { ...layout, colFr: values }
          : { ...layout, rowFr: values };
      });
    },
    [updateProjectSplitLayout],
  );

  const focusSplitPane = useCallback(
    (direction: "left" | "right" | "up" | "down") => {
      if (!activeProjectId) return;
      const project = projectsRef.current.find((p) => p.slug === activeProjectId);
      if (!project?.splitLayout) return;
      const layout = normalizeSplitLayoutForTabs(
        project.splitLayout,
        project.tabs,
        activeTabByProject[project.slug] ?? project.tabs[0]?.id ?? null,
      );
      const row = Math.floor(layout.activeCell / layout.cols);
      const col = layout.activeCell % layout.cols;
      const nextRow =
        direction === "up" ? row - 1 : direction === "down" ? row + 1 : row;
      const nextCol =
        direction === "left" ? col - 1 : direction === "right" ? col + 1 : col;
      if (
        nextRow < 0 ||
        nextRow >= layout.rows ||
        nextCol < 0 ||
        nextCol >= layout.cols
      ) {
        return;
      }
      const nextCell = nextRow * layout.cols + nextCol;
      const terminalId = layout.cells[nextCell];
      setSingleViewByProject((prev) => ({ ...prev, [project.slug]: null }));
      updateProjectSplitLayout(project.slug, (current) => ({
        ...current,
        activeCell: nextCell,
      }));
      if (terminalId) {
        setActiveTabByProject((prev) => ({ ...prev, [project.slug]: terminalId }));
      }
    },
    [activeProjectId, activeTabByProject, updateProjectSplitLayout],
  );

  const splitActivePane = useCallback(
    (direction: "right" | "below") => {
      if (!activeProjectId) return;
      const project = projectsRef.current.find((p) => p.slug === activeProjectId);
      if (!project) return;
      const layout = normalizeSplitLayoutForTabs(
        project.splitLayout,
        project.tabs,
        activeTabByProject[project.slug] ?? project.tabs[0]?.id ?? null,
      );
      const terminalId =
        singleViewByProject[project.slug] ??
        layout.cells[layout.activeCell] ??
        activeTabByProject[project.slug] ??
        project.tabs[0]?.id ??
        null;
      if (terminalId) addTerminalSplit(terminalId, direction);
    },
    [activeProjectId, activeTabByProject, addTerminalSplit, singleViewByProject],
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

      const exists = await window.aya.dirExists(project.directory);
      if (exists) {
        hydrateProjectTerminals(project, project.directory);
        void window.aya.getGitInfo(project.directory).then((info) => {
          setGit((g) => ({ ...g, [project.slug]: info }));
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
          setGit((g) => ({ ...g, [withTabs.slug]: info })),
        );
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

  const updateAppThemePreference = useCallback((next: AppThemePreference) => {
    setAppThemePreference(next);
    try {
      localStorage.setItem(APP_THEME_STORAGE_KEY, next);
    } catch {
      /* ignore — localStorage can be unavailable in odd embedded contexts */
    }
  }, []);

  const updateMacOptionKeyMode = useCallback((next: MacOptionKeyMode) => {
    setMacOptionKeyMode(next);
    try {
      localStorage.setItem(MAC_OPTION_KEY_STORAGE_KEY, next);
    } catch {
      /* ignore — localStorage can be unavailable in odd embedded contexts */
    }
  }, []);

  const updateTerminalFontFamily = useCallback((next: string) => {
    setTerminalFontFamily(next);
    if (next.trim()) {
      localStorage.setItem(TERMINAL_FONT_FAMILY_STORAGE_KEY, next);
    } else {
      localStorage.removeItem(TERMINAL_FONT_FAMILY_STORAGE_KEY);
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
        },
      };
    });
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

  /** Right-click → "Restart" handler. Kills the existing PTY (alive or
   *  not) and asks TerminalView to spawn a fresh one. */
  const forceRestartTerminal = useCallback(async (id: string) => {
    const t = terminalsRef.current[id];
    if (!t) return;
    // Await the kill so the main-side ptys map is empty by the time the
    // new spawn IPC arrives — otherwise spawnPty treats it as a re-mount
    // and replays the old buffer instead of starting fresh.
    try {
      await window.aya.ptyKill(id);
    } catch {
      /* ignore — best effort */
    }
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
    const shellPreset =
      presetsRef.current.find((p) => p.id === "shell") ?? BUILTIN_SHELL;
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
    setActiveTabByProject((p) => ({ ...p, [slug]: tabs[next].id }));
  }, [activeTabByProject]);

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
        setGit((g) => ({ ...g, [project.slug]: info }));
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
  const openProjectSlugs = new Set(projects.map((p) => p.slug));
  const closedProjects = allProjects.filter(
    (p) => !openProjectSlugs.has(p.slug),
  );
  const projectTerminals: TerminalState[] = Object.values(terminals).filter(
    (t) => activeProjectId && t.projectSlug === activeProjectId,
  );
  const activeTabId = activeProjectId
    ? (activeTabByProject[activeProjectId] ?? null)
    : null;
  const activeTerminal = activeTabId ? (terminals[activeTabId] ?? null) : null;
  const activeGit = activeProjectId ? (git[activeProjectId] ?? null) : null;
  const savedSplitLayout =
    activeProject && activeProjectId
      ? normalizeSplitLayoutForTabs(
          activeProject.splitLayout,
          activeProject.tabs,
          activeTabId,
        )
      : null;
  const singleViewTerminalId =
    activeProjectId && singleViewByProject[activeProjectId] && terminals[singleViewByProject[activeProjectId]!]
      ? singleViewByProject[activeProjectId]
      : null;
  const splitLayout =
    savedSplitLayout && singleViewTerminalId
      ? singleTerminalLayout(singleViewTerminalId)
      : (savedSplitLayout ??
          (activeTabId ? singleTerminalLayout(activeTabId) : null));
  const isSplit =
    !!splitLayout &&
    !singleViewTerminalId &&
    !!activeProject?.splitLayout &&
    (splitLayout.rows > 1 ||
      splitLayout.cols > 1 ||
      splitLayout.cells.filter(Boolean).length > 1);
  const splitAssignments: Record<string, number> = {};
  if (savedSplitLayout && activeProject?.splitLayout) {
    savedSplitLayout.cells.forEach((terminalId, index) => {
      if (terminalId) splitAssignments[terminalId] = index;
    });
  }
  const splitActionLayout = savedSplitLayout ?? splitLayout;
  const canSplitRight = splitActionLayout
    ? splitActionLayout.cols < MAX_SPLIT_COLS
    : false;
  const canSplitBelow = splitActionLayout
    ? splitActionLayout.rows < MAX_SPLIT_ROWS
    : false;
  const visibleTerminalIds = splitLayout
    ? splitLayout.cells.filter((id): id is string => !!id && !!terminals[id])
    : activeTabId
      ? [activeTabId]
      : [];
  const visibleTerminalIdSet = new Set(visibleTerminalIds);
  // spawnDeferred tabs (added by an external config edit, #4) stay out of the
  // hidden pool: a hidden TerminalView mounts an xterm and spawns the PTY,
  // and those tabs must not get a process until first activated.
  const hiddenTerminals = Object.values(terminals).filter(
    (terminal) => !visibleTerminalIdSet.has(terminal.id) && !terminal.spawnDeferred,
  );
  const assignableProjectTerminals = projectTerminals.filter(
    (terminal) => !visibleTerminalIdSet.has(terminal.id),
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

  const projectBadges: Record<
    string,
    { count: number; level: "done" | "waiting" | "error" }
  > = {};
  const severityRank = { done: 1, waiting: 2, error: 3 } as const;
  for (const t of Object.values(terminals)) {
    let level: "done" | "waiting" | "error" | null = null;
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
    } else if (
      t.externalStatus?.level === "done" ||
      (t.status === "idle" && t.exitCode === 0 && t.presetId !== "shell")
    ) {
      level = "done";
    }
    if (!level) continue;
    const current = projectBadges[t.projectSlug];
    projectBadges[t.projectSlug] = {
      count: (current?.count ?? 0) + 1,
      level:
        !current || severityRank[level] > severityRank[current.level]
          ? level
          : current.level,
    };
  }
  const attentionCount = Object.values(projectBadges).reduce(
    (sum, badge) => sum + badge.count,
    0,
  );

  const focusTerminal = useCallback((slug: string, terminalId: string) => {
    setActiveProjectId(slug);
    setActiveTabByProject((prev) => ({ ...prev, [slug]: terminalId }));
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
  }, []);

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
      if (activeTabId) closeTerminal(activeTabId);
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
      <TopBar
        projects={projects}
        activeProjectId={activeProjectId}
        homeDir={homeDir}
        isDev={window.aya.isDev}
        blockChrome={chromeBlocked}
        closedProjects={closedProjects}
        onSelectProject={setActiveProjectId}
        onOpenProject={(slug) => {
          const project = allProjects.find((p) => p.slug === slug);
          if (project) void openKnownProject(project);
        }}
        onNewProject={showNewProjectModal}
        onCloseProject={closeProject}
        onRenameProject={renameProject}
        onReorderProjects={reorderProjects}
        onOpenSearch={() => setShowSearch(true)}
        onOpenSettings={openSettings}
        projectBadges={projectBadges}
        usage={usage}
        codexUsage={codexUsage}
      />
      {!didBootstrap ? (
        <main className="aya-empty aya-empty--loading" aria-busy="true">
          <div className="aya-empty-mark" aria-hidden="true">
            <span />
          </div>
          <h1>Opening Aya...</h1>
        </main>
      ) : isEmpty ? (
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
      ) : (
        <div
          className="aya-main"
          style={{ gridTemplateColumns: `${sidebarWidth}px 1fr` }}
        >
          <Sidebar
            terminals={projectTerminals}
            activeId={activeTabId}
            sidebarWidth={sidebarWidth}
            presets={presets}
            recentlyActiveIds={recentlyActiveIds}
            splitAssignments={splitAssignments}
            onSelect={selectTerminalFromSidebar}
            onClose={closeTerminal}
            onRename={renameTerminal}
            onLaunch={launchTerminal}
            onResize={setSidebarWidth}
            onReorder={(orderedIds) => {
              if (activeProjectId) {
                reorderTerminalsInProject(activeProjectId, orderedIds);
              }
            }}
            onRestart={forceRestartTerminal}
            canSplitRight={canSplitRight}
            canSplitBelow={canSplitBelow}
            onAssignToSplit={assignTerminalToActiveSplitCell}
            onSplitRight={(id) => addTerminalSplit(id, "right")}
            onSplitBelow={(id) => addTerminalSplit(id, "below")}
            onRemoveFromSplit={removeTerminalFromSplit}
          />
          <div
            className={`aya-panes ${isSplit ? "aya-panes--split" : ""}`}
            style={
              splitLayout
                ? {
                    gridTemplateColumns: splitLayout.colFr.map((fr) => `${fr}fr`).join(" "),
                    gridTemplateRows: splitLayout.rowFr.map((fr) => `${fr}fr`).join(" "),
                  }
                : undefined
            }
          >
            {splitLayout?.cells.map((terminalId, cellIndex) => {
              const terminal = terminalId ? terminals[terminalId] : null;
              if (!terminal) {
                return (
                  <div
                    key={`empty-${cellIndex}`}
                    className={`aya-pane aya-pane-empty ${
                      splitLayout.activeCell === cellIndex ? "aya-pane-empty--active" : ""
                    }`}
                    onClick={() => {
                      if (!activeProjectId) return;
                      setActiveSplitCell(activeProjectId, cellIndex);
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
                            const preset = getPreset(presets, candidate.presetId);
                            return (
                              <button
                                key={candidate.id}
                                className="aya-pane-empty-terminal"
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  assignTerminalToSplitCell(candidate.id, cellIndex);
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
              const preset = getPreset(presets, terminal.presetId);
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
                  terminal={terminal}
                  preset={preset}
                  command={preset.command}
                  snippets={snippets}
                  isVisible
                  cwd={terminal.cwd}
                  lastActivity={lastActivityRef.current[terminal.id]}
                  fontFamily={effectiveTerminalFontFamily}
                  fontSize={fontSize}
                  themeColors={colorsForTerminal}
                  findOpen={findInPaneFor === terminal.id}
                  onCloseFind={() => setFindInPaneFor(null)}
                  onOpenSettings={openSettings}
                  onCloseProject={closeProject}
                  onRequestRestart={() => restartTerminal(terminal.id)}
                  restartTrigger={restartTriggers[terminal.id] ?? 0}
                  macOptionKeyMode={macOptionKeyMode}
                  isActivePane={isSplit && splitLayout.activeCell === cellIndex}
                  isActive={
                    (isSplit ? splitLayout.activeCell === cellIndex : true) &&
                    !anyOverlayOpen
                  }
                  onActivatePane={() =>
                    activeProjectId && setActiveSplitCell(activeProjectId, cellIndex)
                  }
                  enableWebgl={!isSplit}
                />
              );
            })}
            {hiddenTerminals.map((t) => {
              const preset = getPreset(presets, t.presetId);
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
                  command={preset.command}
                  snippets={snippets}
                  isVisible={false}
                  cwd={t.cwd}
                  lastActivity={lastActivityRef.current[t.id]}
                  fontFamily={effectiveTerminalFontFamily}
                  fontSize={fontSize}
                  themeColors={colorsForTerminal}
                  findOpen={false}
                  onCloseFind={() => setFindInPaneFor(null)}
                  onOpenSettings={openSettings}
                  onCloseProject={closeProject}
                  onRequestRestart={() => restartTerminal(t.id)}
                  restartTrigger={restartTriggers[t.id] ?? 0}
                  macOptionKeyMode={macOptionKeyMode}
                  enableWebgl={false}
                />
              );
            })}
            {splitLayout && splitLayout.cols > 1 && activeProjectId &&
              Array.from({ length: splitLayout.cols - 1 }, (_, index) => (
                <SplitResizeHandle
                  key={`col-resize-${index}`}
                  axis="col"
                  index={index}
                  colFr={splitLayout.colFr}
                  rowFr={splitLayout.rowFr}
                  onResize={(delta, total) =>
                    resizeSplit(activeProjectId, "col", index, delta, total)
                  }
                />
              ))}
            {splitLayout && splitLayout.rows > 1 && activeProjectId &&
              Array.from({ length: splitLayout.rows - 1 }, (_, index) => (
                <SplitResizeHandle
                  key={`row-resize-${index}`}
                  axis="row"
                  index={index}
                  colFr={splitLayout.colFr}
                  rowFr={splitLayout.rowFr}
                  onResize={(delta, total) =>
                    resizeSplit(activeProjectId, "row", index, delta, total)
                  }
                />
              ))}
            {projectTerminals.length === 0 && activeProject && (
              <div className="aya-pane">
                <div className="aya-pane-header">
                  <span className="aya-pane-header-title">
                    No terminals — pick one from the sidebar.
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      <StatusBar
        project={activeProject}
        git={activeGit}
        terminal={activeTerminal}
        attentionCount={attentionCount}
        onOpenAttentionCenter={() => setShowAttentionCenter(true)}
        onOpenProjectDirectory={(directory) => {
          void window.aya.openPath(directory);
        }}
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
            setActiveProjectId(slug);
            setActiveTabByProject((prev) => ({ ...prev, [slug]: terminalId }));
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
          onAppThemePreferenceChange={updateAppThemePreference}
          terminalFontFamily={terminalFontFamily}
          onTerminalFontFamilyChange={updateTerminalFontFamily}
          macOptionKeyMode={macOptionKeyMode}
          onMacOptionKeyModeChange={updateMacOptionKeyMode}
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
