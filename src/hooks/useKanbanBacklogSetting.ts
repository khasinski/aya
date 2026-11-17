import { useCallback, useEffect, useState } from "react";

/** Settings > Kanban > Backlog. The main process keeps it, not this window's storage,
 *  so the CLI and every window see the same value. Off until the main process says on. */
export function useKanbanBacklogSetting(): [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabledState] = useState(false);
  useEffect(() => {
    let live = true;
    void window.aya.getBoardBacklogSetting?.().then((on) => {
      if (live) setEnabledState(on === true);
    }).catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    void window.aya.setBoardBacklogSetting({ enabled: next }).catch(() => setEnabledState(!next));
  }, []);
  return [enabled, setEnabled];
}
