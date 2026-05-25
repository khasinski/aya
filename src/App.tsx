import { useCallback, useEffect, useRef, useState } from "react";
import { MissingDirModal } from "./components/MissingDirModal";
import { NewProjectModal } from "./components/NewProjectModal";
import { SettingsModal } from "./components/SettingsModal";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TerminalView } from "./components/TerminalView";
import { TopBar } from "./components/TopBar";
import { detectApproval, looksBusy } from "./bell";
import {
  getPreset,
  type Preset,
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

function firstPresetId(presets: Preset[]): string {
  return presets[0]?.id ?? "shell";
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
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const fontSize = 13;

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

      const fallbackPresetId = firstPresetId(loadedPresets);

      // Auto-add a shell tab to projects that have none (and persist).
      const seededProjects: ProjectConfig[] = [];
      for (const project of loadedProjects) {
        if (project.tabs.length === 0) {
          const shellTab: WorkingTab = {
            id: uuid(),
            presetId: fallbackPresetId,
            name: fallbackPresetId,
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
      const term: TerminalState = {
        id,
        projectSlug: slug,
        presetId: preset.id,
        name: preset.id,
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
        const shellTab: WorkingTab = {
          id: uuid(),
          presetId: firstPresetId(presetsRef.current),
          name: firstPresetId(presetsRef.current),
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

  const onSaveThemes = useCallback(
    async (nextThemes: Theme[], nextActiveId: string) => {
      const activeId = nextThemes.some((t) => t.id === nextActiveId)
        ? nextActiveId
        : (nextThemes[0]?.id ?? "");
      await window.aya.saveThemes({ themes: nextThemes, activeId });
      setThemes(nextThemes);
      setActiveThemeId(activeId);
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

  const activeTheme = themes.find((t) => t.id === activeThemeId) ?? themes[0];
  const activeThemeColors: ThemeColors =
    activeTheme?.colors ?? FALLBACK_THEME_COLORS;

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
