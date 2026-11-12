import {
  memo,
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
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PRESET_ID_BOARD } from "../preset-ids";
import { guiSupportedAgent } from "../agentPreset";
import type {
  BoardSnapshot,
  KanbanCard,
  KanbanColumn,
  KanbanPriority,
  Preset,
  TerminalState,
} from "../types";
import "./kanban.css";

const markdownPlugins = [remarkGfm];

const PRIORITY_OPTIONS: ReadonlyArray<{
  value: KanbanPriority;
  label: string;
  short: string;
}> = [
  { value: "urgent", label: "Urgent", short: "P0" },
  { value: "high", label: "High", short: "P1" },
  { value: "medium", label: "Medium", short: "P2" },
  { value: "low", label: "Low", short: "P3" },
];

const QUICK_LABELS: readonly string[] = [
  "bug",
  "feat",
  "refactor",
  "docs",
  "test",
];

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
}

function cleanIpcError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}

function columnDotClass(colId: string): string {
  if (
    colId === "todo" ||
    colId === "in-progress" ||
    colId === "review" ||
    colId === "done"
  ) {
    return `aya-kanban-column-dot aya-kanban-column-dot--${colId}`;
  }
  return "aya-kanban-column-dot";
}

function isSafeExternalHref(href: string | undefined): href is string {
  if (!href) return false;
  try {
    const parsed = new URL(href);
    return (
      parsed.protocol === "http:" ||
      parsed.protocol === "https:" ||
      parsed.protocol === "mailto:"
    );
  } catch {
    return false;
  }
}

export function toggleMarkdownTaskItem(
  markdown: string,
  targetIndex: number,
): string {
  let idx = 0;
  return markdown.replace(
    /^(\s*(?:[-*+]|\d+\.)\s+\[)([ xX])(\]\s.*)$/gm,
    (full, prefix: string, state: string, suffix: string) => {
      const current = idx;
      idx += 1;
      if (current !== targetIndex) return full;
      const nextState = state === " " ? "x" : " ";
      return `${prefix}${nextState}${suffix}`;
    },
  );
}

export function extractChecklistProgress(
  markdown: string | undefined,
): { completed: number; total: number } | null {
  if (!markdown) return null;
  let completed = 0;
  let total = 0;
  const re = /^\s*(?:[-*+]|\d+\.)\s+\[([ xX])\]\s/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    total += 1;
    if (match[1].toLowerCase() === "x") {
      completed += 1;
    }
  }
  return total > 0 ? { completed, total } : null;
}

function parseLabelsInput(raw: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    result.push(trimmed);
  }
  return result;
}

function toggleLabelInDraft(draft: string, label: string): string {
  const current = parseLabelsInput(draft);
  const lower = label.toLowerCase();
  const exists = current.some((l) => l.toLowerCase() === lower);
  const next = exists
    ? current.filter((l) => l.toLowerCase() !== lower)
    : [...current, label];
  return next.join(", ");
}

function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read image file."));
    reader.readAsDataURL(file);
  });
}

function livePaneDotInfo(pane: TerminalState | undefined): {
  modifier: string;
  label: string;
} {
  if (!pane) {
    return { modifier: "closed", label: "Terminal closed" };
  }
  const extLevel = pane.externalStatus?.level;
  const extText = pane.externalStatus?.text;
  if (extLevel === "waiting" || pane.bell) {
    return {
      modifier: "waiting",
      label: extText || "Waiting for user input",
    };
  }
  if (extLevel === "error" || pane.status === "error") {
    return { modifier: "error", label: extText || "Error" };
  }
  if (extLevel === "done") {
    return { modifier: "done", label: extText || "Finished turn" };
  }
  if (extLevel === "active" || pane.status === "running") {
    return { modifier: "working", label: extText || "Running" };
  }
  return { modifier: "idle", label: extText || "Idle" };
}

