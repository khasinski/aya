import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { PRESET_ID_BOARD } from "../preset-ids";
import { guiSupportedAgent } from "../agentPreset";
import type {
  BoardSnapshot,
  KanbanCard,
  KanbanColumn,
  Preset,
  TerminalState,
} from "../types";
import "./kanban.css";

interface Props {
  terminal: TerminalState;
  hidden?: boolean;
  paneStyle?: CSSProperties;
  isActivePane?: boolean;
  onActivatePane?: () => void;
  headerSlot?: HTMLElement | null;
  listSiblingTerminals: (self: {
    id: string;
    projectSlug: string;
  }) => Array<{ id: string; name: string }>;
  presets: Preset[];
  onStartCardInNewPane?: (
    preset: Preset,
    cardId: string,
    projectSlug: string,
  ) => Promise<BoardSnapshot>;
}

function cleanIpcError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}

function columnDotClass(colId: string): string {
  if (colId === "todo" || colId === "in-progress" || colId === "review" || colId === "done") {
    return `aya-kanban-column-dot aya-kanban-column-dot--${colId}`;
  }
  return "aya-kanban-column-dot";
}

export const KanbanView = memo(function KanbanView({
  terminal,
  hidden = false,
  paneStyle,
  isActivePane = false,
  onActivatePane,
  headerSlot = null,
  listSiblingTerminals,
  presets,
  onStartCardInNewPane,
}: Props) {
  const [board, setBoard] = useState<BoardSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Add column form state
  const [addingColumn, setAddingColumn] = useState(false);
  const [newColumnName, setNewColumnName] = useState("");
  const [movingColumn, setMovingColumn] = useState(false);
  const columnMovePending = useRef(false);
  const columnsRef = useRef<HTMLDivElement>(null);
  const columnToReveal = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (!columnToReveal.current) return;
    columnsRef.current?.querySelector<HTMLElement>(`[data-testid="kanban-column-${CSS.escape(columnToReveal.current)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    columnToReveal.current = null;
  }, [board]);

  // Rename column state
  const [renamingColId, setRenamingColId] = useState<string | null>(null);
  const [renameColDraft, setRenameColDraft] = useState("");

  // Add card per column state
  const [addingCardColId, setAddingCardColId] = useState<string | null>(null);
  const [newCardTitle, setNewCardTitle] = useState("");
  const [newCardDesc, setNewCardDesc] = useState("");
  const [newCardAssignee, setNewCardAssignee] = useState("");

  // Edit card state
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editAssignee, setEditAssignee] = useState("");

  // Card action popover state
  const [cardMenu, setCardMenu] = useState<{
    cardId: string;
  } | null>(null);
  const cardMenuRef = useRef<HTMLDivElement>(null);
  const cardMenuAnchor = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!cardMenu) return;
    const menu = cardMenuRef.current;
    const anchor = cardMenuAnchor.current;
    if (!menu || !anchor) return;
    const position = () => {
      const trigger = anchor.getBoundingClientRect();
      const { width, height } = menu.getBoundingClientRect();
      const left = Math.max(8, Math.min(trigger.right - width, window.innerWidth - width - 8));
      const below = trigger.bottom + 4;
      const preferredTop = below + height <= window.innerHeight - 8 ? below : trigger.top - height - 4;
      menu.style.left = `${left}px`;
      menu.style.top = `${Math.max(8, Math.min(preferredTop, window.innerHeight - height - 8))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(menu);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [cardMenu]);

  // Drag state
  const [draggingCardId, setDraggingCardId] = useState<string | null>(null);
  const [dropTargetColId, setDropTargetColId] = useState<string | null>(null);

  const loadBoard = useCallback(async () => {
    try {
      const next = await window.aya.getBoard(terminal.projectSlug);
      setBoard(next);
    } catch (err) {
      setError(cleanIpcError(err));
    }
  }, [terminal.projectSlug]);

  useEffect(() => {
    void loadBoard();
    return window.aya.onBoardChange((slug) => {
      if (slug === terminal.projectSlug) {
        void loadBoard();
      }
    });
  }, [loadBoard, terminal.projectSlug]);

  useEffect(() => {
    if (!cardMenu) return;
    const close = () => setCardMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCardMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [cardMenu]);

  const runAction = async (fn: () => Promise<BoardSnapshot | unknown>) => {
    setError(null);
    try {
      const res = await fn();
      if (res && typeof res === "object" && "columns" in res && "cards" in res) {
        setBoard(res as BoardSnapshot);
      } else {
        await loadBoard();
      }
    } catch (err) {
      setError(cleanIpcError(err));
    }
  };

  const handleAddColumn = async () => {
    const trimmed = newColumnName.trim();
    if (!trimmed) return;
    setAddingColumn(false);
    setNewColumnName("");
    await runAction(() =>
      window.aya.addBoardColumn({
        projectSlug: terminal.projectSlug,
        title: trimmed,
      }),
    );
  };

  const handleMoveColumn = async (columnId: string, anchor: string, direction: "before" | "after") => {
    if (columnMovePending.current) return;
    columnMovePending.current = true;
    setMovingColumn(true);
    try {
      await runAction(async () => {
        const next = await window.aya.moveBoardColumn({ projectSlug: terminal.projectSlug, columnId, [direction]: anchor });
        columnToReveal.current = columnId;
        return next;
      });
    } finally {
      columnMovePending.current = false;
      setMovingColumn(false);
    }
  };

  const handleRenameColumn = async (columnId: string) => {
    const trimmed = renameColDraft.trim();
    setRenamingColId(null);
    if (!trimmed) return;
    await runAction(() =>
      window.aya.renameBoardColumn({
        projectSlug: terminal.projectSlug,
        columnId,
        title: trimmed,
      }),
    );
  };

  const handleDeleteColumn = async (col: KanbanColumn) => {
    await runAction(() =>
      window.aya.deleteBoardColumn({
        projectSlug: terminal.projectSlug,
        columnId: col.id,
      }),
    );
  };

  const openAddCard = (columnId: string) => {
    setAddingCardColId(columnId);
    setNewCardTitle("");
    setNewCardDesc("");
    setNewCardAssignee("");
  };

  const handleCreateCard = async (columnId: string) => {
    const title = newCardTitle.trim();
    if (!title) return;
    const description = newCardDesc.trim();
    const assignee = newCardAssignee.trim();
    setAddingCardColId(null);
    setNewCardTitle("");
    setNewCardDesc("");
    setNewCardAssignee("");
    await runAction(() =>
      window.aya.addBoardCard({
        projectSlug: terminal.projectSlug,
        columnId,
        title,
        ...(description ? { description } : {}),
        ...(assignee ? { assignee } : {}),
      }),
    );
  };

  const startEditCard = (card: KanbanCard) => {
    setCardMenu(null);
    setEditingCardId(card.id);
    setEditTitle(card.title);
    setEditDesc(card.description ?? "");
    setEditAssignee(card.assignee ?? "");
  };

  const handleSaveCard = async (cardId: string) => {
    const title = editTitle.trim();
    if (!title) return;
    setEditingCardId(null);
    await runAction(() =>
      window.aya.updateBoardCard({
        projectSlug: terminal.projectSlug,
        cardId,
        title,
        description: editDesc,
        assignee: editAssignee.trim() || null,
      }),
    );
  };

  const handleMoveCard = async (cardId: string, toColumnId: string) => {
    setCardMenu(null);
    await runAction(() =>
      window.aya.moveBoardCard({
        projectSlug: terminal.projectSlug,
        cardId,
        columnId: toColumnId,
      }),
    );
  };

  const handleDeleteCard = async (cardId: string) => {
    setCardMenu(null);
    await runAction(() =>
      window.aya.deleteBoardCard({
        projectSlug: terminal.projectSlug,
        cardId,
      }),
    );
  };

  const handleExportToRepo = async () => {
    await runAction(() => window.aya.exportBoardToRepo(terminal.projectSlug));
  };

  const openCardPopover = (e: ReactMouseEvent<HTMLElement>, cardId: string) => {
    e.stopPropagation();
    if (cardMenu?.cardId === cardId) {
      setCardMenu(null);
      return;
    }
    cardMenuAnchor.current = e.currentTarget;
    setCardMenu({ cardId });
  };

  const siblings = listSiblingTerminals(terminal);
  const launchablePresets = presets.filter(p => p.id !== PRESET_ID_BOARD && !(p.interfaceMode === "gui" && guiSupportedAgent(p)));

  const headerNode = (
    <div className="aya-pane-header">
      <span className="aya-pane-header-title">
        <span style={{ color: "#58a6ff", marginRight: 6 }}>▦</span>
        {terminal.name}
        <span
          className="aya-settings-experimental"
          style={{ marginLeft: 8 }}
        >
          Experimental
        </span>
      </span>
      <div className="aya-kanban-toolbar-meta">
        {board && (
          <>
            <span
              className={`aya-kanban-source-badge ${
                board.source === "repo" ? "aya-kanban-source-badge--repo" : ""
              }`}
              title={`Stored at ${board.filePath}`}
            >
              {board.source === "repo"
                ? "repo (.aya/board.json)"
                : "user config (~/.aya/boards)"}
            </span>
            {board.source === "user" && (
              <button
                type="button"
                className="aya-kanban-btn"
                title="Promote board to .aya/board.json in the repository so it takes priority and can be committed"
                onClick={() => void handleExportToRepo()}
              >
                Save to .aya/board.json
              </button>
            )}
          </>
        )}
        {addingColumn ? (
          <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
            <input
              className="aya-kanban-input"
              style={{ width: 130, padding: "2px 6px", fontSize: 11.5 }}
              placeholder="Column name…"
              value={newColumnName}
              onChange={(e) => setNewColumnName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleAddColumn();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setAddingColumn(false);
                  setNewColumnName("");
                }
              }}
              autoFocus
            />
            <button
              type="button"
              className="aya-kanban-btn aya-kanban-btn--primary"
              onClick={() => void handleAddColumn()}
            >
              Add
            </button>
            <button
              type="button"
              className="aya-kanban-btn"
              onClick={() => {
                setAddingColumn(false);
                setNewColumnName("");
              }}
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="aya-kanban-btn"
            onClick={() => setAddingColumn(true)}
          >
            + Column
          </button>
        )}
      </div>
    </div>
  );

  const activeMenuCard =
    cardMenu && board
      ? board.cards.find((c) => c.id === cardMenu.cardId) ?? null
      : null;

  return (
    <section
      data-testid="kanban-pane"
      data-terminal-id={terminal.id}
      className={`aya-pane aya-kanban-pane${
        isActivePane ? " aya-pane--active-split" : ""
      }`}
      style={{ ...paneStyle, ...(hidden ? { display: "none" } : {}) }}
      onMouseDown={() => onActivatePane?.()}
    >
      {headerSlot && !hidden ? createPortal(headerNode, headerSlot) : headerNode}
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
          {board.notices.map(notice => <div key={notice.id}>
            Task {notice.cardId}: {notice.state !== "pending"
              ? `withdrawal delivery started in ${notice.paneName}; check that panel. Automatic retries are paused to avoid sending it twice.`
              : `withdrawal message is waiting for ${notice.paneName}. Aya will retry when the panel can receive it.`}
            {notice.state !== "pending" && <button type="button" className="aya-kanban-btn"
              onClick={() => void runAction(() => window.aya.acknowledgeBoardNotice({ projectSlug: terminal.projectSlug, noticeId: notice.id }))}>
              Clear checked notice
            </button>}
          </div>)}
        </div>
      )}
      {!board ? (
        <div style={{ padding: 16, fontSize: 12.5, color: "var(--aya-pane-subtle)" }}>
          Loading board…
        </div>
      ) : (
        <div className="aya-kanban-columns" ref={columnsRef}>
          {board.columns.map((col, colIndex) => {
            const colCards = board.cards.filter((c) => c.columnId === col.id);
            const isDropTarget = dropTargetColId === col.id;
            const prevCol = colIndex > 0 ? board.columns[colIndex - 1] : null;
            const nextCol =
              colIndex < board.columns.length - 1
                ? board.columns[colIndex + 1]
                : null;
            return (
              <div
                key={col.id}
                data-testid={`kanban-column-${col.id}`}
                className={`aya-kanban-column${
                  isDropTarget ? " aya-kanban-column--drop-target" : ""
                }`}
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
                  const cardId =
                    draggingCardId || e.dataTransfer.getData("text/plain");
                  setDraggingCardId(null);
                  if (cardId) {
                    void handleMoveCard(cardId, col.id);
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
                  <span className="aya-kanban-column-count">{colCards.length}</span>
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
                  {board.columns.length > 1 && colCards.length === 0 && (
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
                    <div className="aya-kanban-form">
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
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            setAddingCardColId(null);
                          }
                        }}
                        autoFocus
                      />
                      <textarea
                        className="aya-kanban-textarea"
                        placeholder="Description / prompt details (optional)…"
                        aria-label="Card description"
                        value={newCardDesc}
                        onChange={(e) => setNewCardDesc(e.target.value)}
                      />
                      <input
                        className="aya-kanban-input"
                        placeholder="Assignee (optional)…"
                        aria-label="Card assignee"
                        value={newCardAssignee}
                        onChange={(e) => setNewCardAssignee(e.target.value)}
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
                    <div className="aya-kanban-empty-col">No cards</div>
                  )}

                  {colCards.map((card) => {
                    const isEditing = editingCardId === card.id;
                    const isDragging = draggingCardId === card.id;
                    if (isEditing) {
                      return (
                        <div key={card.id} className="aya-kanban-form">
                          <input
                            className="aya-kanban-input"
                            value={editTitle}
                            aria-label="Edit card title"
                            onChange={(e) => setEditTitle(e.target.value)}
                            autoFocus
                          />
                          <textarea
                            className="aya-kanban-textarea"
                            value={editDesc}
                            aria-label="Edit card description"
                            onChange={(e) => setEditDesc(e.target.value)}
                          />
                          <input
                            className="aya-kanban-input"
                            placeholder="Assignee (optional)…"
                            aria-label="Edit card assignee"
                            value={editAssignee}
                            onChange={(e) => setEditAssignee(e.target.value)}
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

                    return (
                      <div
                        key={card.id}
                        data-testid={`kanban-card-${card.id}`}
                        className={`aya-kanban-card${
                          card.claim ? " aya-kanban-card--claimed" : ""
                        }${isDragging ? " aya-kanban-card--dragging" : ""}`}
                        draggable
                        onDoubleClick={() => startEditCard(card)}
                        onDragStart={(e) => {
                          setDraggingCardId(card.id);
                          e.dataTransfer.effectAllowed = "move";
                          e.dataTransfer.setData("text/plain", card.id);
                        }}
                        onDragEnd={() => {
                          setDraggingCardId(null);
                          setDropTargetColId(null);
                        }}
                      >
                        <div className="aya-kanban-card-meta">
                          <span className="aya-kanban-card-id">{card.id}</span>
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
                            <button
                              type="button"
                              className="aya-kanban-iconbtn"
                              title="Edit card"
                              aria-label={`Edit card ${card.id}`}
                              onClick={() => startEditCard(card)}
                            >
                              ✎
                            </button>
                            <button
                              type="button"
                              className="aya-kanban-iconbtn aya-kanban-iconbtn--danger"
                              title="Delete card"
                              aria-label={`Delete card ${card.id}`}
                              onClick={() => void handleDeleteCard(card.id)}
                            >
                              ×
                            </button>
                          </div>
                        </div>

                        <div className="aya-kanban-card-title">{card.title}</div>
                        {card.claim?.startup && card.claim.startup !== "sent" && (
                          <span className="aya-kanban-pill" title="Check the assigned pane before retrying an unconfirmed task delivery">
                            {card.claim.startup === "reserved" ? "Waiting to start" : "Task delivery unconfirmed"}
                          </span>
                        )}

                        {card.description && (
                          <div className="aya-kanban-card-desc">
                            {card.description}
                          </div>
                        )}

                        <div className="aya-kanban-card-footer">
                          <div className="aya-kanban-card-badges">
                            {card.claim ? (
                              <span
                                className="aya-kanban-pill aya-kanban-pill--claimed"
                                title={`Claimed by ${card.claim.paneName}`}
                              >
                                <span
                                  className="aya-kanban-pill-dot"
                                  aria-hidden="true"
                                />
                                <span>{card.claim.paneName}</span>
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
              {siblings.map((s) => (
                <button
                  key={`send:${s.id}`}
                  type="button"
                  role="menuitem"
                  className="aya-kanban-popover-item"
                  onClick={() => {
                    setCardMenu(null);
                    void runAction(() =>
                      window.aya.sendBoardCardToPane({
                        projectSlug: terminal.projectSlug,
                        cardId: activeMenuCard.id,
                        targetId: s.id,
                      }),
                    );
                  }}
                >
                  <span className="aya-kanban-popover-icon">↪</span>
                  <span>{s.name}</span>
                </button>
              ))}
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
                  <span>{s.name}</span>
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
                <button
                  key={`new:${p.id}`}
                  type="button"
                  role="menuitem"
                  className="aya-kanban-popover-item"
                  onClick={() => {
                    setCardMenu(null);
                    void runAction(() => onStartCardInNewPane(p, activeMenuCard.id, terminal.projectSlug));
                  }}
                >
                  <span
                    className="aya-kanban-popover-icon"
                    style={p.color ? { color: p.color } : undefined}
                  >
                    {p.icon}
                  </span>
                  <span>{p.name}</span>
                </button>
              ))}
            </>
          )}

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
            className="aya-kanban-popover-item aya-kanban-popover-item--danger"
            onClick={() => void handleDeleteCard(activeMenuCard.id)}
          >
            <span className="aya-kanban-popover-icon">×</span>
            <span>Delete card</span>
          </button>
        </div>, document.body
      )}
    </section>
  );
});
