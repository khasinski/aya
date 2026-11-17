import { useEffect, useState } from "react";
import { BACKLOG_COLUMN, isBacklogColumn } from "../../shared/board-columns.cjs";

/** Whether a project's board has the Backlog column (null while unknown or with no project),
 *  and Create backlog column, which adds it. */
export function useBacklogColumn(projectSlug: string | null) {
  const [hasBacklogColumn, setHasBacklogColumn] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    setHasBacklogColumn(null);
    if (!projectSlug) return;
    void window.aya.getBoard(projectSlug)
      .then((board) => { if (live) setHasBacklogColumn(board.columns.some(isBacklogColumn)); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [projectSlug]);
  const createBacklogColumn = () => {
    if (!projectSlug) return;
    void window.aya.addBoardColumn({ projectSlug, title: BACKLOG_COLUMN.title })
      .then((board) => setHasBacklogColumn(board.columns.some(isBacklogColumn)))
      .catch(() => undefined);
  };
  return { hasBacklogColumn, createBacklogColumn };
}