const KanbanBoardImage = memo(function KanbanBoardImage({
  projectSlug,
  src,
  alt,
  onPreview,
}: {
  projectSlug: string;
  src: string;
  alt: string;
  onPreview: (img: { src: string; alt: string }) => void;
}) {
  const isDirectUrl =
    /^https?:\/\//i.test(src) || /^data:image\//i.test(src);
  const [resolvedSrc, setResolvedSrc] = useState<string>(
    isDirectUrl ? src : "",
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (isDirectUrl) {
      setResolvedSrc(src);
      setFailed(false);
      return;
    }
    let active = true;
    setFailed(false);
    if (typeof window.aya?.readBoardImage === "function") {
      void window.aya
        .readBoardImage({ projectSlug, src })
        .then((dataUrl) => {
          if (active) setResolvedSrc(dataUrl);
        })
        .catch(() => {
          if (active) setFailed(true);
        });
    } else {
      setFailed(true);
    }
    return () => {
      active = false;
    };
  }, [isDirectUrl, projectSlug, src]);

  if (failed) {
    return (
      <span className="aya-kanban-md-img-missing" title={src}>
        🖼 {alt || src}
      </span>
    );
  }
  if (!resolvedSrc) {
    return <span className="aya-kanban-md-img-loading">Loading image…</span>;
  }
  return (
    <img
      src={resolvedSrc}
      alt={alt}
      className="aya-kanban-md-img"
      draggable={false}
      loading="lazy"
      title="Click to enlarge image"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onPreview({ src: resolvedSrc, alt: alt || "Image" });
      }}
      onError={() => setFailed(true)}
    />
  );
});

