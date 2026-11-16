import { BOARD_IMAGE_ACCEPT } from "../../shared/board-images.cjs";
import {
  memo,
  useState,
} from "react";
import { createPortal } from "react-dom";
import "./kanban.css";
import { KanbanCardMarkdown, livePaneDotInfo } from './KanbanCardContent';
import { KanbanColumns } from './KanbanColumns';
import { matchesSearchQuery } from "./kanban-search";
import { PRIORITY_OPTIONS, useKanbanBoard, type Props } from './useKanbanBoard';
export const KanbanView = memo(function KanbanView(props: Props) {
  const model = useKanbanBoard(props);
  // The drawer is a shelf: an Archive tab, a Backlog tab when it is on, and a search of its own.
  const [shelfQuery, setShelfQuery] = useState("");
  const [shelfTab, setShelfTab] = useState<"archive" | "backlog">("archive");
  const {
    terminal,
    hidden,
    paneStyle,
    isActivePane,
    onActivatePane,
    headerSlot,
    projectDir,
    onStartCardInNewPane,
    onCreateWorktrees,
    onFocusTerminal,
    onSplitRight,
    board,
    error,
    setError,
    notice,
    setNotice,
    undoState,
    setUndoState,
    filterAssignee,
    setFilterAssignee,
    filterPriority,
    setFilterPriority,
    filterLabel,
    setFilterLabel,
    expandedCards,
    setExpandedCards,
    confirmDeleteCardId,
    setConfirmDeleteCardId,
    shiftDeleteReady,
    archiveOpen,
    setArchiveOpen,
    confirmEmptyArchive,
    setConfirmEmptyArchive,
    previewImage,
    setPreviewImage,
    cardMenu,
    setCardMenu,
    cardMenuRef,
    fileInputRef,
    fileInputTargetRef,
    runAction,
    handleUndoDelete,
    saveAndInsertImageFile,
    handleArchiveCard,
    handleRestoreArchivedCard,
    handleMoveToBacklog,
    handleRestoreBacklogCard,
    handleDeleteArchivedCard,
    handleEmptyArchive,
    startEditCard,
    handleQuickSetPriority,
    handleDeleteCard,
    handleStartCardInWorktree,
    siblings,
    siblingMap,
    launchablePresets,
    archivedCards,
    backlogCards,
    showBacklog,
    backlogEnabled,
    boardFilterOptions,
    hasActiveFilter,
    clearAllFilters,
    filteredArchivedCards,
    filteredBacklogCards,
    headerNode,
    activeMenuCard,
    showFilterStrip
  } = model;
  // The shelf search uses the board filter's query language and narrows on top of it.
  const shelfSearching = shelfQuery.trim() !== "";
  const archiveMatches = shelfSearching
    ? filteredArchivedCards.filter((card) => matchesSearchQuery(card, shelfQuery, true))
    : filteredArchivedCards;
  const backlogMatches = shelfSearching
    ? filteredBacklogCards.filter((card) => matchesSearchQuery(card, shelfQuery, false))
    : filteredBacklogCards;
  const onBacklogTab = showBacklog && shelfTab === "backlog";
  const drawerCards = onBacklogTab ? backlogMatches : archiveMatches;
  const shelfName = onBacklogTab ? "backlog" : "archive";
  const tabCount = (matches: readonly unknown[], total: readonly unknown[]) =>
    hasActiveFilter || shelfSearching ? `${matches.length}/${total.length}` : total.length;
  return (
    <section
      data-testid="kanban-pane"
      data-terminal-id={terminal.id}
      className={`aya-pane aya-kanban-pane${isActivePane ? " aya-pane--active-split" : ""
        }`}
      style={{ ...paneStyle, ...(hidden ? { display: "none" } : {}) }}
      onMouseDown={() => onActivatePane?.()}
    >
      {headerSlot && !hidden ? createPortal(headerNode, headerSlot) : headerNode}
      <input
        ref={fileInputRef}
        type="file"
        accept={BOARD_IMAGE_ACCEPT}
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) {
            void saveAndInsertImageFile(fileInputTargetRef.current, file);
          }
        }}
      />
      <datalist id={`kanban-assignees-${terminal.id}`}>
        {siblings.map((s) => (
          <option key={s.id} value={s.name} />
        ))}
      </datalist>
      {showFilterStrip && (
        <div className="aya-kanban-filterbar">
          {boardFilterOptions.priorities.map((p) => (
            <button
              key={`fp:${p.value}`}
              type="button"
              className={`aya-kanban-filter-chip aya-kanban-priority-badge--${p.value}${filterPriority === p.value
                ? " aya-kanban-filter-chip--active"
                : ""
                }`}
              onClick={() =>
                setFilterPriority((prev) =>
                  prev === p.value ? null : p.value,
                )
              }
            >
              {p.short} {p.label}
            </button>
          ))}
          {boardFilterOptions.labels.map((lbl) => (
            <button
              key={`fl:${lbl}`}
              type="button"
              className={`aya-kanban-filter-chip${filterLabel?.toLowerCase() === lbl.toLowerCase()
                ? " aya-kanban-filter-chip--active"
                : ""
                }`}
              onClick={() =>
                setFilterLabel((prev) =>
                  prev?.toLowerCase() === lbl.toLowerCase() ? null : lbl,
                )
              }
            >
              #{lbl}
            </button>
          ))}
          {boardFilterOptions.assignees.map((owner) => (
            <button
              key={`fa:${owner}`}
              type="button"
              className={`aya-kanban-filter-chip${filterAssignee?.toLowerCase() === owner.toLowerCase()
                ? " aya-kanban-filter-chip--active"
                : ""
                }`}
              onClick={() =>
                setFilterAssignee((prev) =>
                  prev?.toLowerCase() === owner.toLowerCase() ? null : owner,
                )
              }
            >
              @{owner}
            </button>
          ))}
          {hasActiveFilter && filteredArchivedCards.length > 0 && (
            <button
              type="button"
              data-testid="kanban-filter-archive-hits"
              className={`aya-kanban-filter-chip aya-kanban-filter-chip--archive${archiveOpen ? " aya-kanban-filter-chip--active" : ""
                }`}
              title={
                archiveOpen
                  ? "Hide archive drawer"
                  : "Show matching cards in Archive drawer"
              }
              onClick={() => {
                setArchiveOpen((prev) => !prev);
                setConfirmEmptyArchive(false);
              }}
            >
              📦 {filteredArchivedCards.length} in Archive ·{" "}
              {archiveOpen ? "Hide" : "Show"}
            </button>
          )}
          {hasActiveFilter && (
            <button
              type="button"
              className="aya-kanban-filter-reset"
              onClick={clearAllFilters}
            >
              Reset filters
            </button>
          )}
          <span className="aya-kanban-shortcuts-hint">
            <kbd>n</kbd> new card · <kbd>/</kbd> filter
          </span>
        </div>
      )}
      {error && (
        <div className="aya-kanban-error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="aya-kanban-btn"
            onClick={() => setError(null)}
          >
            Dismiss
          </button>
        </div>
      )}
      {!!board?.notices?.length && (
        <div className="aya-kanban-notices" role="status">
          {board.notices.map((n) => (
            <div key={n.id}>
              Task {n.cardId}:{" "}
              {n.state !== "pending"
                ? `withdrawal delivery started in ${n.paneName}; check that panel. Automatic retries are paused to avoid sending it twice.`
                : `withdrawal message is waiting for ${n.paneName}. Aya will retry when the panel can receive it.`}
              {n.state !== "pending" && (
                <button
                  type="button"
                  className="aya-kanban-btn"
                  onClick={() =>
                    void runAction(() =>
                      window.aya.acknowledgeBoardNotice({
                        projectSlug: terminal.projectSlug,
                        noticeId: n.id,
                      }),
                    )
                  }
                >
                  Clear checked notice
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {notice && (
        <div className="aya-kanban-notice" role="status">
          <span>{notice.text}</span>
          <div className="aya-kanban-notice-actions">
            {notice.terminalId && onFocusTerminal && (
              <button
                type="button"
                className="aya-kanban-btn aya-kanban-btn--primary"
                onClick={() => {
                  const targetId = notice.terminalId!;
                  setNotice(null);
                  onFocusTerminal(targetId);
                }}
              >
                Focus {notice.terminalName ?? "terminal"}
              </button>
            )}
            {notice.terminalId && onSplitRight && (
              <button
                type="button"
                className="aya-kanban-btn"
                onClick={() => {
                  const targetId = notice.terminalId!;
                  setNotice(null);
                  onSplitRight(targetId);
                }}
              >
                ⊞ Split beside board
              </button>
            )}
            <button
              type="button"
              className="aya-kanban-btn"
              onClick={() => setNotice(null)}
            >
              ×
            </button>
          </div>
        </div>
      )}
      {undoState && (
        <div className="aya-kanban-undo-bar" role="status">
          <span>{undoState.label}</span>
          <div className="aya-kanban-notice-actions">
            <button
              type="button"
              className="aya-kanban-btn aya-kanban-btn--primary"
              onClick={() => void handleUndoDelete()}
            >
              Undo (⌘Z)
            </button>
            <button
              type="button"
              className="aya-kanban-btn"
              onClick={() => setUndoState(null)}
            >
              ×
            </button>
          </div>
        </div>
      )}
      {!board ? (
        <div
          style={{
            padding: 16,
            fontSize: 12.5,
            color: "var(--aya-pane-subtle)",
          }}
        >
          Loading board…
        </div>
      ) : (
        <div className="aya-kanban-body">
          <KanbanColumns {...model} board={board} />

          {archiveOpen && (
            <aside
              data-testid="kanban-archive-drawer"
              className="aya-kanban-archive-drawer"
            >
              <div className="aya-kanban-archive-header">
                <span className="aya-kanban-archive-title">
                  Shelf
                </span>
                <div className="aya-kanban-archive-actions">
                  {!onBacklogTab && archivedCards.length > 0 &&
                    (confirmEmptyArchive ? (
                      <button
                        type="button"
                        className="aya-kanban-delete-confirm"
                        title="Permanently delete all archived cards"
                        onClick={() => void handleEmptyArchive()}
                      >
                        Empty all?
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="aya-kanban-col-clear-btn"
                        title={
                          shiftDeleteReady
                            ? "Permanently empty archive immediately (Shift held)"
                            : "Permanently delete all archived cards (hold Shift to skip confirmation)"
                        }
                        onClick={(e) => {
                          if (e.shiftKey || shiftDeleteReady) {
                            void handleEmptyArchive();
                          } else {
                            setConfirmEmptyArchive(true);
                          }
                        }}
                      >
                        Empty
                      </button>
                    ))}
                  <button
                    type="button"
                    className="aya-kanban-col-iconbtn"
                    title="Close archive"
                    aria-label="Close archive"
                    onClick={() => {
                      setArchiveOpen(false);
                      setConfirmEmptyArchive(false);
                    }}
                  >
                    ×
                  </button>
                </div>
              </div>

              <div className="aya-kanban-shelf-bar">
                <div role="tablist" aria-label="Shelf" className="aya-kanban-shelf-tabs">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={!onBacklogTab}
                    className={`aya-kanban-shelf-tab${onBacklogTab ? "" : " aya-kanban-shelf-tab--active"}`}
                    onClick={() => setShelfTab("archive")}
                  >
                    Archive
                    <span className="aya-kanban-column-count">{tabCount(archiveMatches, archivedCards)}</span>
                  </button>
                  {showBacklog && (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={onBacklogTab}
                      className={`aya-kanban-shelf-tab${onBacklogTab ? " aya-kanban-shelf-tab--active" : ""}`}
                      onClick={() => { setShelfTab("backlog"); setConfirmEmptyArchive(false); }}
                    >
                      Backlog
                      <span className="aya-kanban-column-count">{tabCount(backlogMatches, backlogCards)}</span>
                    </button>
                  )}
                </div>
                <input
                  type="search"
                  className="aya-kanban-shelf-search"
                  aria-label={`Search the ${shelfName}`}
                  placeholder={`Search the ${shelfName} (#label, @owner, p1)`}
                  value={shelfQuery}
                  onChange={(e) => setShelfQuery(e.target.value)}
                />
              </div>
              <div className="aya-kanban-archive-list">
                {drawerCards.length === 0 ? (
                  <div className="aya-kanban-empty-col">
                    {onBacklogTab
                      ? hasActiveFilter || shelfSearching
                        ? "No matching backlog cards"
                        : "Backlog is empty. Use Move to backlog in a card's menu to keep a card off the board."
                      : hasActiveFilter || shelfSearching
                        ? "No matching archived cards"
                        : "Archive is empty. Use Archive on the Done column to move completed cards here."}
                  </div>
                ) : (
                  drawerCards.map((card) => {
                    const priorityMeta = card.priority
                      ? PRIORITY_OPTIONS.find((p) => p.value === card.priority)
                      : null;
                    const origCol = board.columns.find(
                      (c) => c.id === card.columnId,
                    );
                    const isExpanded = Boolean(expandedCards[card.id]);
                    const isLongDesc =
                      Boolean(card.description) &&
                      (card.description!.length > 180 ||
                        card.description!.split(/\r?\n/).length > 4);
                    const shelvedAt = onBacklogTab ? card.updatedAt : card.archivedAt;
                    const archivedDate = shelvedAt
                      ? new Date(shelvedAt).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })
                      : null;

                    return (
                      <div
                        key={card.id}
                        data-testid={onBacklogTab ? `kanban-backlog-card-${card.id}` : `kanban-archived-card-${card.id}`}
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
                              {origCol ? origCol.title : card.columnId}
                              {archivedDate ? ` · ${archivedDate}` : ""}
                            </span>
                          </div>
                          <div className="aya-kanban-card-quick aya-kanban-card-quick--visible">
                            <button
                              type="button"
                              className="aya-kanban-archive-restore-btn"
                              title={`Restore ${card.id} to ${origCol ? origCol.title : "board"
                                }`}
                              onClick={() => void (onBacklogTab ? handleRestoreBacklogCard(card.id) : handleRestoreArchivedCard(card))}
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
                                    : `Permanently delete from ${shelfName} (hold Shift to skip confirmation)`
                                }
                                aria-label={onBacklogTab ? `Delete backlog card ${card.id}` : `Delete archived card ${card.id}`}
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
                  })
                )}
              </div>
            </aside>
          )}
        </div>
      )}

      {cardMenu && activeMenuCard && board && createPortal(
        <div
          ref={cardMenuRef}
          className="aya-kanban-popover"
          role="menu"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {siblings.length > 0 && (
            <>
              <div className="aya-kanban-popover-section">
                Send prompt to terminal
              </div>
              {siblings.map((s) => {
                const live = siblingMap.get(s.id);
                const statusInfo = livePaneDotInfo(live);
                return (
                  <div key={`send:${s.id}`} className="aya-kanban-popover-row">
                    <button
                      type="button"
                      role="menuitem"
                      className="aya-kanban-popover-item"
                      title={`Send task prompt to ${s.name} and claim card (${statusInfo.label})`}
                      onClick={() => {
                        const cardId = activeMenuCard.id;
                        setCardMenu(null);
                        void runAction(async () => {
                          const updated = await window.aya.sendBoardCardToPane({
                            projectSlug: terminal.projectSlug,
                            cardId,
                            targetId: s.id,
                          });
                          setNotice({
                            text: `Sent ${cardId} to ${s.name}`,
                            terminalId: s.id,
                            terminalName: s.name,
                          });
                          return updated;
                        });
                      }}
                    >
                      <span className="aya-kanban-popover-icon">↪</span>
                      <span
                        className={`aya-kanban-pill-dot aya-kanban-pill-dot--${statusInfo.modifier}`}
                        title={statusInfo.label}
                        aria-hidden="true"
                      />
                      <span className="aya-kanban-popover-label">{s.name}</span>
                    </button>
                    {onSplitRight && (
                      <button
                        type="button"
                        className="aya-kanban-popover-aux"
                        title={`Send to ${s.name} and open beside Kanban`}
                        aria-label={`Send to ${s.name} in split`}
                        onClick={() => {
                          const cardId = activeMenuCard.id;
                          setCardMenu(null);
                          void runAction(async () => {
                            const updated =
                              await window.aya.sendBoardCardToPane({
                                projectSlug: terminal.projectSlug,
                                cardId,
                                targetId: s.id,
                              });
                            onSplitRight(s.id);
                            return updated;
                          });
                        }}
                      >
                        ⊞
                      </button>
                    )}
                  </div>
                );
              })}
              <div className="aya-kanban-popover-divider" />
              <div className="aya-kanban-popover-section">
                Claim for terminal
              </div>
              {siblings.map((s) => (
                <button
                  key={`claim:${s.id}`}
                  type="button"
                  role="menuitem"
                  className="aya-kanban-popover-item"
                  onClick={() => {
                    setCardMenu(null);
                    void runAction(() =>
                      window.aya.claimBoardCard({
                        projectSlug: terminal.projectSlug,
                        cardId: activeMenuCard.id,
                        paneId: s.id,
                        paneName: s.name,
                        replace: true,
                      }),
                    );
                  }}
                >
                  <span className="aya-kanban-popover-icon">●</span>
                  <span className="aya-kanban-popover-label">{s.name}</span>
                </button>
              ))}
            </>
          )}

          {onStartCardInNewPane && launchablePresets.length > 0 && (
            <>
              {siblings.length > 0 && (
                <div className="aya-kanban-popover-divider" />
              )}
              <div className="aya-kanban-popover-section">
                Start in new terminal
              </div>
              {launchablePresets.map((p) => (
                <div key={`new:${p.id}`} className="aya-kanban-popover-row">
                  <button
                    type="button"
                    role="menuitem"
                    className="aya-kanban-popover-item"
                    onClick={() => {
                      const cardToStart = activeMenuCard;
                      setCardMenu(null);
                      void runAction(() =>
                        onStartCardInNewPane(
                          p,
                          cardToStart.id,
                          terminal.projectSlug,
                        ),
                      );
                    }}
                  >
                    <span
                      className="aya-kanban-popover-icon"
                      style={p.color ? { color: p.color } : undefined}
                    >
                      {p.icon}
                    </span>
                    <span className="aya-kanban-popover-label">{p.name}</span>
                  </button>
                  {projectDir && onCreateWorktrees && (
                    <button
                      type="button"
                      className="aya-kanban-popover-aux"
                      title={`Start ${p.name} in a new git worktree (${activeMenuCard.id})`}
                      aria-label={`Start ${p.name} in new worktree`}
                      onClick={() =>
                        void handleStartCardInWorktree(activeMenuCard, p, false)
                      }
                    >
                      ⑂
                    </button>
                  )}
                  {onSplitRight && (
                    <button
                      type="button"
                      className="aya-kanban-popover-aux"
                      title={`Start ${p.name} in split beside Kanban`}
                      aria-label={`Start ${p.name} in split`}
                      onClick={() => {
                        const cardToStart = activeMenuCard;
                        setCardMenu(null);
                        void runAction(async () => {
                          const nextBoard = await onStartCardInNewPane(
                            p,
                            cardToStart.id,
                            terminal.projectSlug,
                          );
                          const started = nextBoard.cards.find(
                            (c) => c.id === cardToStart.id,
                          );
                          if (started?.claim?.paneId) {
                            onSplitRight(started.claim.paneId);
                          }
                          return nextBoard;
                        });
                      }}
                    >
                      ⊞
                    </button>
                  )}
                </div>
              ))}
            </>
          )}

          <div className="aya-kanban-popover-divider" />
          <div className="aya-kanban-popover-section">Priority</div>
          <div className="aya-kanban-popover-priorities">
            {PRIORITY_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`aya-kanban-priority-chip aya-kanban-priority-badge--${opt.value
                  }${activeMenuCard.priority === opt.value
                    ? " aya-kanban-priority-chip--active"
                    : ""
                  }`}
                title={`Set priority to ${opt.label}`}
                onClick={() =>
                  void handleQuickSetPriority(
                    activeMenuCard.id,
                    activeMenuCard.priority === opt.value ? null : opt.value,
                  )
                }
              >
                {opt.short}
              </button>
            ))}
            {activeMenuCard.priority && (
              <button
                type="button"
                className="aya-kanban-priority-chip"
                title="Clear priority"
                onClick={() =>
                  void handleQuickSetPriority(activeMenuCard.id, null)
                }
              >
                None
              </button>
            )}
          </div>

          <div className="aya-kanban-popover-divider" />
          <button
            type="button"
            role="menuitem"
            className="aya-kanban-popover-item"
            onClick={() => startEditCard(activeMenuCard)}
          >
            <span className="aya-kanban-popover-icon">✎</span>
            <span>Edit card</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="aya-kanban-popover-item"
            onClick={() => void handleArchiveCard(activeMenuCard.id)}
          >
            <span className="aya-kanban-popover-icon">⇣</span>
            <span>Archive card</span>
          </button>
          {backlogEnabled && (
            <button
              type="button"
              role="menuitem"
              className="aya-kanban-popover-item"
              onClick={() => void handleMoveToBacklog(activeMenuCard.id)}
            >
              <span className="aya-kanban-popover-icon">⇥</span>
              <span>Move to backlog</span>
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="aya-kanban-popover-item aya-kanban-popover-item--danger"
            onClick={() => void handleDeleteCard(activeMenuCard.id)}
          >
            <span className="aya-kanban-popover-icon">×</span>
            <span>Delete card</span>
          </button>
        </div>, document.body
      )}

      {previewImage && (
        <div
          className="aya-kanban-lightbox"
          role="dialog"
          aria-label={previewImage.alt}
          onClick={() => setPreviewImage(null)}
        >
          <div
            className="aya-kanban-lightbox-inner"
            onClick={(e) => e.stopPropagation()}
          >
            <img src={previewImage.src} alt={previewImage.alt} />
            <div className="aya-kanban-lightbox-bar">
              <span>{previewImage.alt}</span>
              <button
                type="button"
                className="aya-kanban-btn"
                onClick={() => setPreviewImage(null)}
              >
                Close (Esc)
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
});

export { extractChecklistProgress, toggleMarkdownTaskItem } from "./KanbanCardContent";
