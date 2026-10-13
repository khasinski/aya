import type { LeafRect, SplitNode } from "./split-tree";
import type { ProjectConfig, TerminalState } from "./types";

export function calculateVisibleTerminalIds(
  splitTree: SplitNode | null,
  paneRects: LeafRect[],
  activeTabId: string | null,
  terminals: Record<string, TerminalState>,
): string[] {
  return splitTree
    ? paneRects
        .map((pane) => pane.terminalId)
        .filter((id): id is string => !!id && !!terminals[id])
    : activeTabId
      ? [activeTabId]
      : [];
}

// spawnDeferred tabs (added by an external config edit, #4) stay out of the
// hidden pool: a hidden TerminalView mounts an xterm and spawns the PTY,
// and those tabs must not get a process until first activated.
//
// Keep all terminals for the active/recent projects warm, plus the active
// terminal for each other open project. That preserves fast project switches
// in the common working set without mounting every terminal in every project
// as hidden xterm DOM/WebGL state.
export function calculateTerminalLists(
  visibleTerminalIds: string[],
  warmProjectSlugs: string[],
  projectTerminals: TerminalState[],
  terminals: Record<string, TerminalState>,
  projects: ProjectConfig[],
  activeTabByProject: Record<string, string | null>,
): { hiddenTerminals: TerminalState[]; assignableProjectTerminals: TerminalState[] } {
  const visibleSet = new Set(visibleTerminalIds);
  const mountedSet = new Set(visibleTerminalIds);
  const warmProjectSlugSet = new Set(warmProjectSlugs);
  for (const terminal of projectTerminals) {
    mountedSet.add(terminal.id);
  }
  for (const terminal of Object.values(terminals)) {
    if (warmProjectSlugSet.has(terminal.projectSlug)) {
      mountedSet.add(terminal.id);
    }
  }
  for (const project of projects) {
    const terminalId =
      activeTabByProject[project.slug] ?? project.tabs[0]?.id;
    if (terminalId) mountedSet.add(terminalId);
  }
  return {
    hiddenTerminals: Object.values(terminals).filter(
      (terminal) =>
        mountedSet.has(terminal.id) &&
        !visibleSet.has(terminal.id) &&
        !terminal.spawnDeferred,
    ),
    assignableProjectTerminals: projectTerminals.filter(
      (terminal) => !visibleSet.has(terminal.id),
    ),
  };
}
