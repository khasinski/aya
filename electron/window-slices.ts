// Per-window project slices (multi-window, session-only).
//
// Disk keeps ONE ProjectCollectionState whose `open` is the UNION across all
// windows, so a restart reopens everything in a single window and older builds
// read the file unchanged. Which window shows which open project lives only in
// this in-memory registry: the boot window claims the whole on-disk list,
// later windows start empty, and every renderer save replaces just its own
// slice before the merged union is written back. Pure (no Electron imports)
// so the slice semantics are unit-testable.

import type { ProjectCollectionState } from "./types";

export class WindowProjectSlices {
  private readonly open = new Map<number, string[]>();
  private readonly activeProject = new Map<number, string | null>();
  private readonly activeTab = new Map<number, Record<string, string>>();

  /** Filter the on-disk state down to one window's slice. A window's first
   *  call claims its slice: the boot window inherits everything on disk
   *  (single-window back-compat), any other window starts empty. */
  stateForWindow(
    state: ProjectCollectionState,
    windowId: number,
    isBootWindow: boolean,
  ): ProjectCollectionState {
    let slice = this.open.get(windowId);
    if (slice === undefined) {
      slice = isBootWindow ? state.open : [];
      this.open.set(windowId, slice);
    }
    const remembered = this.activeProject.get(windowId);
    const activeProject =
      remembered != null && slice.includes(remembered)
        ? remembered
        : state.activeProject && slice.includes(state.activeProject)
          ? state.activeProject
          : (slice[0] ?? null);
    return {
      ...state,
      open: slice,
      activeProject,
      // Tells the renderer an empty list is intentional (secondary window),
      // not a first run - so it must skip the "open everything" fallback.
      secondaryWindow: !isBootWindow,
    };
  }

  /** Merge one window's save into the global state: its open-list replaces its
   *  slice and disk gets the union. order/recent come from the saving window
   *  (they are global lists every renderer holds in full); activeTab merges
   *  per-slug on top of the disk copy (a project lives in exactly one window,
   *  so last-writer-per-slug is correct). */
  mergeSave(
    incoming: ProjectCollectionState,
    windowId: number,
    diskState: ProjectCollectionState | null,
  ): ProjectCollectionState {
    this.open.set(windowId, incoming.open);
    this.activeProject.set(windowId, incoming.activeProject ?? null);
    this.activeTab.set(windowId, incoming.activeTab ?? {});
    const activeTab = {
      ...(diskState?.activeTab ?? {}),
      ...Object.assign({}, ...this.activeTab.values()),
    };
    return { ...incoming, open: this.openUnion(), activeTab };
  }

  /** Drop a dead window's slice. Returns the slugs it owned so the caller can
   *  move them to `recent` (their PTYs keep running in the detached host). */
  release(windowId: number): string[] {
    const released = this.open.get(windowId) ?? [];
    this.open.delete(windowId);
    this.activeProject.delete(windowId);
    this.activeTab.delete(windowId);
    return released;
  }

  /** Open projects across all live windows, first-claimed order. */
  openUnion(): string[] {
    const union: string[] = [];
    for (const slugs of this.open.values()) {
      for (const slug of slugs) {
        if (!union.includes(slug)) union.push(slug);
      }
    }
    return union;
  }

  /** The window currently showing a slug, if any (used by move / adopt). */
  windowOf(slug: string): number | null {
    for (const [windowId, slugs] of this.open) {
      if (slugs.includes(slug)) return windowId;
    }
    return null;
  }

  /** Last-saved active project of a window (labels the "Move to window…"
   *  menu); null when unknown or the window is empty. */
  activeProjectOf(windowId: number): string | null {
    return this.activeProject.get(windowId) ?? null;
  }
}
