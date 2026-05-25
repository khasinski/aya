import { useCallback, useEffect, useRef, useState } from "react";
import { MissingDirModal } from "./components/MissingDirModal";
import { NewProjectModal } from "./components/NewProjectModal";
import { SearchModal } from "./components/SearchModal";
import { SettingsModal } from "./components/SettingsModal";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TerminalView } from "./components/TerminalView";
import { TopBar } from "./components/TopBar";
import { detectApproval, looksBusy } from "./bell";
import {
  BUILTIN_SHELL,
  getPreset,
  type Preset,
  presetSlug,
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

interface GitInfo {
  branch: string | null;
  dirty: number;
}

interface NewProjectModalState {
  defaults?: { name?: string; directory?: string };
  lockDirectory?: boolean;
  title?: string;
  hint?: string;
  cancelExits?: boolean;
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

/** Default display name for a freshly-created tab. Uses the preset's name
 *  so renaming a preset in Settings shows up on the next launch. */
function defaultTabName(preset: Preset): string {
  return preset.name.trim() || preset.id || "terminal";
}

export function App() {
  const [projects, setProjects] = useState<ProjectConfig[]>([]);
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
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const fontSize = 13;

  // Shortcut dispatch table. Stored in a ref so the subscribe-once effect
  // below always sees the freshest handlers without resubscribing.
  const shortcutActionsRef = useRef<{
    newShell: () => void;
    closeCurrentTab: () => void;
    openSettings: () => void;
    prevTab: () => void;
    nextTab: () => void;
    selectProject: (oneBasedIndex: number) => void;
  }>({
    newShell: () => {},
    closeCurrentTab: () => {},
    openSettings: () => {},
    prevTab: () => {},
    nextTab: () => {},
    selectProject: () => {},
  });

  // macOS dock badge: count of terminals waiting for user attention across
  // all projects. Empty string clears. Updates on every state change that
  // affects `terminals` — cheap because setDockBadge is a no-op on Linux/
  // Windows and same-string updates on macOS are idempotent at the OS level.
  useEffect(() => {
    const waitingCount = Object.values(terminals).filter((t) => t.bell).length;
    void window.aya.setDockBadge(waitingCount > 0 ? String(waitingCount) : "");
  }, [terminals]);

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

  // Double-Shift opens the search-everything modal. Listening for keyup on
  // window: any non-Shift keydown in between aborts the chain so Shift+key
  // combos (Shift+Enter etc.) don't accidentally trigger it. 300ms window.
  useEffect(() => {
    let lastShiftUp = 0;
    let chainActive = false;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Shift") chainActive = false;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== "Shift") return;
      // No other modifiers — exclude Shift+Cmd, Shift+Ctrl, etc.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const now = Date.now();
      if (chainActive && now - lastShiftUp < 300) {
        chainActive = false;
        // Don't open over a blocking modal — would stack confusingly.
        if (!currentMissingDirRef.current && !newProjectModalRef.current) {
          setShowSearch((s) => !s);
        }
        return;
      }
      lastShiftUp = now;
      chainActive = true;
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, []);

  // Refs of modal state so the double-shift effect (subscribed once) can
  // see the current value without resubscribing on every change.
  const currentMissingDirRef = useRef<unknown>(null);
  const newProjectModalRef = useRef<unknown>(null);

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
    return window.aya.onShortcut((action) => {
      const a = shortcutActionsRef.current;
      if (action === "new-shell") a.newShell();
      else if (action === "close-tab") a.closeCurrentTab();
      else if (action === "open-settings") a.openSettings();
      else if (action === "prev-tab") a.prevTab();
      else if (action === "next-tab") a.nextTab();
      else if (action.startsWith("project-")) {
        const idx = parseInt(action.slice("project-".length), 10);
        if (Number.isFinite(idx)) a.selectProject(idx);
      }
    });
  }, []);

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
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const activeProjectIdRef = useRef(activeProjectId);
  activeProjectIdRef.current = activeProjectId;
  const presetsRef = useRef(presets);
  presetsRef.current = presets;

  // Activity tracking for blinking dot.
  const lastActivityRef = useRef<Record<string, number>>({});
  const [activityTick, setActivityTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setActivityTick((t) => t + 1), 800);
    return () => clearInterval(id);
  }, []);
  const ACTIVITY_WINDOW_MS = 3000;
  const now = Date.now();
  const recentlyActiveIds = new Set<string>();
  for (const [tid, ts] of Object.entries(lastActivityRef.current)) {
    if (now - ts < ACTIVITY_WINDOW_MS) recentlyActiveIds.add(tid);
  }
  void activityTick;

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
      const [cwd, loadedProjects, loadedPresets, home, loadedThemes] =
        await Promise.all([
          window.aya.getCwd(),
          window.aya.listProjects(),
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
      setProjects(seededProjects);

      // Validate each project's directory in parallel.
      const dirChecks = await Promise.all(
        seededProjects.map((p) => window.aya.dirExists(p.directory)),
      );
      const queue: MissingDirEntry[] = [];
      for (let i = 0; i < seededProjects.length; i++) {
        const project = seededProjects[i];
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

      const cwdProject = seededProjects.find((p) => p.directory === cwd);
      if (cwdProject) {
        setActiveProjectId(cwdProject.slug);
      } else if (seededProjects.length > 0) {
        setActiveProjectId(seededProjects[0].slug);
        // Only suggest adding cwd as a project when we don't already have one
        // matching it AND no missing-dir modals are queued (otherwise the
        // user has to dismiss several modals in a row).
        if (queue.length === 0) {
          setNewProjectModal({
            defaults: { name: basename(cwd), directory: cwd },
            lockDirectory: true,
            title: "Start a project here?",
            hint: "This directory isn't a known project. Open it as one?",
          });
        }
      } else {
        setNewProjectModal({
          defaults: { name: basename(cwd), directory: cwd },
          lockDirectory: true,
          title: "Welcome to Aya",
          hint: "Create your first project to get started.",
          cancelExits: true,
        });
      }

      for (const p of seededProjects) {
        if (dirChecks[seededProjects.indexOf(p)]) {
          void window.aya.getGitInfo(p.directory).then((info) => {
            setGit((g) => ({ ...g, [p.slug]: info }));
          });
        }
      }

      // Bootstrap fully resolved — open-project IPCs queued by the open
      // handler can run now that projectsRef is populated. A small timeout
      // lets the latest setProjects commit before the queue drains.
      setTimeout(() => {
        bootReadyRef.current = true;
        const queued = pendingOpenRef.current;
        pendingOpenRef.current = [];
        for (const dir of queued) openProjectRef.current(dir);
      }, 0);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------------
  // PTY event router
  // ---------------------------------------------------------------------------
  useEffect(() => {
    return window.aya.onPtyEvent((event) => {
      if (event.type === "exit") {
        setTerminals((prev) => {
          const t = prev[event.ptyId];
          if (!t) return prev;
          const status = event.exitCode === 0 ? "idle" : "error";
          return {
            ...prev,
            [event.ptyId]: {
              ...t,
              status,
              bell: false,
              exitCode: event.exitCode,
            },
          };
        });
        return;
      }
      const chunk = event.chunk;
      lastActivityRef.current[event.ptyId] = Date.now();
      const isApproval = detectApproval(chunk);
      const busy = looksBusy(chunk);
      setTerminals((prev) => {
        const t = prev[event.ptyId];
        if (!t) return prev;
        if (t.exitCode !== null) return prev;
        let status = t.status;
        let bell = t.bell;
        if (isApproval) {
          status = "waiting";
          bell = true;
        } else if (busy && t.status === "waiting") {
          status = "running";
          bell = false;
        } else if (t.status !== "waiting") {
          status = "running";
        }
        if (status === t.status && bell === t.bell) return prev;
        return { ...prev, [event.ptyId]: { ...t, status, bell } };
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    try {
      await window.aya.saveProjectOrder(orderedSlugs);
    } catch (err) {
      console.error("saveProjectOrder failed:", err);
    }
  }, []);

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

  /** Close the project in this session only. The JSON file on disk is NOT
   *  touched — on next launch, the project reopens. To permanently delete,
   *  the user can `rm ~/.aya/projects/<slug>.json`. */
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
    setProjects((prev) => prev.filter((p) => p.slug !== slug));
    setActiveProjectId((cur) => {
      if (cur !== slug) return cur;
      const remaining = projectsRef.current.filter((p) => p.slug !== slug);
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
        setProjects((prev) => [...prev, withTabs]);
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
    [],
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
        [id]: { ...t, exitCode: null, status: "running", bell: false },
      };
    });
    // Also clear the activity timestamp so the dot doesn't claim "recently
    // active" until the new PTY actually writes something.
    delete lastActivityRef.current[id];
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
  const projectTerminals: TerminalState[] = Object.values(terminals).filter(
    (t) => activeProjectId && t.projectSlug === activeProjectId,
  );
  const activeTabId = activeProjectId
    ? (activeTabByProject[activeProjectId] ?? null)
    : null;
  const activeTerminal = activeTabId ? (terminals[activeTabId] ?? null) : null;
  const activeGit = activeProjectId ? (git[activeProjectId] ?? null) : null;

  const projectBadges: Record<string, number> = {};
  for (const t of Object.values(terminals)) {
    if (t.bell) projectBadges[t.projectSlug] = (projectBadges[t.projectSlug] ?? 0) + 1;
  }

  const currentMissingDir = missingDirQueue[0] ?? null;
  currentMissingDirRef.current = currentMissingDir;
  newProjectModalRef.current = newProjectModal;

  const activeTheme = themes.find((t) => t.id === activeThemeId) ?? themes[0];
  const activeThemeColors: ThemeColors =
    activeTheme?.colors ?? FALLBACK_THEME_COLORS;

  // Refresh the open-project handler so it sees the latest projects + state.
  openProjectRef.current = async (rawDir: string) => {
    const absDir = await window.aya.expandPath(rawDir);
    // 1. Exact directory match: just switch (no-op if already active).
    const existing = projectsRef.current.find((p) => p.directory === absDir);
    if (existing) {
      if (activeProjectIdRef.current !== existing.slug) {
        setActiveProjectId(existing.slug);
      }
      return;
    }
    // 2. Auto-create silently from basename. If the slug would collide with
    //    an existing project pointing at a different directory, open the
    //    name prompt instead so the user can pick something distinct.
    const name = basename(absDir);
    const slug = presetSlug(name);
    const slugCollides = projectsRef.current.some((p) => p.slug === slug);
    if (slugCollides) {
      setNewProjectModal({
        defaults: { name, directory: absDir },
        lockDirectory: true,
        title: "Name this project",
        hint: absDir,
      });
      return;
    }
    await onCreateProject(name, absDir);
  };

  // Refresh shortcut handlers on every render so the subscribe-once effect
  // always sees the latest closures (no stale state).
  shortcutActionsRef.current = {
    newShell: openShellTab,
    closeCurrentTab: () => {
      if (activeTabId) closeTerminal(activeTabId);
    },
    openSettings: () => setShowSettings(true),
    prevTab: () => cycleActiveProjectTab(-1),
    nextTab: () => cycleActiveProjectTab(1),
    selectProject: (oneBasedIndex) => {
      const target = projects[oneBasedIndex - 1];
      if (target) setActiveProjectId(target.slug);
    },
  };

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
        blockChrome={!!currentMissingDir || !!newProjectModal}
        onSelectProject={setActiveProjectId}
        onNewProject={async () => {
          const dir = await window.aya.pickDirectory();
          if (!dir) return;
          setNewProjectModal({
            defaults: { name: basename(dir), directory: dir },
            lockDirectory: true,
            title: "Name this project",
            hint: dir,
          });
        }}
        onCloseProject={closeProject}
        onRenameProject={renameProject}
        onReorderProjects={reorderProjects}
        onOpenSettings={() => setShowSettings(true)}
        projectBadges={projectBadges}
      />
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
                fontSize={fontSize}
                themeColors={colorsForTerminal}
                onRequestRestart={() => restartTerminal(t.id)}
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
      <StatusBar
        project={activeProject}
        git={activeGit}
        terminal={activeTerminal}
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
          defaultName={newProjectModal.defaults?.name}
          defaultDirectory={newProjectModal.defaults?.directory}
          lockDirectory={newProjectModal.lockDirectory}
          title={newProjectModal.title}
          hint={newProjectModal.hint}
          onSubmit={onCreateProject}
          onCancel={() => {
            if (newProjectModal.cancelExits) {
              window.close();
              return;
            }
            setNewProjectModal(null);
          }}
        />
      )}
      {showSearch && (
        <SearchModal
          projects={projects}
          terminals={terminals}
          presets={presets}
          lastActivity={lastActivityRef.current}
          onSelectProject={(slug) => setActiveProjectId(slug)}
          onSelectTerminal={(slug, terminalId) => {
            setActiveProjectId(slug);
            setActiveTabByProject((prev) => ({ ...prev, [slug]: terminalId }));
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
