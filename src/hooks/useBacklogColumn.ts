import { useEffect, useState } from "react";
import { BACKLOG_COLUMN, isBacklogColumn } from "../../shared/board-columns.cjs";
import { displayIpcError } from "../update-spawn";

/** Whether a project's board has the Backlog column (null while unknown or with no project),
 *  Create backlog column, which adds it, and why the last create failed (null when it did not). */
export function useBacklogColumn(projectSlug: string | null) {
  const [hasBacklogColumn, setHasBacklogColumn] = useState<boolean | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setHasBacklogColumn(null);
    setCreateError(null);
    if (!projectSlug) return;
    void window.aya.getBoard(projectSlug)
      .then((board) => { if (live) setHasBacklogColumn(board.columns.some(isBacklogColumn)); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [projectSlug]);
  const createBacklogColumn = () => {
    if (!projectSlug) return;
    setCreateError(null);
    void window.aya.addBoardColumn({ projectSlug, title: BACKLOG_COLUMN.title })
      .then((board) => setHasBacklogColumn(board.columns.some(isBacklogColumn)))
      .catch((err: unknown) => setCreateError(displayIpcError(err)));
  };
  return { hasBacklogColumn, createBacklogColumn, createError };
}
