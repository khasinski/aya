import { COLUMN_IDS, DEFAULT_BOARD_COLUMNS, isBacklogColumn } from "../../shared/board-columns.cjs";
import { PRIORITY_OPTIONS } from "../../shared/board-priorities.cjs";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from "react";
import { guiSupportedAgent } from "../agentPreset";
import { PRESET_ID_BOARD } from "../preset-ids";
import type {
  BoardSnapshot,
  KanbanCard,
  KanbanColumn,
  KanbanPriority,
  Preset,
  TerminalState,
} from "../types";
import "./kanban.css";
import { matchesSearchQuery } from "./kanban-search";
import { cleanIpcError, parseLabelsInput, readFileAsDataUrl, toggleLabelInDraft, toggleMarkdownTaskItem } from './KanbanCardContent';

export { extractChecklistProgress, toggleMarkdownTaskItem } from './KanbanCardContent';

/** The board's priorities, highest first; shared/board-priorities.cjs defines them. */
export { PRIORITY_OPTIONS };

export const QUICK_LABELS: readonly string[] = [
  "bug",
  "feat",
  "refactor",
  "docs",
  "test",
];

export interface Props {
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
  siblingTerminals?: TerminalState[];
  presets: Preset[];
  projectDir?: string;
  onStartCardInNewPane?: (
    preset: Preset,
    cardId: string,
    projectSlug: string,
    cwd?: string,
  ) => Promise<BoardSnapshot>;
  onCreateWorktrees?: (req: {
    directory: string;
    slug: string;
    count: number;
    base: string;
  }) => Promise<{
    created: { path: string; branch: string }[];
    errors: string[];
  }>;
  onFocusTerminal?: (terminalId: string) => void;
  onSplitRight?: (terminalId: string) => void;
  /** Settings > Kanban > Move backlog to shelf: the Backlog column shows in the shelf, not on the board. */
  backlogOnShelf?: boolean;
}

export function columnDotClass(colId: string): string {
  if (DEFAULT_BOARD_COLUMNS.some((column) => column.id === colId)) {
    return `aya-kanban-column-dot aya-kanban-column-dot--${colId}`;
  }
  return "aya-kanban-column-dot";
}