const KanbanCardMarkdown = memo(function KanbanCardMarkdown({
  projectSlug,
  text,
  onToggleTask,
  onPreviewImage,
}: {
  projectSlug: string;
  text: string;
  onToggleTask?: (checkboxIndex: number) => void;
  onPreviewImage: (img: { src: string; alt: string }) => void;
}) {
  const checkboxCounterRef = useRef(0);
  checkboxCounterRef.current = 0;

  const components = useMemo(
    () => ({
      a: ({
        href,
        children,
      }: {
        href?: string;
        children?: React.ReactNode;
      }) =>
        isSafeExternalHref(href) ? (
          <a
            href={href}
            className="aya-kanban-md-link"
            draggable={false}
            title={`Open ${href}`}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void window.aya.openUrl(href);
            }}
          >
            <span>{children}</span>
            <span className="aya-kanban-md-link-arrow" aria-hidden="true">
              ↗
            </span>
          </a>
        ) : (
          <span>{children}</span>
        ),
      img: ({ src, alt }: { src?: string; alt?: string }) => (
        <KanbanBoardImage
          projectSlug={projectSlug}
          src={String(src || "")}
          alt={alt || "Image"}
          onPreview={onPreviewImage}
        />
      ),
      input: ({
        type,
        checked,
      }: {
        type?: string;
        checked?: boolean;
      }) => {
        if (type !== "checkbox") return <input type={type} readOnly />;
        const idx = checkboxCounterRef.current;
        checkboxCounterRef.current += 1;
        return (
          <input
            type="checkbox"
            className="aya-kanban-md-checkbox"
            checked={Boolean(checked)}
            onChange={(e) => {
              e.stopPropagation();
              onToggleTask?.(idx);
            }}
            onClick={(e) => e.stopPropagation()}
          />
        );
      },
    }),
    [onPreviewImage, onToggleTask, projectSlug],
  );

  return (
    <div
      className="aya-kanban-md"
      onDoubleClick={(e) => {
        const target = e.target as HTMLElement | null;
        if (target?.closest("a, img, input, button")) {
          e.stopPropagation();
        }
      }}
    >
      <ReactMarkdown remarkPlugins={markdownPlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

export const KanbanView = memo(function KanbanView({
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
        const targetCol =
          board.columns.find((col) => !collapsedCols[col.id]) ??
          board.columns[0];
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
  }, [board, collapsedCols, handleUndoDelete, hidden, openAddCard, undoState]);

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
      const q = searchQuery.trim().toLowerCase();
      if (!q) return true;
      const isArchived =
        typeof isArchivedCard === "boolean"
          ? isArchivedCard
          : Boolean(card.archivedAt);
      const priorityTokenMap: Record<string, KanbanPriority> = {
        p0: "urgent",
        urgent: "urgent",
        p1: "high",
        high: "high",
        p2: "medium",
        medium: "medium",
        p3: "low",
        low: "low",
      };
      const tokens = q.split(/\s+/).filter(Boolean);
      for (const token of tokens) {
        if (token.startsWith("#") && token.length > 1) {
          const needle = token.slice(1);
          if (!card.labels?.some((l) => l.toLowerCase().includes(needle)))
            return false;
          continue;
        }
        if (
          (token.startsWith("label:") || token.startsWith("tag:")) &&
          token.includes(":")
        ) {
          const needle = token.slice(token.indexOf(":") + 1);
          if (needle && !card.labels?.some((l) => l.toLowerCase().includes(needle)))
            return false;
          continue;
        }
        if (token.startsWith("@") && token.length > 1) {
          const needle = token.slice(1);
          const assigneeMatch =
            card.assignee?.toLowerCase().includes(needle) ?? false;
          const claimMatch =
            card.claim?.paneName.toLowerCase().includes(needle) ?? false;
          if (!assigneeMatch && !claimMatch) return false;
          continue;
        }
        if (token.startsWith("assignee:") || token.startsWith("owner:")) {
          const needle = token.slice(token.indexOf(":") + 1);
          if (needle) {
            const assigneeMatch =
              card.assignee?.toLowerCase().includes(needle) ?? false;
            const claimMatch =
              card.claim?.paneName.toLowerCase().includes(needle) ?? false;
            if (!assigneeMatch && !claimMatch) return false;
          }
          continue;
        }
        if (
          token === "p0" ||
          token === "p1" ||
          token === "p2" ||
          token === "p3"
        ) {
          if (card.priority !== priorityTokenMap[token]) return false;
          continue;
        }
        if (token.startsWith("p:") || token.startsWith("priority:")) {
          const rawP = token.slice(token.indexOf(":") + 1);
          if (rawP) {
            const mapped = priorityTokenMap[rawP];
            if (mapped) {
              if (card.priority !== mapped) return false;
            } else if ((card.priority?.toLowerCase() ?? "") !== rawP) {
              return false;
            }
          }
          continue;
        }
        if (token.startsWith("col:") || token.startsWith("column:")) {
          const needle = token.slice(token.indexOf(":") + 1);
          if (needle && !card.columnId.toLowerCase().includes(needle))
            return false;
          continue;
        }
        if (token === "is:archived" || token === "in:archive") {
          if (!isArchived) return false;
          continue;
        }
        if (token === "is:active" || token === "is:open") {
          if (isArchived) return false;
          continue;
        }
        if (token === "is:claimed") {
          if (!card.claim) return false;
          continue;
        }
        if (token === "is:unassigned") {
          if (card.claim || card.assignee) return false;
          continue;
        }
        const matchesFreeText =
          card.id.toLowerCase().includes(token) ||
          card.title.toLowerCase().includes(token) ||
          (card.description?.toLowerCase().includes(token) ?? false) ||
          card.columnId.toLowerCase().includes(token) ||
          (card.assignee?.toLowerCase().includes(token) ?? false) ||
          (card.claim?.paneName.toLowerCase().includes(token) ?? false) ||
          (card.priority?.toLowerCase().includes(token) ?? false) ||
          (card.labels?.some((l) => l.toLowerCase().includes(token)) ?? false);
        if (!matchesFreeText) return false;
      }
      return true;
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
                className={`aya-kanban-quick-label${
                  active ? " aya-kanban-quick-label--active" : ""
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
            {(archivedCards.length > 0 || archiveOpen) && (
              <button
                type="button"
                data-testid="kanban-archive-toggle"
                className={`aya-kanban-btn aya-kanban-archive-btn${
                  archiveOpen ? " aya-kanban-archive-btn--active" : ""
                }`}
                title="Toggle archived cards drawer"
                onClick={() => {
                  setArchiveOpen((prev) => !prev);
                  setConfirmEmptyArchive(false);
                }}
              >
                <span>
                  Archive (
                  {hasActiveFilter
                    ? `${filteredArchivedCards.length}/${archivedCards.length}`
                    : archivedCards.length}
                  )
                </span>
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
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
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
              className={`aya-kanban-filter-chip aya-kanban-priority-badge--${p.value}${
                filterPriority === p.value
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
              className={`aya-kanban-filter-chip${
                filterLabel?.toLowerCase() === lbl.toLowerCase()
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
              className={`aya-kanban-filter-chip${
                filterAssignee?.toLowerCase() === owner.toLowerCase()
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
              className={`aya-kanban-filter-chip aya-kanban-filter-chip--archive${
                archiveOpen ? " aya-kanban-filter-chip--active" : ""
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
        <div className="aya-kanban-columns" ref={columnsRef}>
          {board.columns.map((col, colIndex) => {
            const allColCards = board.cards.filter(
              (c) => c.columnId === col.id,
            );
            const colCards = hasActiveFilter
              ? allColCards.filter((c) => matchesCardFilter(c, false))
              : allColCards;
            const isCollapsed = Boolean(collapsedCols[col.id]);
            const isDoneColumn =
              col.id === "done" || col.title.toLowerCase() === "done";
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
                  className={`aya-kanban-column aya-kanban-column--collapsed${
                    isDropTarget ? " aya-kanban-column--drop-target" : ""
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
                className={`aya-kanban-column${
                  isDropTarget ? " aya-kanban-column--drop-target" : ""
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
                      title={`Archive all ${allColCards.length} completed card${
                        allColCards.length === 1 ? "" : "s"
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
                    const isLongDesc =
                      Boolean(card.description) &&
                      (card.description!.length > 180 ||
                        card.description!.split(/\r?\n/).length > 4);
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
                          className={`aya-kanban-card${
                            card.claim ? " aya-kanban-card--claimed" : ""
                          }${
                            card.priority
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
                                  className={`aya-kanban-checklist-pill${
                                    checklist.completed === checklist.total
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
                                  className={`aya-kanban-iconbtn aya-kanban-iconbtn--danger${
                                    shiftDeleteReady
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
                                  className={`aya-kanban-label-pill${
                                    filterLabel?.toLowerCase() ===
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
                                className={`aya-kanban-card-desc${
                                  isExpanded
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
                                  className={`aya-kanban-pill aya-kanban-pill--claimed${
                                    dotInfo?.modifier === "closed"
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
                                      className={`aya-kanban-pill-dot aya-kanban-pill-dot--${
                                        dotInfo?.modifier ?? "working"
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
        </div>

        {archiveOpen && (
          <aside
            data-testid="kanban-archive-drawer"
            className="aya-kanban-archive-drawer"
          >
            <div className="aya-kanban-archive-header">
              <span className="aya-kanban-archive-title">
                Archive
                <span className="aya-kanban-column-count">
                  {hasActiveFilter
                    ? `${filteredArchivedCards.length}/${archivedCards.length}`
                    : archivedCards.length}
                </span>
              </span>
              <div className="aya-kanban-archive-actions">
                {archivedCards.length > 0 &&
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

            <div className="aya-kanban-archive-list">
              {filteredArchivedCards.length === 0 ? (
                <div className="aya-kanban-empty-col">
                  {hasActiveFilter
                    ? "No matching archived cards"
                    : "Archive is empty. Use Archive on the Done column to move completed cards here."}
                </div>
              ) : (
                filteredArchivedCards.map((card) => {
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
                  const archivedDate = card.archivedAt
                    ? new Date(card.archivedAt).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })
                    : null;

                  return (
                    <div
                      key={card.id}
                      data-testid={`kanban-archived-card-${card.id}`}
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
                            title={`Restore ${card.id} to ${
                              origCol ? origCol.title : "board"
                            }`}
                            onClick={() => void handleRestoreArchivedCard(card)}
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
                              className={`aya-kanban-iconbtn aya-kanban-iconbtn--danger${
                                shiftDeleteReady
                                  ? " aya-kanban-iconbtn--shift-ready"
                                  : ""
                              }`}
                              title={
                                shiftDeleteReady
                                  ? "Permanently delete card (Shift held)"
                                  : "Permanently delete from archive (hold Shift to skip confirmation)"
                              }
                              aria-label={`Delete archived card ${card.id}`}
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
                            className={`aya-kanban-card-desc${
                              isExpanded
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
                className={`aya-kanban-priority-chip aya-kanban-priority-badge--${
                  opt.value
                }${
                  activeMenuCard.priority === opt.value
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
