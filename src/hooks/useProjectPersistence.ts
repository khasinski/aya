import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { PROJECT_STATE_VERSION } from "../main-mirrors";
import { compactRecord, dedupeSlugs, defaultTabName, mergeGitInfo } from "../project-helpers";
import type { MissingDirEntry } from "../project-helpers";
import { hydrateProjectActiveTabs, hydrateProjectTerminalStates } from "../project-persistence";
import { compactTree, normalizeTreeForTabs, projectSplitTree } from "../split-tree";
import { uuid } from "../uuid";
import { projectBaseCwd, tabFromTerminal } from "../worktree";
import { BUILTIN_SHELL } from "../types";
import type {
  Preset,
  ProjectCollectionState,
  ProjectConfig,
  ProjectGitInfo,
  Snippet,
  TerminalState,
  Theme,
  WorkingTab,
} from "../types";

// Debounce for the single project-state disk writer (the #18 race fix).
const PROJECT_STATE_SAVE_DEBOUNCE_MS = 150;

type StateSetter<T> = Dispatch<SetStateAction<T>>;

interface ProjectPersistenceOptions {
  didBootstrap: boolean;
  projectState: ProjectCollectionState;
  activeProjectId: string | null;
  activeTabByProject: Record<string, string | null>;
  singleViewByProject: Record<string, string | null>;
  unsavedOpensTick: number;
  unsavedOpensRef: RefObject<string[]>;
  projectsRef: RefObject<ProjectConfig[]>;
  setProjectState: StateSetter<ProjectCollectionState>;
  setTerminals: StateSetter<Record<string, TerminalState>>;
  setActiveTabByProject: StateSetter<Record<string, string | null>>;
  setPresets: StateSetter<Preset[]>;
  setDefaultPresets: StateSetter<Preset[]>;
  setSnippets: StateSetter<Snippet[]>;
  setHomeDir: StateSetter<string>;
  setThemes: StateSetter<Theme[]>;
  setActiveThemeId: StateSetter<string>;
  setAllProjects: StateSetter<ProjectConfig[]>;
  setSingleViewByProject: StateSetter<Record<string, string | null>>;
  setProjects: StateSetter<ProjectConfig[]>;
  setRemotePresetsByProject: StateSetter<Record<string, Preset[]>>;
  setMissingDirQueue: StateSetter<MissingDirEntry[]>;
  setActiveProjectId: StateSetter<string | null>;
  setGit: StateSetter<Record<string, ProjectGitInfo>>;
  setDidBootstrap: StateSetter<boolean>;
}

export function useProjectPersistence(options: ProjectPersistenceOptions) {
  // Setters and shared refs are stable; keep the original mount-only closures.
  const initial = useRef(options);
  const {
    didBootstrap,
    projectState,
    activeProjectId,
    activeTabByProject,
    singleViewByProject,
    unsavedOpensTick,
  } = options;

  // Update the order/open/recent collection state. Persistence is centralised in
  // the single writer effect below, so this only updates in-memory state — it
  // never writes to disk itself (no scattered saves that can race or drop
  // fields). The active project / terminal / view live in their own state and
  // are persisted by the same writer.
  const updateProjectCollection = useCallback(
    (next: ProjectCollectionState) => {
      const { setProjectState } = initial.current;
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
    const { unsavedOpensRef } = initial.current;
    const savedWithThisState = [...unsavedOpensRef.current];
    const handle = window.setTimeout(() => {
      void window.aya
        .saveProjectState({
          version: PROJECT_STATE_VERSION,
          order: projectState.order,
          open: projectState.open,
          recent: projectState.recent,
          activeProject: activeProjectId,
          activeTab: compactRecord(activeTabByProject),
          singleView: compactRecord(singleViewByProject),
        })
        .then(() => {
          for (const dir of savedWithThisState) {
            const at = unsavedOpensRef.current.indexOf(dir);
            if (at === -1) continue;
            unsavedOpensRef.current.splice(at, 1);
            window.aya.openProjectDone(dir);
          }
        });
    }, PROJECT_STATE_SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [
    didBootstrap,
    projectState,
    activeProjectId,
    activeTabByProject,
    singleViewByProject,
    unsavedOpensTick,
  ]);

  // Hydration helper — instantiates TerminalStates for a project's saved tabs.
  // Pulled out of bootstrap so the missing-dir modal can defer hydration until
  // the user decides what to do.
  const hydrateProjectTerminals = useCallback(
    (project: ProjectConfig, effectiveCwd: string) => {
      const { setTerminals, setActiveTabByProject } = initial.current;
      setTerminals((prev) => hydrateProjectTerminalStates(prev, project, effectiveCwd));
      // Default the active tab to the first one ONLY when this project has no
      // valid active tab yet. A restored selection (set from the persisted
      // activeTab on boot) must survive hydration — clobbering it here is what
      // reset the active terminal to the first tab on restart (#18).
      setActiveTabByProject((prev) => hydrateProjectActiveTabs(prev, project));
    },
    [],
  );

  useEffect(() => {
    const {
      setPresets,
      setDefaultPresets,
      setSnippets,
      setHomeDir,
      setThemes,
      setActiveThemeId,
      setAllProjects,
      setProjectState,
      setActiveTabByProject,
      setSingleViewByProject,
      setProjects,
      setRemotePresetsByProject,
      setMissingDirQueue,
      setActiveProjectId,
      setGit,
      setDidBootstrap,
    } = initial.current;
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

  const persistProject = useCallback(
    (slug: string, nextTerminals: Record<string, TerminalState>): Promise<void> => {
      const { projectsRef, setAllProjects, setProjects } = initial.current;
      const project = projectsRef.current.find((p) => p.slug === slug);
      if (!project) return Promise.resolve();
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
      return window.aya.updateProject(updated);
    },
    [],
  );

  return { updateProjectCollection, hydrateProjectTerminals, persistProject };
}

interface ProjectSessionPersistenceOptions {
  terminals: Record<string, TerminalState>;
  didBootstrap: boolean;
  terminalsRef: RefObject<Record<string, TerminalState>>;
  persistProject: (slug: string, nextTerminals: Record<string, TerminalState>) => void;
}

// Called at the original session effect's position, after terminal subscriptions.
export function useProjectSessionPersistence(options: ProjectSessionPersistenceOptions) {
  const initial = useRef(options);
  const { terminals, didBootstrap, persistProject } = options;

  // A session id or sharedDir mark arrives while a terminal is already running,
  // so it needs its own persist trigger - the others (launch, rename, close) may
  // never fire again before the app quits, and an unsaved one means the next
  // restore may fall back to "latest session".
  const sessionIdSignature = Object.values(terminals)
    .filter((t) => t.sessionId || t.sharedDir)
    .map((t) => `${t.id}:${t.sessionId}:${t.sharedDir}`)
    .sort()
    .join("\n");
  useEffect(() => {
    if (!didBootstrap || !sessionIdSignature) return;
    const { terminalsRef } = initial.current;
    const slugs = new Set(
      Object.values(terminalsRef.current)
        .filter((t) => t.sessionId || t.sharedDir)
        .map((t) => t.projectSlug),
    );
    for (const slug of slugs) persistProject(slug, terminalsRef.current);
  }, [sessionIdSignature, didBootstrap, persistProject]);

}
