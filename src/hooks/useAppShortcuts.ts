import { useEffect, useRef } from "react";

export interface ShortcutActions {
  newShell: () => void;
  closeCurrentTab: () => void;
  search: () => void;
  openSettings: () => void;
  prevTab: () => void;
  nextTab: () => void;
  selectProject: (oneBasedIndex: number) => void;
  findInPane: () => void;
}

export function useAppShortcuts(actions: ShortcutActions): void {
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    return window.aya.onShortcut((action) => {
      const a = actionsRef.current;
      if (action === "new-shell") a.newShell();
      else if (action === "close-tab") a.closeCurrentTab();
      else if (action === "search") a.search();
      else if (action === "open-settings") a.openSettings();
      else if (action === "prev-tab") a.prevTab();
      else if (action === "next-tab") a.nextTab();
      else if (action === "find-in-pane") a.findInPane();
      else if (action.startsWith("project-")) {
        const idx = parseInt(action.slice("project-".length), 10);
        if (Number.isFinite(idx)) a.selectProject(idx);
      }
    });
  }, []);
}