export function useKanbanBoard({
  terminal,
  hidden = false,
  paneStyle,
  isActivePane = false,
  onActivatePane,
  headerSlot = null,
  listSiblingTerminals,
  siblingTerminals,
  presets,
  projectDir,
  onStartCardInNewPane,
  onCreateWorktrees,
  onFocusTerminal,
  onSplitRight,
  backlogOnShelf = false,
}: Props) {

  const [board, setBoard] = useState<BoardSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    text: string;
    terminalId?: string;
    terminalName?: string;
  } | null>(null);

  // Undo state for card delete / Clear Done
  const [undoState, setUndoState] = useState<{
    label: string;
    entries: Array<{ card: KanbanCard; index: number }>;
  } | null>(null);

  // Search and quick filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [filterAssignee, setFilterAssignee] = useState<string | null>(null);
  const [filterPriority, setFilterPriority] = useState<KanbanPriority | null>(
    null,
  );
  const [filterLabel, setFilterLabel] = useState<string | null>(null);

  // Collapsed columns state (persisted per project in localStorage)
  const collapsedStorageKey = `aya:kanban-collapsed:${terminal.projectSlug}`;
  const [collapsedCols, setCollapsedCols] = useState<Record<string, boolean>>(
    () => {
      try {
        const raw = localStorage.getItem(collapsedStorageKey);
        return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
      } catch {
        return {};
      }
    },
  );

  useEffect(() => {
    try {
      const raw = localStorage.getItem(collapsedStorageKey);
      setCollapsedCols(raw ? (JSON.parse(raw) as Record<string, boolean>) : {});
    } catch {
      setCollapsedCols({});
    }
  }, [collapsedStorageKey]);

  const toggleColumnCollapsed = useCallback(
    (colId: string) => {
      setCollapsedCols((prev) => {
        const next = { ...prev, [colId]: !prev[colId] };
        if (!next[colId]) delete next[colId];
        try {
          localStorage.setItem(collapsedStorageKey, JSON.stringify(next));
        } catch {
          // Ignore storage quota errors
        }
        return next;
      });
    },
    [collapsedStorageKey],
  );

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
  const [newCardPriority, setNewCardPriority] = useState<KanbanPriority | "">(
    "",
  );
  const [newCardLabels, setNewCardLabels] = useState("");

  // Edit card state
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editAssignee, setEditAssignee] = useState("");
  const [editPriority, setEditPriority] = useState<KanbanPriority | "">("");
  const [editLabels, setEditLabels] = useState("");

  // Expanded card descriptions & delete confirmation
  const [expandedCards, setExpandedCards] = useState<Record<string, boolean>>(
    {},
  );
  const [confirmDeleteCardId, setConfirmDeleteCardId] = useState<string | null>(
    null,
  );
  const [shiftDeleteReady, setShiftDeleteReady] = useState(false);

  // Archive drawer state
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [confirmEmptyArchive, setConfirmEmptyArchive] = useState(false);

  // Lightbox preview for card images
  const [previewImage, setPreviewImage] = useState<{
    src: string;
    alt: string;
  } | null>(null);

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

  // Drag & drop reorder state
  const [draggingCardId, setDraggingCardId] = useState<string | null>(null);
  const [dropTargetColId, setDropTargetColId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{
    colId: string;
    index: number;
  } | null>(null);

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const addDescRef = useRef<HTMLTextAreaElement | null>(null);
  const editDescRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputTargetRef = useRef<"add" | "edit">("add");

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

  useEffect(() => {
    if (!previewImage) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPreviewImage(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewImage]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!undoState) return;
    const timer = window.setTimeout(() => setUndoState(null), 8000);
    return () => window.clearTimeout(timer);
  }, [undoState]);

  const runAction = useCallback(
    async (fn: () => Promise<BoardSnapshot | unknown>) => {
      setError(null);
      try {
        const res = await fn();
        if (
          res &&
          typeof res === "object" &&
          "columns" in res &&
          "cards" in res
        ) {
          setBoard(res as BoardSnapshot);
        } else {
          await loadBoard();
        }
      } catch (err) {
        setError(cleanIpcError(err));
      }
    },
    [loadBoard],
  );

  const handleUndoDelete = useCallback(async () => {
    if (!undoState) return;
    const entriesToRestore = undoState.entries;
    setUndoState(null);
    if (typeof window.aya.restoreBoardCards === "function") {
      await runAction(() =>
        window.aya.restoreBoardCards({
          projectSlug: terminal.projectSlug,
          entries: entriesToRestore,
        }),
      );
    } else {
      for (const entry of entriesToRestore) {
        await runAction(() =>
          window.aya.addBoardCard({
            projectSlug: terminal.projectSlug,
            id: entry.card.id,
            columnId: entry.card.columnId,
            title: entry.card.title,
            description: entry.card.description,
            assignee: entry.card.assignee,
            priority: entry.card.priority,
            labels: entry.card.labels,
            index: entry.index,
          }),
        );
      }
    }
  }, [runAction, terminal.projectSlug, undoState]);

  const openAddCard = useCallback(
    (columnId: string) => {
      setEditingCardId(null);
      setAddingCardColId(columnId);
      setNewCardTitle("");
      setNewCardDesc("");
      setNewCardAssignee("");
      setNewCardPriority("");
      setNewCardLabels("");
      if (collapsedCols[columnId]) {
        toggleColumnCollapsed(columnId);
      }
    },
    [collapsedCols, toggleColumnCollapsed],
  );

  // Shift-delete visual indicator + board-level keyboard shortcuts (n/c, /, Cmd+F, Cmd+Z)
  useEffect(() => {
    if (hidden) {
      setShiftDeleteReady(false);
      return;
    }
    const isTextField = (el: Element | null): boolean => {
      if (!el || !(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        el.isContentEditable ||
        Boolean(el.closest(".xterm"))
      );
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Shift" && !isTextField(document.activeElement)) {
        setShiftDeleteReady(true);
        return;
      }
      if (isTextField(document.activeElement)) {
        setShiftDeleteReady(false);
        return;
      }
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "z" &&
        undoState
      ) {
        e.preventDefault();
        e.stopPropagation();
        void handleUndoDelete();
        return;
      }
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "f"
      ) {
        e.preventDefault();
        e.stopPropagation();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }
      if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key === "/") {
        e.preventDefault();
        e.stopPropagation();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }
      if (
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey &&
        (e.key === "n" || e.key === "c") &&
        board &&
        board.columns.length > 0
      ) {
        e.preventDefault();
        e.stopPropagation();
        // The shortcut targets the first column the board actually shows, so it
        // skips the Backlog column while it sits on the shelf.
        const visibleColumns = (board?.columns ?? []).filter(
          (col) => !(backlogOnShelf && isBacklogColumn(col)),
        );
        const targetCol =
          visibleColumns.find((col) => !collapsedCols[col.id]) ??
          visibleColumns[0];
        if (targetCol) openAddCard(targetCol.id);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift" || !e.shiftKey) {
        setShiftDeleteReady(false);
      }
    };
    const onBlur = () => setShiftDeleteReady(false);
    const onFocusIn = (e: FocusEvent) => {
      if (isTextField(e.target as Element | null)) {
        setShiftDeleteReady(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focusin", onFocusIn);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focusin", onFocusIn);
    };
  }, [backlogOnShelf, board, collapsedCols, handleUndoDelete, hidden, openAddCard, undoState]);

  const insertIntoDescription = useCallback(
    (
      target: "add" | "edit",
      snippet: string,
      selectRange?: [number, number],
    ) => {
      const textarea =
        target === "add" ? addDescRef.current : editDescRef.current;
      const current = target === "add" ? newCardDesc : editDesc;
      const setter = target === "add" ? setNewCardDesc : setEditDesc;
      if (!textarea) {
        setter(current ? `${current}\n${snippet}` : snippet);
        return;
      }
      const start = textarea.selectionStart ?? current.length;
      const end = textarea.selectionEnd ?? current.length;
      const prefix =
        start > 0 && current[start - 1] !== "\n" && snippet.startsWith("- [ ]")
          ? "\n"
          : "";
      const next = `${current.slice(0, start)}${prefix}${snippet}${current.slice(end)}`;
      setter(next);
      requestAnimationFrame(() => {
        textarea.focus();
        if (selectRange) {
          textarea.setSelectionRange(
            start + prefix.length + selectRange[0],
            start + prefix.length + selectRange[1],
          );
        } else {
          const cursor = start + prefix.length + snippet.length;
          textarea.setSelectionRange(cursor, cursor);
        }
      });
    },
    [editDesc, newCardDesc],
  );

  const handleInsertLink = (target: "add" | "edit") => {
    const textarea =
      target === "add" ? addDescRef.current : editDescRef.current;
    const current = target === "add" ? newCardDesc : editDesc;
    const selected =
      textarea && textarea.selectionStart !== textarea.selectionEnd
        ? current.slice(textarea.selectionStart, textarea.selectionEnd)
        : "link";
    const snippet = `[${selected}](https://)`;
    const urlStart = selected.length + 3;
    const urlEnd = snippet.length - 1;
    insertIntoDescription(target, snippet, [urlStart, urlEnd]);
  };

  const saveAndInsertImageFile = async (
    target: "add" | "edit",
    file: File,
  ) => {
    try {
      const dataBase64 = await readFileAsDataUrl(file);
      if (typeof window.aya?.saveBoardImage === "function") {
        const saved = await window.aya.saveBoardImage({
          projectSlug: terminal.projectSlug,
          dataBase64,
          name: file.name || "screenshot",
        });
        insertIntoDescription(target, saved.markdown);
      } else {
        insertIntoDescription(
          target,
          `![${file.name || "image"}](${dataBase64})`,
        );
      }
    } catch (err) {
      setError(cleanIpcError(err));
    }
  };

  const handleTextareaPaste = (
    target: "add" | "edit",
    e: ReactClipboardEvent<HTMLTextAreaElement>,
  ) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItem = items.find((item) => item.type.startsWith("image/"));
    if (!imageItem) return;
    const file = imageItem.getAsFile();
    if (!file) return;
    e.preventDefault();
    void saveAndInsertImageFile(target, file);
  };

  const handleTextareaDrop = (
    target: "add" | "edit",
    e: ReactDragEvent<HTMLTextAreaElement>,
  ) => {
    const files = Array.from(e.dataTransfer?.files ?? []);
    const imageFile = files.find((f) => f.type.startsWith("image/"));
    if (!imageFile) return;
    e.preventDefault();
    e.stopPropagation();
    void saveAndInsertImageFile(target, imageFile);
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

  const handleClearColumn = async (col: KanbanColumn) => {
    if (!board) return;
    const colCards = board.cards.filter((c) => c.columnId === col.id);
    if (colCards.length === 0) return;
    const entries = colCards.map((card, index) => ({ card, index }));
    setUndoState({
      label: `Archived ${colCards.length} card${colCards.length === 1 ? "" : "s"} from ${col.title}`,
      entries,
    });
    if (typeof window.aya.clearBoardColumn === "function") {
      await runAction(() =>
        window.aya.clearBoardColumn({
          projectSlug: terminal.projectSlug,
          columnId: col.id,
          archive: true,
        }),
      );
    } else {
      for (const card of colCards) {
        await runAction(() =>
          window.aya.deleteBoardCard({
            projectSlug: terminal.projectSlug,
            cardId: card.id,
            archive: true,
          }),
        );
      }
    }
  };

  const handleArchiveCard = async (cardId: string) => {
    setCardMenu(null);
    setConfirmDeleteCardId(null);
    if (board) {
      const target = board.cards.find((c) => c.id === cardId);
      if (target) {
        const colCards = board.cards.filter(
          (c) => c.columnId === target.columnId,
        );
        const colIndex = Math.max(
          0,
          colCards.findIndex((c) => c.id === cardId),
        );
        setUndoState({
          label: `Archived ${target.id} "${target.title}"`,
          entries: [{ card: target, index: colIndex }],
        });
      }
    }
    await runAction(() =>
      window.aya.deleteBoardCard({
        projectSlug: terminal.projectSlug,
        cardId,
        archive: true,
      }),
    );
  };

  const handleRestoreArchivedCard = async (card: KanbanCard) => {
    setConfirmDeleteCardId(null);
    if (typeof window.aya.restoreBoardCards === "function") {
      await runAction(() =>
        window.aya.restoreBoardCards({
          projectSlug: terminal.projectSlug,
          entries: [{ card }],
        }),
      );
    } else {
      await runAction(() =>
        window.aya.addBoardCard({
          projectSlug: terminal.projectSlug,
          id: card.id,
          columnId: card.columnId,
          title: card.title,
          description: card.description,
          assignee: card.assignee,
          priority: card.priority,
          labels: card.labels,
        }),
      );
    }
  };

  // No Undo here: the card lands in the Backlog column - or on the shelf's
  // Backlog tab while Move backlog to shelf is on - and Restore puts it back.
  const handleMoveToBacklog = async (cardId: string) => {
    setCardMenu(null);
    setConfirmDeleteCardId(null);
    await runAction(() =>
      window.aya.moveBoardCard({ projectSlug: terminal.projectSlug, cardId, columnId: COLUMN_IDS.backlog }),
    );
  };

  // Back on the board in its first visible column; the card does not remember where it came from.
  const handleRestoreBacklogCard = async (cardId: string) => {
    setConfirmDeleteCardId(null);
    const columnId = boardColumns[0]?.id;
    if (!columnId) return;
    await runAction(() =>
      window.aya.moveBoardCard({ projectSlug: terminal.projectSlug, cardId, columnId }),
    );
  };

  const handleDeleteArchivedCard = async (cardId: string) => {
    setConfirmDeleteCardId(null);
    await runAction(() =>
      window.aya.deleteBoardCard({
        projectSlug: terminal.projectSlug,
        cardId,
        archive: false,
      }),
    );
  };

  const handleEmptyArchive = async () => {
    setConfirmEmptyArchive(false);
    if (typeof window.aya.clearBoardColumn === "function") {
      await runAction(() =>
        window.aya.clearBoardColumn({
          projectSlug: terminal.projectSlug,
          columnId: "__archive__",
          archive: false,
        }),
      );
    }
  };

  const handleCreateCard = async (columnId: string) => {
    const title = newCardTitle.trim();
    if (!title) return;
    const description = newCardDesc.trim();
    const assignee = newCardAssignee.trim();
    const priority = newCardPriority || undefined;
    const labels = parseLabelsInput(newCardLabels);
    setAddingCardColId(null);
    setNewCardTitle("");
    setNewCardDesc("");
    setNewCardAssignee("");
    setNewCardPriority("");
    setNewCardLabels("");
    await runAction(() =>
      window.aya.addBoardCard({
        projectSlug: terminal.projectSlug,
        columnId,
        title,
        ...(description ? { description } : {}),
        ...(assignee ? { assignee } : {}),
        ...(priority ? { priority } : {}),
        ...(labels.length > 0 ? { labels } : {}),
      }),
    );
  };

  const startEditCard = (card: KanbanCard) => {
    setCardMenu(null);
    setAddingCardColId(null);
    setConfirmDeleteCardId(null);
    setEditingCardId(card.id);
    setEditTitle(card.title);
    setEditDesc(card.description ?? "");
    setEditAssignee(card.assignee ?? "");
    setEditPriority(card.priority ?? "");
    setEditLabels(card.labels?.join(", ") ?? "");
  };

  const handleSaveCard = async (cardId: string) => {
    const title = editTitle.trim();
    if (!title) return;
    const labels = parseLabelsInput(editLabels);
    setEditingCardId(null);
    await runAction(() =>
      window.aya.updateBoardCard({
        projectSlug: terminal.projectSlug,
        cardId,
        title,
        description: editDesc,
        assignee: editAssignee.trim() || null,
        priority: editPriority || null,
        labels: labels.length > 0 ? labels : null,
      }),
    );
  };

  const handleQuickSetPriority = async (
    cardId: string,
    priority: KanbanPriority | null,
  ) => {
    setCardMenu(null);
    await runAction(() =>
      window.aya.updateBoardCard({
        projectSlug: terminal.projectSlug,
        cardId,
        priority,
      }),
    );
  };

  const handleToggleCardTaskItem = async (
    card: KanbanCard,
    checkboxIndex: number,
  ) => {
    if (!card.description) return;
    const updatedDesc = toggleMarkdownTaskItem(card.description, checkboxIndex);
    if (updatedDesc === card.description) return;
    await runAction(() =>
      window.aya.updateBoardCard({
        projectSlug: terminal.projectSlug,
        cardId: card.id,
        description: updatedDesc,
      }),
    );
  };

  const handleMoveCard = async (
    cardId: string,
    toColumnId: string,
    index?: number,
  ) => {
    setCardMenu(null);
    await runAction(() =>
      window.aya.moveBoardCard({
        projectSlug: terminal.projectSlug,
        cardId,
        columnId: toColumnId,
        ...(typeof index === "number" ? { index } : {}),
      }),
    );
  };

  const handleDeleteCard = async (cardId: string) => {
    setCardMenu(null);
    setConfirmDeleteCardId(null);
    if (board) {
      const target = board.cards.find((c) => c.id === cardId);
      if (target) {
        const colCards = board.cards.filter(
          (c) => c.columnId === target.columnId,
        );
        const colIndex = Math.max(
          0,
          colCards.findIndex((c) => c.id === cardId),
        );
        setUndoState({
          label: `Deleted ${target.id} "${target.title}"`,
          entries: [{ card: target, index: colIndex }],
        });
      }
    }
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

  const handleStartCardInWorktree = async (
    card: KanbanCard,
    preset: Preset,
    splitBeside?: boolean,
  ) => {
    if (!projectDir || !onCreateWorktrees || !onStartCardInNewPane) return;
    setCardMenu(null);
    setError(null);
    try {
      const slug = `${card.id}-${card.title}`;
      const result = await onCreateWorktrees({
        directory: projectDir,
        slug,
        count: 1,
        base: "HEAD",
      });
      if (result.created.length === 0) {
        setError(
          result.errors.join("; ") || "Could not create git worktree for card.",
        );
        return;
      }
      const checkout = result.created[0];
      const nextBoard = await onStartCardInNewPane(
        preset,
        card.id,
        terminal.projectSlug,
        checkout.path,
      );
      setBoard(nextBoard);
      const startedCard = nextBoard.cards.find((c) => c.id === card.id);
      const paneId = startedCard?.claim?.paneId;
      if (paneId) {
        if (splitBeside && onSplitRight) {
          onSplitRight(paneId);
        } else {
          setNotice({
            text: `Started ${card.id} in worktree ${checkout.branch}`,
            terminalId: paneId,
            terminalName: startedCard?.claim?.paneName ?? preset.name,
          });
        }
      }
    } catch (err) {
      setError(cleanIpcError(err));
    }
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

  const handleAddFormKeyDown = (
    colId: string,
    e: ReactKeyboardEvent<HTMLElement>,
  ) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setAddingCardColId(null);
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      void handleCreateCard(colId);
    }
  };

  const handleEditFormKeyDown = (
    cardId: string,
    e: ReactKeyboardEvent<HTMLElement>,
  ) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setEditingCardId(null);
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      void handleSaveCard(cardId);
    }
  };

  const siblings = listSiblingTerminals(terminal);
  const siblingMap = useMemo(() => {
    const map = new Map<string, TerminalState>();
    for (const s of siblingTerminals ?? []) {
      map.set(s.id, s);
    }
    return map;
  }, [siblingTerminals]);
  const launchablePresets = presets.filter(
    (p) =>
      p.id !== PRESET_ID_BOARD &&
      !(p.interfaceMode === "gui" && guiSupportedAgent(p)),
  );

  const archivedCards = useMemo(
    () => board?.archivedCards ?? [],
    [board?.archivedCards],
  );
  // The backlog is the board's Backlog column. Settings > Kanban > Move backlog to shelf
  // only changes where it shows: in the shelf instead of on the board.
  const hasBacklogColumn = (board?.columns ?? []).some(isBacklogColumn);
  // The Backlog tab shows when the column is on the shelf.
  const showBacklog = backlogOnShelf && hasBacklogColumn;
  // Move to backlog is offered on a board that has a Backlog column.
  const canMoveToBacklog = hasBacklogColumn;
  const backlogCards = useMemo(
    () => (showBacklog ? (board?.cards ?? []).filter((c) => c.columnId === COLUMN_IDS.backlog) : []),
    [board?.cards, showBacklog],
  );
  // The columns drawn on the board: all of them, or all but Backlog while it is on the shelf.
  const boardColumns = useMemo(
    () => (showBacklog ? (board?.columns ?? []).filter((c) => !isBacklogColumn(c)) : (board?.columns ?? [])),
    [board?.columns, showBacklog],
  );

  // Collect distinct assignees/claims and labels on the board for quick filter bar
  const boardFilterOptions = useMemo(() => {
    const assignees = new Set<string>();
    const labels = new Set<string>();
    const priorities = new Set<KanbanPriority>();
    const sourceCards = archiveOpen
      ? [...(board?.cards ?? []), ...archivedCards]
      : (board?.cards ?? []);
    for (const c of sourceCards) {
      const owner = c.claim?.paneName ?? c.assignee;
      if (owner) assignees.add(owner);
      if (c.priority) priorities.add(c.priority);
      for (const l of c.labels ?? []) labels.add(l);
    }
    return {
      assignees: Array.from(assignees),
      labels: Array.from(labels),
      priorities: PRIORITY_OPTIONS.filter((p) => priorities.has(p.value)),
    };
  }, [archiveOpen, archivedCards, board?.cards]);

  const hasActiveFilter = Boolean(
    searchQuery.trim() || filterAssignee || filterPriority || filterLabel,
  );

  const matchesCardFilter = useCallback(
    (card: KanbanCard, isArchivedCard?: boolean): boolean => {
      if (filterPriority && card.priority !== filterPriority) return false;
      if (filterLabel) {
        const lower = filterLabel.toLowerCase();
        if (!card.labels?.some((l) => l.toLowerCase() === lower)) return false;
      }
      if (filterAssignee) {
        const owner = (card.claim?.paneName ?? card.assignee ?? "").toLowerCase();
        if (owner !== filterAssignee.toLowerCase()) return false;
      }
      return matchesSearchQuery(card, searchQuery, isArchivedCard);
    },
    [filterAssignee, filterLabel, filterPriority, searchQuery],
  );

  const clearAllFilters = () => {
    setSearchQuery("");
    setFilterAssignee(null);
    setFilterPriority(null);
    setFilterLabel(null);
  };

  const renderDescriptionToolbar = (target: "add" | "edit") => (
    <div className="aya-kanban-md-toolbar">
      <button
        type="button"
        className="aya-kanban-md-toolbtn"
        title="Insert hyperlink ([text](https://...))"
        onClick={() => handleInsertLink(target)}
      >
        🔗 Link
      </button>
      <button
        type="button"
        className="aya-kanban-md-toolbtn"
        title="Attach image file (or paste screenshot with ⌘V)"
        onClick={() => {
          fileInputTargetRef.current = target;
          fileInputRef.current?.click();
        }}
      >
        🖼 Image
      </button>
      <button
        type="button"
        className="aya-kanban-md-toolbtn"
        title="Insert checklist item (- [ ] ...)"
        onClick={() => insertIntoDescription(target, "- [ ] ")}
      >
        ☑ Checklist
      </button>
      <span
        className="aya-kanban-md-hint"
        title="Supports Markdown, links, checklists, and pasting screenshots (⌘V)"
      >
        Markdown · ⌘V image · ⌘↵ save
      </span>
    </div>
  );

  const renderPriorityAndLabelsRow = (target: "add" | "edit") => {
    const priorityVal = target === "add" ? newCardPriority : editPriority;
    const setPriorityVal =
      target === "add" ? setNewCardPriority : setEditPriority;
    const labelsVal = target === "add" ? newCardLabels : editLabels;
    const setLabelsVal = target === "add" ? setNewCardLabels : setEditLabels;
    const activeLabels = new Set(
      parseLabelsInput(labelsVal).map((l) => l.toLowerCase()),
    );
    return (
      <div className="aya-kanban-form-meta">
        <div className="aya-kanban-form-row">
          <select
            className="aya-kanban-select"
            aria-label="Card priority"
            value={priorityVal}
            onChange={(e) =>
              setPriorityVal(e.target.value as KanbanPriority | "")
            }
          >
            <option value="">Priority: None</option>
            {PRIORITY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.short} · {opt.label}
              </option>
            ))}
          </select>
          <input
            className="aya-kanban-input"
            placeholder="Labels (e.g. bug, feat)…"
            aria-label="Card labels"
            value={labelsVal}
            onChange={(e) => setLabelsVal(e.target.value)}
          />
        </div>
        <div className="aya-kanban-quick-labels">
          {QUICK_LABELS.map((lbl) => {
            const active = activeLabels.has(lbl);
            return (
              <button
                key={lbl}
                type="button"
                className={`aya-kanban-quick-label${active ? " aya-kanban-quick-label--active" : ""
                  }`}
                onClick={() =>
                  setLabelsVal(toggleLabelInDraft(labelsVal, lbl))
                }
              >
                +{lbl}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  const totalCardsCount = board?.cards.length ?? 0;
  const matchingCardsCount = useMemo(
    () =>
      board ? board.cards.filter((c) => matchesCardFilter(c, false)).length : 0,
    [board, matchesCardFilter],
  );
  const filteredArchivedCards = useMemo(
    () =>
      hasActiveFilter
        ? archivedCards.filter((c) => matchesCardFilter(c, true))
        : archivedCards,
    [archivedCards, hasActiveFilter, matchesCardFilter],
  );
  const filteredBacklogCards = useMemo(
    () =>
      hasActiveFilter
        ? backlogCards.filter((c) => matchesCardFilter(c, false))
        : backlogCards,
    [backlogCards, hasActiveFilter, matchesCardFilter],
  );

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
        <div className="aya-kanban-search-wrap">
          <input
            ref={searchInputRef}
            type="search"
            className="aya-kanban-search-input"
            placeholder="Filter cards… (/ or ⌘F)"
            title="Search by text, #label, @owner, p0-p3, col:name, or is:archived"
            aria-label="Filter cards"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                if (searchQuery) setSearchQuery("");
                else e.currentTarget.blur();
              }
            }}
          />
          {hasActiveFilter && (
            <button
              type="button"
              className="aya-kanban-search-clear"
              title="Clear all card filters"
              aria-label="Clear filters"
              onClick={clearAllFilters}
            >
              {matchingCardsCount}/{totalCardsCount} ×
            </button>
          )}
        </div>
        {board && (
          <>
            <span
              className={`aya-kanban-source-badge ${board.source === "repo" ? "aya-kanban-source-badge--repo" : ""
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
            {(archivedCards.length > 0 || backlogCards.length > 0 || archiveOpen) && (
              <button
                type="button"
                data-testid="kanban-archive-toggle"
                className={`aya-kanban-btn aya-kanban-archive-btn${archiveOpen ? " aya-kanban-archive-btn--active" : ""
                  }`}
                title="Toggle archived cards drawer"
                onClick={() => {
                  setArchiveOpen((prev) => !prev);
                  setConfirmEmptyArchive(false);
                }}
              >
                {showBacklog ? (
                  <span>
                    Shelf (
                    {hasActiveFilter
                      ? `${filteredArchivedCards.length + filteredBacklogCards.length}/${archivedCards.length + backlogCards.length}`
                      : archivedCards.length + backlogCards.length}
                    )
                  </span>
                ) : (
                  <span>
                    Archive (
                    {hasActiveFilter
                      ? `${filteredArchivedCards.length}/${archivedCards.length}`
                      : archivedCards.length}
                    )
                  </span>
                )}
              </button>
            )}
          </>
        )}
        {addingColumn ? (
          <span
            style={{ display: "inline-flex", gap: 4, alignItems: "center" }}
          >
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

  const showFilterStrip =
    hasActiveFilter ||
    boardFilterOptions.priorities.length > 0 ||
    boardFilterOptions.labels.length > 0 ||
    boardFilterOptions.assignees.length > 0;


  return {
    terminal,
    hidden,
    paneStyle,
    isActivePane,
    onActivatePane,
    headerSlot,
    siblingTerminals,
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
    archiveOpen,
    setArchiveOpen,
    confirmEmptyArchive,
    setConfirmEmptyArchive,
    previewImage,
    setPreviewImage,
    cardMenu,
    setCardMenu,
    cardMenuRef,
    draggingCardId,
    setDraggingCardId,
    dropTargetColId,
    setDropTargetColId,
    dropIndicator,
    setDropIndicator,
    addDescRef,
    editDescRef,
    fileInputRef,
    fileInputTargetRef,
    runAction,
    handleUndoDelete,
    openAddCard,
    saveAndInsertImageFile,
    handleTextareaPaste,
    handleTextareaDrop,
    handleMoveColumn,
    handleRenameColumn,
    handleDeleteColumn,
    handleClearColumn,
    handleArchiveCard,
    handleRestoreArchivedCard,
    handleDeleteArchivedCard,
    handleMoveToBacklog,
    handleRestoreBacklogCard,
    handleEmptyArchive,
    handleCreateCard,
    startEditCard,
    handleSaveCard,
    handleQuickSetPriority,
    handleToggleCardTaskItem,
    handleMoveCard,
    handleDeleteCard,
    handleStartCardInWorktree,
    openCardPopover,
    handleAddFormKeyDown,
    handleEditFormKeyDown,
    siblings,
    siblingMap,
    launchablePresets,
    archivedCards,
    backlogCards,
    showBacklog,
    canMoveToBacklog,
    boardColumns,
    boardFilterOptions,
    hasActiveFilter,
    matchesCardFilter,
    clearAllFilters,
    renderDescriptionToolbar,
    renderPriorityAndLabelsRow,
    filteredArchivedCards,
    filteredBacklogCards,
    headerNode,
    activeMenuCard,
    showFilterStrip,
  };
}
export type KanbanViewModel = ReturnType<typeof useKanbanBoard>;
