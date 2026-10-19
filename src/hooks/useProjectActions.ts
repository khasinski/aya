import {
  useCallback,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { cancelPendingTerminalAttach } from "../pending-terminal-attach";
import {
  activeProjectAfterClose,
  dedupeSlugs,
  defaultTabName,
  mergeGitInfo,
  uniqueProjectName,
  type MissingDirEntry,
  type NewProjectModalState,
} from "../project-helpers";
import {
  BUILTIN_SHELL,
  type Preset,
  type ProjectCollectionState,
  type ProjectConfig,
  type ProjectGitInfo,
  type RemoteProjectCreateResult,
  type TerminalState,
  type WorkingTab,
} from "../types";
import { uuid } from "../uuid";
import { terminalKillRefusal } from "../terminal-kill-refusal";

interface ProjectActionsOptions {
  projectsRef: RefObject<ProjectConfig[]>;
  allProjectsRef: RefObject<ProjectConfig[]>;
  projectStateRef: RefObject<ProjectCollectionState>;
  terminalsRef: RefObject<Record<string, TerminalState>>;
  presetsRef: RefObject<Preset[]>;
  setProjects: Dispatch<SetStateAction<ProjectConfig[]>>;
  setAllProjects: Dispatch<SetStateAction<ProjectConfig[]>>;
  setTerminals: Dispatch<SetStateAction<Record<string, TerminalState>>>;
  setActiveProjectId: Dispatch<SetStateAction<string | null>>;
  setActiveTabByProject: Dispatch<SetStateAction<Record<string, string | null>>>;
  setSingleViewByProject: Dispatch<SetStateAction<Record<string, string | null>>>;
  setWarmProjectSlugs: Dispatch<SetStateAction<string[]>>;
  setGit: Dispatch<SetStateAction<Record<string, ProjectGitInfo>>>;
  setProjectFallbacks: Dispatch<SetStateAction<Record<string, string>>>;
  setRemotePresetsByProject: Dispatch<SetStateAction<Record<string, Preset[]>>>;
  setNewProjectModal: Dispatch<SetStateAction<NewProjectModalState | null>>;
  missingDirQueue: MissingDirEntry[];
  setMissingDirQueue: Dispatch<SetStateAction<MissingDirEntry[]>>;
  homeDir: string;
  updateProjectCollection: (next: ProjectCollectionState) => void;
  persistProject: (slug: string, nextTerminals: Record<string, TerminalState>) => void;
  hydrateProjectTerminals: (project: ProjectConfig, effectiveCwd: string) => void;
}

export function useProjectActions({
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
}: ProjectActionsOptions) {
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
  }, [updateProjectCollection, projectStateRef, setProjects]);

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
    [persistProject, setTerminals],
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
    [projectsRef, setAllProjects, setProjects],
  );

  /** Close the project tab without deleting its JSON config. Closed projects
   *  stay available from search / recent projects but do not auto-reopen. */
  const closeProject = useCallback(async (slug: string) => {
    const owned = Object.values(terminalsRef.current).filter(
      (t) => t.projectSlug === slug,
    );
    const releaseAttachCloses = owned.map(t => cancelPendingTerminalAttach(t.id));
    const kills = await Promise.allSettled(owned.map(async t => window.aya.ptyKill(t.id)))
      .finally(() => releaseAttachCloses.forEach(release => release()));
    const refused = kills.flatMap((result, i) => result.status === "rejected" ? [`${owned[i].name}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`] : []);
    if (refused.length) {
      const stopped = new Set(owned.filter((_t, i) => kills[i].status === "fulfilled").map(t => t.id));
      setTerminals(prev => Object.fromEntries(Object.entries(prev).map(([id, t]) => [id, stopped.has(id)
        ? { ...t, stopped: true, disconnected: undefined, exitCode: null, status: "idle", bell: false } : t])));
      window.alert(terminalKillRefusal("close", projectsRef.current.find(p => p.slug === slug)?.name ?? slug, refused.join("\n"), "project"));
      return;
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
      return activeProjectAfterClose(cur, slug, remaining);
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
  }, [
    updateProjectCollection,
    setGit,
    projectStateRef,
    projectsRef,
    setActiveProjectId,
    setActiveTabByProject,
    setProjectFallbacks,
    setProjects,
    setSingleViewByProject,
    setTerminals,
    setWarmProjectSlugs,
    terminalsRef,
  ]);

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
      return activeProjectAfterClose(cur, slug, remaining);
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
  }, [
    updateProjectCollection,
    setGit,
    projectStateRef,
    projectsRef,
    setActiveProjectId,
    setActiveTabByProject,
    setProjectFallbacks,
    setProjects,
    setSingleViewByProject,
    setTerminals,
    setWarmProjectSlugs,
    terminalsRef,
  ]);

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
    [releaseProject, projectsRef],
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
    [
      hydrateProjectTerminals,
      updateProjectCollection,
      setGit,
      projectStateRef,
      projectsRef,
      setActiveProjectId,
      setMissingDirQueue,
      setProjects,
      setRemotePresetsByProject,
    ],
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
    [
      updateProjectCollection,
      setGit,
      presetsRef,
      projectStateRef,
      projectsRef,
      setActiveProjectId,
      setActiveTabByProject,
      setAllProjects,
      setNewProjectModal,
      setProjects,
      setTerminals,
    ],
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
    [
      updateProjectCollection,
      projectStateRef,
      projectsRef,
      setActiveProjectId,
      setAllProjects,
      setNewProjectModal,
      setProjects,
      setRemotePresetsByProject,
    ],
  );

  const dequeueMissingDir = useCallback(() => {
    setMissingDirQueue((q) => q.slice(1));
  }, [setMissingDirQueue]);

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
  }, [missingDirQueue, hydrateProjectTerminals, dequeueMissingDir, setGit, projectsRef]);

  const handleUseHomeForMissingDir = useCallback(() => {
    const entry = missingDirQueue[0];
    if (!entry) return;
    setProjectFallbacks((prev) => ({ ...prev, [entry.slug]: homeDir }));
    const project = projectsRef.current.find((p) => p.slug === entry.slug);
    if (project) {
      hydrateProjectTerminals(project, homeDir);
    }
    dequeueMissingDir();
  }, [
    missingDirQueue,
    homeDir,
    hydrateProjectTerminals,
    dequeueMissingDir,
    projectsRef,
    setProjectFallbacks,
  ]);

  const showNewProjectModal = useCallback(() => {
    setNewProjectModal({
      defaults: { directory: "~/" },
      lockDirectory: false,
      title: "Open project",
      hint: "Type a project directory. Press Tab to complete paths.",
    });
  }, [setNewProjectModal]);

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
    [onCreateProject, openKnownProject, allProjectsRef, setNewProjectModal],
  );

  const openProject = async (rawDir: string) => {
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

  return {
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
  };
}
