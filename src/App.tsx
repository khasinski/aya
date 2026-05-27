import { useCallback, useEffect, useRef, useState } from "react";
import { EmptyState } from "./components/EmptyState";
import { MissingDirModal } from "./components/MissingDirModal";
import { NewProjectModal } from "./components/NewProjectModal";
import { SearchModal } from "./components/SearchModal";
import { SettingsModal } from "./components/SettingsModal";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TerminalView } from "./components/TerminalView";
import { TopBar } from "./components/TopBar";
import { useAppShortcuts } from "./hooks/useAppShortcuts";
import { useDoubleShiftSearch } from "./hooks/useDoubleShiftSearch";
import { usePtyEventRouter } from "./hooks/usePtyEventRouter";
import {
  useDockBadge,
  useRecentTerminalActivity,
  useTerminalNotifications,
} from "./hooks/useTerminalSignals";
import {
  BUILTIN_SHELL,
  getPreset,
  type Preset,
  presetSlug,
  type ProjectCollectionState,
  type ProjectConfig,
  type TerminalState,
  type Theme,
  type ThemeColors,
  type WorkingTab,
} from "./types";

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

/** Default display name for a freshly-created tab. Uses the preset's name
 *  so renaming a preset in Settings shows up on the next launch. */
function defaultTabName(preset: Preset): string {
  return preset.name.trim() || preset.id || "terminal";
}

