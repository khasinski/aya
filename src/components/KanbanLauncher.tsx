import { useEffect, useReducer, useState } from "react";
import type { BoardSnapshot } from "../types";

function boardSummary(board: BoardSnapshot): string {
  if (board.cards.length === 0) return "No cards";
  const counts = new Map<string, number>();
  for (const card of board.cards) counts.set(card.columnId, (counts.get(card.columnId) ?? 0) + 1);
  return board.columns
    .filter(column => counts.has(column.id))
    .map(column => `${column.title}: ${counts.get(column.id)}`)
    .join(" · ");
}

export function KanbanLauncher({ projectSlug, active, compact = false, onOpen }: {
  projectSlug: string | null;
  active: boolean;
  compact?: boolean;
  onOpen: () => void;
}) {
  const [snapshot, setSnapshot] = useState<{ slug: string; text: string } | null>(null);
  const [refreshVersion, requestRefresh] = useReducer(version => version + 1, 0);
  const summary = snapshot?.slug === projectSlug ? snapshot.text : "";

  useEffect(() => {
    if (!projectSlug) return;
    let disposed = false;
    let generation = 0;
    const refresh = async () => {
      const request = ++generation;
      try {
        const board = await window.aya.getBoard(projectSlug);
        if (!disposed && request === generation) setSnapshot({ slug: projectSlug, text: boardSummary(board) });
      } catch {
        if (!disposed && request === generation) setSnapshot({ slug: projectSlug, text: "Board unavailable" });
      }
    };
    const unsubscribe = window.aya.onBoardChange(slug => {
      if (slug === projectSlug) void refresh();
    });
    void refresh();
    return () => { disposed = true; unsubscribe(); };
  }, [projectSlug, refreshVersion]);

  return (
    <button
      type="button"
      className={compact
        ? `aya-kanban-sidebar-toggle${active ? " aya-kanban-sidebar-toggle--active" : ""}`
        : `aya-tab aya-termtab aya-kanban-tab${active ? " aya-tab--active" : ""}`}
      aria-label="Kanban"
      aria-description={summary || undefined}
      aria-current={active ? "true" : undefined}
      title={`Open Kanban board for this project${summary ? `\n${summary}` : ""}`}
      onClick={() => { requestRefresh(); onOpen(); }}
    >
      <span className={compact ? undefined : "aya-sidebar-icon"} style={{ color: "#58a6ff" }}>▦</span>
      <span className={compact ? undefined : "aya-termtab-main"}>
        <span className={compact ? undefined : "aya-tab-name"}>Kanban</span>
        {!compact && summary && <span className="aya-termtab-summary" data-testid="kanban-tab-summary">{summary}</span>}
      </span>
    </button>
  );
}
