import type { KanbanCard } from "../types";
import "./kanban.css";
import { isLongCardDescription, KanbanCardMarkdown } from './KanbanCardContent';
import { PRIORITY_OPTIONS, type KanbanViewModel } from './useKanbanBoard';

type ShelfRowProps = Pick<
  KanbanViewModel,
  "terminal"
  | "expandedCards"
  | "setExpandedCards"
  | "confirmDeleteCardId"
  | "setConfirmDeleteCardId"
  | "shiftDeleteReady"
  | "setPreviewImage"
  | "handleDeleteArchivedCard"
> & {
  card: KanbanCard;
  /** What the meta line names as the card's column. */
  columnLabel: string;
  /** Prefixed to the card id for the row's test id. */
  testIdPrefix: string;
  /** When the card went onto the shelf; shown after the column. */
  shelvedAt: string | undefined;
  onRestore: () => void;
  restoreTitle: string;
  deleteLabel: string;
  /** The delete button's title while Shift is not held. */
  deleteTitle: string;
};

/** One card in the shelf drawer, on the Archive or the Backlog tab: the drawer passes what differs. */
export function ShelfRow({
  terminal,
  expandedCards,
  setExpandedCards,
  confirmDeleteCardId,
  setConfirmDeleteCardId,
  shiftDeleteReady,
  setPreviewImage,
  handleDeleteArchivedCard,
  card,
  columnLabel,
  testIdPrefix,
  shelvedAt,
  onRestore,
  restoreTitle,
  deleteLabel,
  deleteTitle,
}: ShelfRowProps) {
  const priorityMeta = card.priority
    ? PRIORITY_OPTIONS.find((p) => p.value === card.priority)
    : null;
  const isExpanded = Boolean(expandedCards[card.id]);
  const isLongDesc = isLongCardDescription(card.description);
  const shelvedDate = shelvedAt
    ? new Date(shelvedAt).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    })
    : null;

  return (
    <div
      data-testid={`${testIdPrefix}${card.id}`}
      className="aya-kanban-card aya-kanban-card--archived"
      onMouseLeave={() => {
        if (confirmDeleteCardId === card.id) {
          setConfirmDeleteCardId(null);
        }
      }}
    >
      <div className="aya-kanban-card-meta">
        <div className="aya-kanban-card-meta-left">
          <span className="aya-kanban-card-id">{card.id}</span>
          {priorityMeta && (
            <span
              className={`aya-kanban-priority-badge aya-kanban-priority-badge--${priorityMeta.value}`}
            >
              {priorityMeta.short}
            </span>
          )}
          <span className="aya-kanban-archive-meta">
            {columnLabel}
            {shelvedDate ? ` · ${shelvedDate}` : ""}
          </span>
        </div>
        <div className="aya-kanban-card-quick aya-kanban-card-quick--visible">
          <button
            type="button"
            className="aya-kanban-archive-restore-btn"
            title={restoreTitle}
            onClick={() => onRestore()}
          >
            ↩ Restore
          </button>
          {confirmDeleteCardId === card.id ? (
            <button
              type="button"
              className="aya-kanban-delete-confirm"
              title="Confirm permanent deletion"
              onClick={() =>
                void handleDeleteArchivedCard(card.id)
              }
            >
              Delete?
            </button>
          ) : (
            <button
              type="button"
              className={`aya-kanban-iconbtn aya-kanban-iconbtn--danger${shiftDeleteReady
                ? " aya-kanban-iconbtn--shift-ready"
                : ""
                }`}
              title={
                shiftDeleteReady
                  ? "Permanently delete card (Shift held)"
                  : deleteTitle
              }
              aria-label={deleteLabel}
              onClick={(e) => {
                if (e.shiftKey || shiftDeleteReady) {
                  void handleDeleteArchivedCard(card.id);
                } else {
                  setConfirmDeleteCardId(card.id);
                }
              }}
            >
              {shiftDeleteReady ? "⌫" : "×"}
            </button>
          )}
        </div>
      </div>

      <div className="aya-kanban-card-title">{card.title}</div>

      {card.labels && card.labels.length > 0 && (
        <div className="aya-kanban-card-labels">
          {card.labels.map((lbl) => (
            <span key={lbl} className="aya-kanban-label-pill">
              #{lbl}
            </span>
          ))}
        </div>
      )}

      {card.description && (
        <div className="aya-kanban-card-desc-wrap">
          <div
            className={`aya-kanban-card-desc${isExpanded
              ? " aya-kanban-card-desc--expanded"
              : ""
              }`}
          >
            <KanbanCardMarkdown
              projectSlug={terminal.projectSlug}
              text={card.description}
              onPreviewImage={setPreviewImage}
            />
          </div>
          {isLongDesc && (
            <button
              type="button"
              className="aya-kanban-desc-toggle"
              onClick={() =>
                setExpandedCards((prev) => ({
                  ...prev,
                  [card.id]: !prev[card.id],
                }))
              }
            >
              {isExpanded ? "Show less" : "Show more"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