export function App() {
  const [allProjects, setAllProjects] = useState<ProjectConfig[]>([]);
  const [projects, setProjects] = useState<ProjectConfig[]>([]);
  const [projectState, setProjectState] = useState<ProjectCollectionState>({
    version: 1,
    order: [],
    open: [],
    recent: [],
  });
  const [presets, setPresets] = useState<Preset[]>([]);
  const [defaultPresets, setDefaultPresets] = useState<Preset[]>([]);
  const [themes, setThemes] = useState<Theme[]>([]);
  const [activeThemeId, setActiveThemeId] = useState<string>("");
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [terminals, setTerminals] = useState<Record<string, TerminalState>>({});
  const [activeTabByProject, setActiveTabByProject] = useState<
    Record<string, string | null>
  >({});
  const [git, setGit] = useState<Record<string, GitInfo>>({});
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
  const [showSearch, setShowSearch] = useState(false);
  const [findInPaneFor, setFindInPaneFor] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [didBootstrap, setDidBootstrap] = useState(false);
  const [harnessScanDone, setHarnessScanDone] = useState(false);
  const [foundHarnessCount, setFoundHarnessCount] = useState(0);
  const [hideNoHarnessHint, setHideNoHarnessHint] = useState(
    () => localStorage.getItem("aya:no-harness-hint-dismissed") === "1",
  );
  const fontSize = 13;

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
    const id = setInterval(refresh, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [activeProjectId]);

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

  const { lastActivityRef, recentlyActiveIds } = useRecentTerminalActivity();
  useDockBadge(terminals);
  useTerminalNotifications({
    projects,
    terminals,
    setActiveProjectId,
    setActiveTabByProject,
  });

  const saveProjectCollectionState = useCallback(
    (next: ProjectCollectionState) => {
      const normalized: ProjectCollectionState = {
        version: 1,
        order: dedupeSlugs(next.order),
        open: dedupeSlugs(next.open),
        recent: dedupeSlugs(next.recent),
      };
      setProjectState(normalized);
      void window.aya.saveProjectState(normalized);
    },
    [],
  );

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
      setActiveTabByProject((prev) => ({
        ...prev,
        [project.slug]: project.tabs[0]?.id ?? null,
      }));
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
      ] =
        await Promise.all([
          window.aya.getCwd(),
          window.aya.listProjects(),
          window.aya.listProjectState(),
          window.aya.listPresets(),
          window.aya.getHomeDir(),
          window.aya.listThemes(),
        ]);
      setPresets(loadedPresets);
      setDefaultPresets(loadedPresets);
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
      const normalizedState: ProjectCollectionState = {
        version: 1,
        order: dedupeSlugs(order).filter((slug) => seededSlugs.has(slug)),
        open: dedupeSlugs(open).filter((slug) => seededSlugs.has(slug)),
        recent: dedupeSlugs(recent).filter((slug) => seededSlugs.has(slug)),
      };
      setProjectState(normalizedState);
      void window.aya.saveProjectState(normalizedState);
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
        setActiveProjectId(cwdProject.slug);
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

  usePtyEventRouter({ lastActivityRef, setTerminals });

  useEffect(() => {
    return window.aya.onControlStatus((update) => {
      setTerminals((prev) => {
        const entry = Object.entries(prev).find(([, terminal]) => {
          if (update.terminalId && terminal.id === update.terminalId) return true;
          if (update.projectSlug && terminal.projectSlug === update.projectSlug) {
            return true;
          }
          if (update.cwd && terminal.cwd === update.cwd) return true;
          return false;
        });
        if (!entry) return prev;
        const [id, terminal] = entry;
        if (update.level === "clear") {
          const { externalStatus, ...rest } = terminal;
          return {
            ...prev,
            [id]: {
              ...rest,
              status:
                externalStatus?.level === "waiting" ? "running" : terminal.status,
              bell: externalStatus?.level === "waiting" ? false : terminal.bell,
            },
          };
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
  }, []);

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
      const updated: ProjectConfig = { ...project, tabs };
      setAllProjects((ps) => ps.map((p) => (p.slug === slug ? updated : p)));
      setProjects((ps) => ps.map((p) => (p.slug === slug ? updated : p)));
      void window.aya.updateProject(updated);
    },
    [],
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
        persistProject(slug, next);
        return next;
      });
      setActiveTabByProject((prev) => ({ ...prev, [slug]: id }));
    },
    [persistProject, effectiveCwd],
  );

  const closeTerminal = useCallback(
    (id: string) => {
      const t = terminalsRef.current[id];
      if (!t) return;
      void window.aya.ptyKill(id);
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
    [persistProject],
  );

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

  const selectTerminal = useCallback((id: string) => {
    const t = terminalsRef.current[id];
    if (!t) return;
    setActiveTabByProject((prev) => ({ ...prev, [t.projectSlug]: id }));
    setTerminals((prev) => {
      const cur = prev[id];
      if (!cur || !cur.bell) return prev;
      return { ...prev, [id]: { ...cur, bell: false } };
    });
  }, []);

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
    saveProjectCollectionState({
      ...projectStateRef.current,
      order: nextOrder,
    });
  }, [saveProjectCollectionState]);

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
    const remaining = projectsRef.current.filter((p) => p.slug !== slug);
    setProjects(remaining);
    saveProjectCollectionState({
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
      saveProjectCollectionState({
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
    [hydrateProjectTerminals, saveProjectCollectionState],
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
        saveProjectCollectionState({
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
    [saveProjectCollectionState],
  );

  const onSavePresets = useCallback(async (next: Preset[]) => {
    await window.aya.savePresets(next);
    setPresets(next);
  }, []);

  /** Called by TerminalView when the user presses Shift+Enter in a
   *  cleanly-exited terminal. Clears the exit state so the PTY event router
   *  can resume updating status when the new PTY emits data. */
  const restartTerminal = useCallback((id: string) => {
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
        },
      };
    });
    // Also clear the activity timestamp so the dot doesn't claim "recently
    // active" until the new PTY actually writes something.
    delete lastActivityRef.current[id];
  }, []);

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
        },
      };
    });
    delete lastActivityRef.current[id];
    setRestartTriggers((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));
  }, []);

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

  const currentMissingDir = missingDirQueue[0] ?? null;
  const chromeBlocked = !!currentMissingDir || !!newProjectModal;

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
    openSettings: () => setShowSettings(true),
    prevTab: () => cycleActiveProjectTab(-1),
    nextTab: () => cycleActiveProjectTab(1),
    selectProject: (oneBasedIndex) => {
      const target = projects[oneBasedIndex - 1];
      if (target) setActiveProjectId(target.slug);
    },
    findInPane: () => {
      if (activeTabId) setFindInPaneFor(activeTabId);
    },
  });

  useDoubleShiftSearch({
    enabled: !chromeBlocked,
    onToggle: () => setShowSearch((s) => !s),
  });

  return (
    <div
      className={`aya-app ${isFullScreen ? "aya-app--fullscreen" : ""}`}
      data-theme="dark"
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
        onOpenSettings={() => setShowSettings(true)}
        projectBadges={projectBadges}
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
          onOpenSettings={() => setShowSettings(true)}
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
            onSelect={selectTerminal}
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
          />
          <div className="aya-panes">
            {Object.values(terminals).map((t) => {
              const preset = getPreset(presets, t.presetId);
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
                  key={t.id}
                  terminal={t}
                  preset={preset}
                  command={preset.command}
                  isVisible={t.id === activeTabId}
                  cwd={t.cwd}
                  lastActivity={lastActivityRef.current[t.id]}
                  fontSize={fontSize}
                  themeColors={colorsForTerminal}
                  findOpen={findInPaneFor === t.id}
                  onCloseFind={() => setFindInPaneFor(null)}
                  onOpenSettings={() => setShowSettings(true)}
                  onCloseProject={closeProject}
                  onRequestRestart={() => restartTerminal(t.id)}
                  restartTrigger={restartTriggers[t.id] ?? 0}
                />
              );
            })}
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
      {showSettings && (
        <SettingsModal
          presets={presets}
          defaults={defaultPresets}
          themes={themes}
          activeThemeId={activeThemeId}
          onClose={() => setShowSettings(false)}
          onSave={onSavePresets}
          onSaveThemes={onSaveThemes}
          onImportTheme={onImportTheme}
        />
      )}
    </div>
  );
}
