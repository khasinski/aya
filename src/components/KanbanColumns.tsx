import { isFinishedColumn } from "../../shared/board-columns.cjs";
import "./kanban.css";
import { extractChecklistProgress, isLongCardDescription, KanbanCardMarkdown, livePaneDotInfo } from './KanbanCardContent';
import { columnDotClass, PRIORITY_OPTIONS, type KanbanViewModel } from './useKanbanBoard';
type KanbanColumnsProps = Pick<
  KanbanViewModel,
  "terminal"
  | "siblingTerminals"
  | "onFocusTerminal"
  | "onSplitRight"
  | "setFilterPriority"
  | "filterLabel"
  | "setFilterLabel"
  | "collapsedCols"
  | "toggleColumnCollapsed"
  | "movingColumn"
  | "columnsRef"
  | "renamingColId"
  | "setRenamingColId"
  | "renameColDraft"
  | "setRenameColDraft"
  | "addingCardColId"
  | "setAddingCardColId"
  | "newCardTitle"
  | "setNewCardTitle"
  | "newCardDesc"
  | "setNewCardDesc"
  | "newCardAssignee"
  | "setNewCardAssignee"
  | "editingCardId"
  | "setEditingCardId"
  | "editTitle"
  | "setEditTitle"
  | "editDesc"
  | "setEditDesc"
  | "editAssignee"
  | "setEditAssignee"
  | "expandedCards"
  | "setExpandedCards"
  | "confirmDeleteCardId"
  | "setConfirmDeleteCardId"
  | "shiftDeleteReady"
  | "setPreviewImage"
  | "cardMenu"
  | "draggingCardId"
  | "setDraggingCardId"
  | "dropTargetColId"
  | "setDropTargetColId"
  | "dropIndicator"
  | "setDropIndicator"
  | "addDescRef"
  | "editDescRef"
  | "runAction"
  | "openAddCard"
  | "handleTextareaPaste"
  | "handleTextareaDrop"
  | "handleMoveColumn"
  | "handleRenameColumn"
  | "handleDeleteColumn"
  | "handleClearColumn"
  | "handleArchiveCard"
  | "handleCreateCard"
  | "startEditCard"
  | "handleSaveCard"
  | "handleToggleCardTaskItem"
  | "handleMoveCard"
  | "handleDeleteCard"
  | "openCardPopover"
  | "handleAddFormKeyDown"
  | "handleEditFormKeyDown"
  | "siblingMap"
  | "hasActiveFilter"
  | "matchesCardFilter"
  | "renderDescriptionToolbar"
  | "renderPriorityAndLabelsRow"
> & { board: NonNullable<KanbanViewModel["board"]> };

