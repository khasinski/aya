import "./kanban.css";
import type { KanbanViewModel } from "./useKanbanBoard";

type KanbanAddCardFormProps = Pick<
  KanbanViewModel,
  | "terminal"
  | "setAddingCardColId"
  | "newCardTitle"
  | "setNewCardTitle"
  | "newCardDesc"
  | "setNewCardDesc"
  | "newCardAssignee"
  | "setNewCardAssignee"
  | "addDescRef"
  | "handleCreateCard"
  | "handleAddFormKeyDown"
  | "handleTextareaPaste"
  | "handleTextareaDrop"
  | "renderDescriptionToolbar"
  | "renderPriorityAndLabelsRow"
> & { columnId: string };

// The new-card form, shared by a board column and the shelf's Backlog tab.
// Plain Enter in the title or assignee adds the card; Cmd/Ctrl+Enter is the form's own
// shortcut (handleAddFormKeyDown), so the inputs leave it to the form and add only once.
export function KanbanAddCardForm({
  columnId,
  terminal,
  setAddingCardColId,
  newCardTitle,
  setNewCardTitle,
  newCardDesc,
  setNewCardDesc,
  newCardAssignee,
  setNewCardAssignee,
  addDescRef,
  handleCreateCard,
  handleAddFormKeyDown,
  handleTextareaPaste,
  handleTextareaDrop,
  renderDescriptionToolbar,
  renderPriorityAndLabelsRow,
}: KanbanAddCardFormProps) {
  return (
    <div
      className="aya-kanban-form"
      onKeyDown={(e) => handleAddFormKeyDown(columnId, e)}
    >
      <input
        className="aya-kanban-input"
        placeholder="Card title…"
        aria-label="Card title"
        value={newCardTitle}
        onChange={(e) => setNewCardTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            void handleCreateCard(columnId);
          }
        }}
        autoFocus
      />
      {renderDescriptionToolbar("add")}
      <textarea
        ref={addDescRef}
        className="aya-kanban-textarea"
        placeholder="Description / Markdown, links, checklists, or paste image (⌘V)…"
        aria-label="Card description"
        value={newCardDesc}
        onChange={(e) => setNewCardDesc(e.target.value)}
        onPaste={(e) => handleTextareaPaste("add", e)}
        onDrop={(e) => handleTextareaDrop("add", e)}
      />
      {renderPriorityAndLabelsRow("add")}
      <input
        className="aya-kanban-input"
        placeholder="Assignee (optional)…"
        aria-label="Card assignee"
        list={`kanban-assignees-${terminal.id}`}
        value={newCardAssignee}
        onChange={(e) => setNewCardAssignee(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            void handleCreateCard(columnId);
          }
        }}
      />
      <div className="aya-kanban-form-actions">
        <button
          type="button"
          className="aya-kanban-btn"
          onClick={() => setAddingCardColId(null)}
        >
          Cancel
        </button>
        <button
          type="button"
          className="aya-kanban-btn aya-kanban-btn--primary"
          disabled={!newCardTitle.trim()}
          onClick={() => void handleCreateCard(columnId)}
        >
          Add card
        </button>
      </div>
    </div>
  );
}
