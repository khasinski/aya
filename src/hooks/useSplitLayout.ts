import {
  useCallback,
  useEffect,
  useMemo,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  MAX_SPLIT_LEAVES,
  assignTerminal,
  compactTree,
  dividerRects,
  focusDirection,
  layoutRects,
  leafCount,
  leaves,
  normalizeTreeForTabs,
  paneAssignments,
  projectSplitTree,
  removeTerminal,
  renderedSplitTree,
  resizeSplit as resizeSplitNode,
  resolveActiveLeafId,
  splitLeaf,
  type SplitNode,
} from "../split-tree";
import type { Preset, ProjectConfig, TerminalState } from "../types";
import { uuid } from "../uuid";

interface SplitLayoutOptions {
  projectsRef: RefObject<ProjectConfig[]>;
  terminalsRef: RefObject<Record<string, TerminalState>>;
  splitEnabledRef: RefObject<boolean>;
  activeProjectId: string | null;
  activeTabByProject: Record<string, string | null>;
  activeLeafByProject: Record<string, string>;
  singleViewByProject: Record<string, string | null>;
  setSingleViewByProject: Dispatch<SetStateAction<Record<string, string | null>>>;
  setAllProjects: Dispatch<SetStateAction<ProjectConfig[]>>;
  setProjects: Dispatch<SetStateAction<ProjectConfig[]>>;
  setActiveLeafByProject: Dispatch<SetStateAction<Record<string, string>>>;
  setActiveTabByProject: Dispatch<SetStateAction<Record<string, string | null>>>;
  setTerminals: Dispatch<SetStateAction<Record<string, TerminalState>>>;
  setCloseFocusHold: Dispatch<SetStateAction<{ slug: string; terminalId: string } | null>>;
}

export function useSplitLayout({
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
}: SplitLayoutOptions) {
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
    [
      activeTabByProject,
      activeLeafByProject,
      projectsRef,
      setActiveLeafByProject,
      setActiveTabByProject,
      setAllProjects,
      setProjects,
      setSingleViewByProject,
    ],
  );

  const assignTerminalToActiveSplitCell = useCallback((id: string) => {
    const terminal = terminalsRef.current[id];
    if (!terminal) return;
    setActiveTabByProject((prev) => ({ ...prev, [terminal.projectSlug]: id }));
    updateProjectSplitTree(terminal.projectSlug, (tree, activeLeafId) => ({
      tree: assignTerminal(tree, activeLeafId, id),
    }));
  }, [updateProjectSplitTree, setActiveTabByProject, terminalsRef]);

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
    [updateProjectSplitTree, setActiveTabByProject, setSingleViewByProject, terminalsRef],
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
  }, [setActiveTabByProject, setSingleViewByProject, setTerminals]);

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
    [updateProjectSplitTree, setActiveTabByProject, setSingleViewByProject, terminalsRef],
  );

  const removeTerminalFromSplit = useCallback(
    (id: string) => {
      const terminal = terminalsRef.current[id];
      if (!terminal) return;
      updateProjectSplitTree(terminal.projectSlug, (tree) => ({
        tree: removeTerminal(tree, id),
      }));
    },
    [updateProjectSplitTree, terminalsRef],
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
    [updateProjectSplitTree, setCloseFocusHold, setSingleViewByProject, splitEnabledRef],
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
    [
      activeProjectId,
      activeTabByProject,
      activeLeafByProject,
      updateProjectSplitTree,
      projectsRef,
      setSingleViewByProject,
      splitEnabledRef,
    ],
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
      projectsRef,
      splitEnabledRef,
    ],
  );

  const splitTerminalRight = useCallback(
    (id: string) => addTerminalSplit(id, "right"),
    [addTerminalSplit],
  );
  const splitTerminalBelow = useCallback(
    (id: string) => addTerminalSplit(id, "below"),
    [addTerminalSplit],
  );

  return {
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
  };
}

interface SplitLayoutViewOptions {
  splitEnabled: boolean;
  activeProject: ProjectConfig | null;
  activeProjectId: string | null;
  activeTabId: string | null;
  singleViewByProject: Record<string, string | null>;
  terminals: Record<string, TerminalState>;
  activeLeafByProject: Record<string, string>;
  remotePresetsByProject: Record<string, Preset[]>;
  setRemotePresetsByProject: Dispatch<SetStateAction<Record<string, Preset[]>>>;
}

// Called at the original derived-layout position to keep the remote-presets
// effect after the same App effects, with the same inputs and cleanup timing.
export function useSplitLayoutView({
  splitEnabled,
  activeProject,
  activeProjectId,
  activeTabId,
  singleViewByProject,
  terminals,
  activeLeafByProject,
  remotePresetsByProject,
  setRemotePresetsByProject,
}: SplitLayoutViewOptions) {
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
  const splitTree = useMemo(
    () => renderedSplitTree(savedSplitTree, singleViewTerminalId, activeTabId),
    [savedSplitTree, singleViewTerminalId, activeTabId],
  );
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
  const splitAssignments = useMemo(
    () => paneAssignments(paneRects, hasStoredSplit),
    [paneRects, hasStoredSplit],
  );
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
  }, [activeProject, activeProjectId, remotePresetsByProject, setRemotePresetsByProject]);

  return {
    splitTree,
    isSplit,
    paneRects,
    paneDividers,
    splitAssignments,
    activeLeafId,
    canSplit,
  };
}