export function KanbanColumns(props: KanbanColumnsProps) {
  const {
    terminal,
    siblingTerminals,
    onFocusTerminal,
    onSplitRight,
    board,
    setFilterPriority,
    filterLabel,
    setFilterLabel,
    collapsedCols,
    toggleColumnCollapsed,
    movingColumn,
    columnsRef,
    renamingColId,
    setRenamingColId,
    renameColDraft,
    setRenameColDraft,
    addingCardColId,
    setAddingCardColId,
    newCardTitle,
    setNewCardTitle,
    newCardDesc,
    setNewCardDesc,
    newCardAssignee,
    setNewCardAssignee,
    editingCardId,
    setEditingCardId,
    editTitle,
    setEditTitle,
    editDesc,
    setEditDesc,
    editAssignee,
    setEditAssignee,
    expandedCards,
    setExpandedCards,
    confirmDeleteCardId,
    setConfirmDeleteCardId,
    shiftDeleteReady,
    setPreviewImage,
    cardMenu,
    draggingCardId,
    setDraggingCardId,
    dropTargetColId,
    setDropTargetColId,
    dropIndicator,
    setDropIndicator,
    addDescRef,
    editDescRef,
    runAction,
    openAddCard,
    handleTextareaPaste,
    handleTextareaDrop,
    handleMoveColumn,
    handleRenameColumn,
    handleDeleteColumn,
    handleClearColumn,
    handleArchiveCard,
    handleCreateCard,
    startEditCard,
    handleSaveCard,
    handleToggleCardTaskItem,
    handleMoveCard,
    handleDeleteCard,
    openCardPopover,
    handleAddFormKeyDown,
    handleEditFormKeyDown,
    siblingMap,
    hasActiveFilter,
    matchesCardFilter,
    renderDescriptionToolbar,
    renderPriorityAndLabelsRow,
  } = props;
  return (<div className="aya-kanban-columns" ref={columnsRef}>
    {board.columns.map((col, colIndex) => {
      const allColCards = board.cards.filter(
        (c) => c.columnId === col.id,
      );
      const colCards = hasActiveFilter
        ? allColCards.filter((c) => matchesCardFilter(c, false))
        : allColCards;
      const isCollapsed = Boolean(collapsedCols[col.id]);
      const isDoneColumn = isFinishedColumn(col);
      const isDropTarget = dropTargetColId === col.id;
      const prevCol = colIndex > 0 ? board.columns[colIndex - 1] : null;
      const nextCol =
        colIndex < board.columns.length - 1
          ? board.columns[colIndex + 1]
          : null;

      if (isCollapsed) {
        return (
          <div
            key={col.id}
            data-testid={`kanban-column-${col.id}`}
            className={`aya-kanban-column aya-kanban-column--collapsed${isDropTarget ? " aya-kanban-column--drop-target" : ""
              }`}
            title={`Expand ${col.title} (${allColCards.length} cards)`}
            onClick={() => toggleColumnCollapsed(col.id)}
            onDragOver={(e) => {
              if (!draggingCardId) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (dropTargetColId !== col.id) setDropTargetColId(col.id);
            }}
            onDragLeave={(e) => {
              if (
                dropTargetColId === col.id &&
                !e.currentTarget.contains(e.relatedTarget as Node | null)
              ) {
                setDropTargetColId(null);
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDropTargetColId(null);
              setDropIndicator(null);
              const cardId =
                draggingCardId || e.dataTransfer.getData("text/plain");
              setDraggingCardId(null);
              if (cardId) {
                void handleMoveCard(cardId, col.id);
              }
            }}
          >
            <button
              type="button"
              className="aya-kanban-col-iconbtn"
              title={`Expand column ${col.title}`}
              aria-label={`Expand column ${col.title}`}
              onClick={(e) => {
                e.stopPropagation();
                toggleColumnCollapsed(col.id);
              }}
            >
              »
            </button>
            <span className={columnDotClass(col.id)} aria-hidden="true" />
            <span className="aya-kanban-column-count">
              {hasActiveFilter
                ? `${colCards.length}/${allColCards.length}`
                : allColCards.length}
            </span>
            <span className="aya-kanban-column-collapsed-title">
              {col.title}
            </span>
          </div>
        );
      }

      return (
        <div
          key={col.id}
          data-testid={`kanban-column-${col.id}`}
          className={`aya-kanban-column${isDropTarget ? " aya-kanban-column--drop-target" : ""
            }`}
          onDragOver={(e) => {
            if (!draggingCardId) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (dropTargetColId !== col.id) setDropTargetColId(col.id);
            if (!dropIndicator || dropIndicator.colId !== col.id) {
              setDropIndicator({
                colId: col.id,
                index: allColCards.length,
              });
            }
          }}
          onDragLeave={(e) => {
            if (
              dropTargetColId === col.id &&
              !e.currentTarget.contains(e.relatedTarget as Node | null)
            ) {
              setDropTargetColId(null);
              setDropIndicator(null);
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            const targetIdx =
              dropIndicator?.colId === col.id
                ? dropIndicator.index
                : undefined;
            setDropTargetColId(null);
            setDropIndicator(null);
            const cardId =
              draggingCardId || e.dataTransfer.getData("text/plain");
            setDraggingCardId(null);
            if (cardId) {
              void handleMoveCard(cardId, col.id, targetIdx);
            }
          }}
        >
          <div className="aya-kanban-column-header">
            <span className={columnDotClass(col.id)} aria-hidden="true" />
            {renamingColId === col.id ? (
              <input
                className="aya-kanban-input"
                value={renameColDraft}
                onChange={(e) => setRenameColDraft(e.target.value)}
                onBlur={() => void handleRenameColumn(col.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleRenameColumn(col.id);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setRenamingColId(null);
                  }
                }}
                autoFocus
              />
            ) : (
              <span
                className="aya-kanban-column-title"
                title="Double-click to rename column"
                onDoubleClick={() => {
                  setRenamingColId(col.id);
                  setRenameColDraft(col.title);
                }}
              >
                {col.title}
              </span>
            )}
            <span className="aya-kanban-column-count">
              {hasActiveFilter
                ? `${colCards.length}/${allColCards.length}`
                : allColCards.length}
            </span>
            {isDoneColumn && allColCards.length > 0 && (
              <button
                type="button"
                className="aya-kanban-col-clear-btn"
                title={`Archive all ${allColCards.length} completed card${allColCards.length === 1 ? "" : "s"
                  } (can Undo with ⌘Z)`}
                onClick={() => void handleClearColumn(col)}
              >
                Archive
              </button>
            )}
            <button
              type="button"
              className="aya-kanban-col-iconbtn"
              title={`Move column ${col.title} left`}
              aria-label={`Move column ${col.title} left`}
              disabled={movingColumn || !prevCol}
              onClick={() => { if (prevCol) void handleMoveColumn(col.id, prevCol.id, "before"); }}
            >
              ←
            </button>
            <button
              type="button"
              className="aya-kanban-col-iconbtn"
              title={`Move column ${col.title} right`}
              aria-label={`Move column ${col.title} right`}
              disabled={movingColumn || !nextCol}
              onClick={() => { if (nextCol) void handleMoveColumn(col.id, nextCol.id, "after"); }}
            >
              →
            </button>
            <button
              type="button"
              className="aya-kanban-col-iconbtn"
              title={`Add card to ${col.title}`}
              aria-label={`Add card to ${col.title}`}
              onClick={() => openAddCard(col.id)}
            >
              +
            </button>
            <button
              type="button"
              className="aya-kanban-col-iconbtn"
              title={`Collapse column ${col.title}`}
              aria-label={`Collapse column ${col.title}`}
              onClick={() => toggleColumnCollapsed(col.id)}
            >
              «
            </button>
            {board.columns.length > 1 && allColCards.length === 0 && (
              <button
                type="button"
                className="aya-kanban-col-iconbtn aya-kanban-col-iconbtn--danger"
                title={`Remove empty column ${col.title}`}
                aria-label={`Remove column ${col.title}`}
                onClick={() => void handleDeleteColumn(col)}
              >
                ×
              </button>
            )}
          </div>

          <div className="aya-kanban-cards">
            {addingCardColId === col.id && (
              <div
                className="aya-kanban-form"
                onKeyDown={(e) => handleAddFormKeyDown(col.id, e)}
              >
                <input
                  className="aya-kanban-input"
                  placeholder="Card title…"
                  aria-label="Card title"
                  value={newCardTitle}
                  onChange={(e) => setNewCardTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void handleCreateCard(col.id);
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
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void handleCreateCard(col.id);
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
                    onClick={() => void handleCreateCard(col.id)}
                  >
                    Add card
                  </button>
                </div>
              </div>
            )}

            {colCards.length === 0 && addingCardColId !== col.id && (
              <div className="aya-kanban-empty-col">
                {hasActiveFilter ? "No matching cards" : "No cards"}
              </div>
            )}

            {colCards.map((card, cardIdx) => {
              const isEditing = editingCardId === card.id;
              const isDragging = draggingCardId === card.id;
              if (isEditing) {
                return (
                  <div
                    key={card.id}
                    className="aya-kanban-form"
                    onKeyDown={(e) => handleEditFormKeyDown(card.id, e)}
                  >
                    <input
                      className="aya-kanban-input"
                      value={editTitle}
                      aria-label="Edit card title"
                      onChange={(e) => setEditTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          void handleSaveCard(card.id);
                        }
                      }}
                      autoFocus
                    />
                    {renderDescriptionToolbar("edit")}
                    <textarea
                      ref={editDescRef}
                      className="aya-kanban-textarea"
                      value={editDesc}
                      placeholder="Description / Markdown, links, checklists, or paste image (⌘V)…"
                      aria-label="Edit card description"
                      onChange={(e) => setEditDesc(e.target.value)}
                      onPaste={(e) => handleTextareaPaste("edit", e)}
                      onDrop={(e) => handleTextareaDrop("edit", e)}
                    />
                    {renderPriorityAndLabelsRow("edit")}
                    <input
                      className="aya-kanban-input"
                      placeholder="Assignee (optional)…"
                      aria-label="Edit card assignee"
                      list={`kanban-assignees-${terminal.id}`}
                      value={editAssignee}
                      onChange={(e) => setEditAssignee(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          void handleSaveCard(card.id);
                        }
                      }}
                    />
                    <div className="aya-kanban-form-actions">
                      <button
                        type="button"
                        className="aya-kanban-btn"
                        onClick={() => setEditingCardId(null)}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="aya-kanban-btn aya-kanban-btn--primary"
                        disabled={!editTitle.trim()}
                        onClick={() => void handleSaveCard(card.id)}
                      >
                        Save
                      </button>
                    </div>
                  </div>
                );
              }

              const isMenuOpen = cardMenu?.cardId === card.id;
              const isExpanded = Boolean(expandedCards[card.id]);
              const isLongDesc = isLongCardDescription(card.description);
              const checklist = extractChecklistProgress(
                card.description,
              );
              const priorityMeta = card.priority
                ? PRIORITY_OPTIONS.find((p) => p.value === card.priority)
                : null;
              const claimedPane = card.claim?.paneId
                ? siblingMap.get(card.claim.paneId)
                : siblingTerminals?.find(
                  (t) =>
                    t.name.toLowerCase() ===
                    card.claim?.paneName.toLowerCase(),
                );
              const dotInfo = card.claim
                ? livePaneDotInfo(claimedPane)
                : null;
              const showDropBefore =
                dropIndicator?.colId === col.id &&
                dropIndicator.index === cardIdx &&
                draggingCardId !== card.id;
              const showDropAfter =
                dropIndicator?.colId === col.id &&
                cardIdx === colCards.length - 1 &&
                dropIndicator.index === colCards.length &&
                draggingCardId !== card.id;

              return (
                <div key={card.id} className="aya-kanban-card-slot">
                  {showDropBefore && (
                    <div className="aya-kanban-drop-line" />
                  )}
                  <div
                    data-testid={`kanban-card-${card.id}`}
                    className={`aya-kanban-card${card.claim ? " aya-kanban-card--claimed" : ""
                      }${card.priority
                        ? ` aya-kanban-card--priority-${card.priority}`
                        : ""
                      }${isDragging ? " aya-kanban-card--dragging" : ""}`}
                    draggable
                    onDoubleClick={() => startEditCard(card)}
                    onMouseLeave={() => {
                      if (confirmDeleteCardId === card.id) {
                        setConfirmDeleteCardId(null);
                      }
                    }}
                    onDragStart={(e) => {
                      setDraggingCardId(card.id);
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", card.id);
                    }}
                    onDragOver={(e) => {
                      if (!draggingCardId) return;
                      e.preventDefault();
                      e.stopPropagation();
                      const rect =
                        e.currentTarget.getBoundingClientRect();
                      const after =
                        e.clientY > rect.top + rect.height / 2;
                      const nextIndex = after ? cardIdx + 1 : cardIdx;
                      if (dropTargetColId !== col.id) {
                        setDropTargetColId(col.id);
                      }
                      if (
                        dropIndicator?.colId !== col.id ||
                        dropIndicator.index !== nextIndex
                      ) {
                        setDropIndicator({
                          colId: col.id,
                          index: nextIndex,
                        });
                      }
                    }}
                    onDragEnd={() => {
                      setDraggingCardId(null);
                      setDropTargetColId(null);
                      setDropIndicator(null);
                    }}
                  >
                    <div className="aya-kanban-card-meta">
                      <div className="aya-kanban-card-meta-left">
                        <span className="aya-kanban-card-id">
                          {card.id}
                        </span>
                        {priorityMeta && (
                          <button
                            type="button"
                            className={`aya-kanban-priority-badge aya-kanban-priority-badge--${priorityMeta.value}`}
                            title={`Priority: ${priorityMeta.label} (click to filter)`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setFilterPriority((prev) =>
                                prev === priorityMeta.value
                                  ? null
                                  : priorityMeta.value,
                              );
                            }}
                          >
                            {priorityMeta.short}
                          </button>
                        )}
                        {checklist && (
                          <span
                            className={`aya-kanban-checklist-pill${checklist.completed === checklist.total
                              ? " aya-kanban-checklist-pill--done"
                              : ""
                              }`}
                            title={`Checklist: ${checklist.completed} of ${checklist.total} completed`}
                          >
                            <span>
                              ☑ {checklist.completed}/{checklist.total}
                            </span>
                            <span
                              className="aya-kanban-checklist-bar"
                              aria-hidden="true"
                            >
                              <span
                                className="aya-kanban-checklist-bar-fill"
                                style={{
                                  width: `${Math.round(
                                    (checklist.completed /
                                      checklist.total) *
                                    100,
                                  )}%`,
                                }}
                              />
                            </span>
                          </span>
                        )}
                      </div>
                      <div className="aya-kanban-card-quick">
                        {prevCol && (
                          <button
                            type="button"
                            className="aya-kanban-iconbtn"
                            title={`Move to ${prevCol.title}`}
                            aria-label={`Move card ${card.id} to ${prevCol.title}`}
                            onClick={() =>
                              void handleMoveCard(card.id, prevCol.id)
                            }
                          >
                            ←
                          </button>
                        )}
                        {nextCol && (
                          <button
                            type="button"
                            className="aya-kanban-iconbtn"
                            title={`Move to ${nextCol.title}`}
                            aria-label={`Move card ${card.id} to ${nextCol.title}`}
                            onClick={() =>
                              void handleMoveCard(card.id, nextCol.id)
                            }
                          >
                            →
                          </button>
                        )}
                        {isDoneColumn && (
                          <button
                            type="button"
                            className="aya-kanban-iconbtn"
                            title="Archive card"
                            aria-label={`Archive card ${card.id}`}
                            onClick={() => void handleArchiveCard(card.id)}
                          >
                            ⇣
                          </button>
                        )}
                        <button
                          type="button"
                          className="aya-kanban-iconbtn"
                          title="Edit card"
                          aria-label={`Edit card ${card.id}`}
                          onClick={() => startEditCard(card)}
                        >
                          ✎
                        </button>
                        {confirmDeleteCardId === card.id ? (
                          <button
                            type="button"
                            className="aya-kanban-delete-confirm"
                            title="Confirm deleting card"
                            aria-label={`Confirm delete card ${card.id}`}
                            onClick={() => void handleDeleteCard(card.id)}
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
                                ? "Instant delete card (Shift held)"
                                : "Delete card (hold Shift to skip confirmation)"
                            }
                            aria-label={`Delete card ${card.id}`}
                            onClick={(e) => {
                              if (e.shiftKey || shiftDeleteReady) {
                                void handleDeleteCard(card.id);
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

                    <div className="aya-kanban-card-title">
                      {card.title}
                    </div>
                    {card.claim?.startup && card.claim.startup !== "sent" && (
                      <span className="aya-kanban-pill" title="Check the assigned pane before retrying an unconfirmed task delivery">
                        {card.claim.startup === "reserved" ? "Waiting to start" : "Task delivery unconfirmed"}
                      </span>
                    )}

                    {card.labels && card.labels.length > 0 && (
                      <div className="aya-kanban-card-labels">
                        {card.labels.map((lbl) => (
                          <button
                            key={lbl}
                            type="button"
                            className={`aya-kanban-label-pill${filterLabel?.toLowerCase() ===
                              lbl.toLowerCase()
                              ? " aya-kanban-label-pill--active"
                              : ""
                              }`}
                            title={`Filter by #${lbl}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setFilterLabel((prev) =>
                                prev?.toLowerCase() === lbl.toLowerCase()
                                  ? null
                                  : lbl,
                              );
                            }}
                          >
                            #{lbl}
                          </button>
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
                            onToggleTask={(idx) =>
                              void handleToggleCardTaskItem(card, idx)
                            }
                            onPreviewImage={setPreviewImage}
                          />
                        </div>
                        {isLongDesc && (
                          <button
                            type="button"
                            className="aya-kanban-desc-toggle"
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedCards((prev) => ({
                                ...prev,
                                [card.id]: !prev[card.id],
                              }));
                            }}
                          >
                            {isExpanded ? "Show less" : "Show more"}
                          </button>
                        )}
                      </div>
                    )}

                    <div className="aya-kanban-card-footer">
                      <div className="aya-kanban-card-badges">
                        {card.claim ? (
                          <span
                            className={`aya-kanban-pill aya-kanban-pill--claimed${dotInfo?.modifier === "closed"
                              ? " aya-kanban-pill--closed"
                              : ""
                              }`}
                            title={
                              claimedPane
                                ? `${card.claim.paneName} (${dotInfo?.label}) — click to focus terminal`
                                : `${card.claim.paneName} (terminal closed)`
                            }
                          >
                            <button
                              type="button"
                              className="aya-kanban-pill-focus"
                              disabled={!claimedPane || !onFocusTerminal}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (claimedPane && onFocusTerminal) {
                                  onFocusTerminal(claimedPane.id);
                                }
                              }}
                            >
                              <span
                                className={`aya-kanban-pill-dot aya-kanban-pill-dot--${dotInfo?.modifier ?? "working"
                                  }`}
                                aria-hidden="true"
                              />
                              <span>
                                {claimedPane?.name ?? card.claim.paneName}
                              </span>
                            </button>
                            {claimedPane && onSplitRight && (
                              <button
                                type="button"
                                className="aya-kanban-pill-split"
                                title={`Split ${claimedPane.name} beside Kanban`}
                                aria-label={`Split ${claimedPane.name}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onSplitRight(claimedPane.id);
                                }}
                              >
                                ⊞
                              </button>
                            )}
                            <button
                              type="button"
                              className="aya-kanban-pill-release"
                              title={`Release claim from ${card.claim.paneName}`}
                              aria-label={`Release card ${card.id}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                void runAction(() =>
                                  window.aya.releaseBoardCard({
                                    projectSlug: terminal.projectSlug,
                                    cardId: card.id,
                                  }),
                                );
                              }}
                            >
                              ×
                            </button>
                          </span>
                        ) : card.assignee ? (
                          <button
                            type="button"
                            className="aya-kanban-pill aya-kanban-pill--assignee"
                            title="Change terminal or assignee"
                            onClick={(e) => openCardPopover(e, card.id)}
                          >
                            @{card.assignee}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="aya-kanban-pill--unassigned"
                            title="Assign or send to terminal"
                            onClick={(e) => openCardPopover(e, card.id)}
                          >
                            Unassigned
                          </button>
                        )}
                      </div>

                      <div
                        className="aya-kanban-menu-wrap"
                        onMouseDown={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          className="aya-kanban-run-btn"
                          aria-haspopup="menu"
                          aria-expanded={isMenuOpen}
                          title="Assign, send prompt, or start in terminal"
                          onClick={(e) => openCardPopover(e, card.id)}
                        >
                          <span>▸ Terminal</span>
                        </button>
                      </div>
                    </div>
                  </div>
                  {showDropAfter && (
                    <div className="aya-kanban-drop-line" />
                  )}
                </div>
              );
            })}

            {addingCardColId !== col.id && (
              <button
                type="button"
                className="aya-kanban-col-add-btn"
                onClick={() => openAddCard(col.id)}
              >
                <span>+ Add card</span>
              </button>
            )}
          </div>
        </div>
      );
    })}
  </div>);
}
