import type { KanbanCard,KanbanClaim,KanbanColumn,KanbanPriority } from '../shared/ipc-types';
export type { KanbanCard,KanbanClaim,KanbanColumn,KanbanPriority } from '../shared/ipc-types';
// Per-project Kanban board store and `aya board` CLI handler.
//
// Storage priority:
// 1. `<project.directory>/.aya/board.json` when present in the repository.
// 2. `<ayaHome>/boards/<project.slug>.json` in the user's Aya config directory.

import { randomBytes } from "node:crypto";
import { constants,promises as fs } from "node:fs";
import * as path from "node:path";
import { writeFileAtomic } from "./atomic-write";
import { displayBoardNotices,type BoardNotice } from "./board-notices";
import { oneAtATime } from "./keyed-queue";
import { inputMayHaveBeenWritten } from "./pane-input-outcome";
import { PROJECT_AYA_DIRNAME } from "./paths";
import {
  COLUMN_DEFINITIONS,
  DEFAULT_BOARD_COLUMNS as DICTIONARY_COLUMNS,
  FIXED_RULES,
  FINISHED_COLUMN_ID,
  STARTED_COLUMN_ID,
  isPendingColumn,
} from "../shared/board-columns.cjs";
import { BOARD_IMAGE_FORMATS, detectBoardImageFormat, listBoardImageFormats } from "../shared/board-images.cjs";
import { callerProject } from "./team-author";
import { slugifyName } from "./text";
import type { ProjectConfig } from "./types";

export const BOARDS_DIR_NAME = "boards";
export const BOARD_ASSETS_DIR_NAME = "board-assets";
export const REPO_BOARD_FILE_NAME = "board.json";
export const BOARD_FORMAT_VERSION = 1;
const BYTES_PER_MB = 1024 * 1024;
export const MAX_BOARD_FILE_BYTES = 2 * BYTES_PER_MB;
export const MAX_BOARD_IMAGE_BYTES = 8 * BYTES_PER_MB;
/** The image limit as users read it in messages. */
const MAX_BOARD_IMAGE_MB = MAX_BOARD_IMAGE_BYTES / BYTES_PER_MB;
/** A data URL of an accepted image format, in any letter case. */
const BOARD_IMAGE_DATA_URL = new RegExp(`^data:(?:${BOARD_IMAGE_FORMATS.map((format) => format.mime).join("|")});base64,`, "i");
export const MAX_BOARD_COLUMNS = 24;
export const MAX_BOARD_CARDS = 500;
export const MAX_COLUMN_TITLE_CHARS = 80;
export const MAX_CARD_TITLE_CHARS = 200;
export const MAX_CARD_DESCRIPTION_CHARS = 16_000;
export const MAX_ASSIGNEE_CHARS = 120;
export const MAX_CARD_LABELS = 12;
export const MAX_CARD_LABEL_CHARS = 32;

const SLUG_RE = /^[a-z0-9_-]{1,80}$/;
const ID_RE = /^[a-z0-9_-]{1,64}$/i;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const serial = oneAtATime();

export const VALID_KANBAN_PRIORITIES: readonly KanbanPriority[] = [
  "low",
  "medium",
  "high",
  "urgent",
];

export interface BoardSnapshot {
  version: 1;
  projectSlug: string;
  source: "repo" | "user";
  filePath: string;
  columns: KanbanColumn[];
  cards: KanbanCard[];
  notices?: BoardNotice[];
  archivedCards?: KanbanCard[];
}

interface StoredBoard {
  version: 1;
  columns: KanbanColumn[];
  cards: KanbanCard[];
  archivedCards?: KanbanCard[];
}

/** The columns a new board starts with; defined in the column dictionary (shared/board-columns.cjs). */
export const DEFAULT_BOARD_COLUMNS: readonly KanbanColumn[] = DICTIONARY_COLUMNS;

type BoardChangeListener = (projectSlug: string) => void;
const listeners = new Set<BoardChangeListener>();

interface BoardTaskWithdrawal {
  ayaHome: string;
  projectSlug: string;
  card: KanbanCard;
  claim: KanbanClaim;
  reason: string;
}
const withdrawalListeners = new Set<(event: BoardTaskWithdrawal) => Promise<void>>();

/** Persist the notice before changing the claim; delivery rechecks the committed board. */
export function onBoardTaskWithdrawal(listener: (event: BoardTaskWithdrawal) => Promise<void>): () => void {
  withdrawalListeners.add(listener);
  return () => { withdrawalListeners.delete(listener); };
}

async function notifyTaskWithdrawal(ayaHome: string, projectSlug: string, card: KanbanCard, reason: string, actorPaneId?: string): Promise<void> {
  if (!card.claim || card.claim.startup === "reserved" || actorPaneId && actorPaneId === card.claim.paneId) return;
  for (const listener of withdrawalListeners) {
    await listener({ ayaHome, projectSlug, card, claim: card.claim, reason });
  }
}

async function withdrawToPendingColumn(ayaHome: string, projectSlug: string, target: KanbanCard, updated: KanbanCard, column: KanbanColumn, actorPaneId?: string): Promise<void> {
  if (!target.claim || target.columnId === column.id || !isPendingColumn(column.id)) return;
  await notifyTaskWithdrawal(ayaHome, projectSlug, target, `returned to ${column.title}`, actorPaneId);
  delete updated.claim;
}

export function onBoardChanged(listener: BoardChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyBoardChanged(projectSlug: string): void {
  for (const listener of listeners) {
    try {
      listener(projectSlug);
    } catch {
      // Listener errors must never fail a board mutation.
    }
  }
}

export function userBoardFile(ayaHome: string, projectSlug: string): string {
  if (!SLUG_RE.test(projectSlug)) {
    throw new Error("Invalid project slug for Kanban board.");
  }
  return path.join(ayaHome, BOARDS_DIR_NAME, `${projectSlug}.json`);
}

export function repoBoardFile(projectDirectory: string): string {
  return path.join(projectDirectory, PROJECT_AYA_DIRNAME, REPO_BOARD_FILE_NAME);
}

async function hasRepoBoardFile(projectDirectory: string): Promise<boolean> {
  const ayaDir = path.join(projectDirectory, PROJECT_AYA_DIRNAME);
  try {
    const dirStat = await fs.lstat(ayaDir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return false;
    const fileStat = await fs.lstat(path.join(ayaDir, REPO_BOARD_FILE_NAME));
    return fileStat.isFile() && !fileStat.isSymbolicLink();
  } catch {
    return false;
  }
}

function isColumn(value: unknown): value is KanbanColumn {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const col = value as Record<string, unknown>;
  return (
    typeof col.id === "string" &&
    ID_RE.test(col.id) &&
    typeof col.title === "string" &&
    col.title.trim().length > 0 &&
    col.title.length <= MAX_COLUMN_TITLE_CHARS &&
    !CONTROL_CHARS.test(col.title)
  );
}

function isClaim(value: unknown): value is KanbanClaim {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const claim = value as Record<string, unknown>;
  return (
    (claim.paneId === undefined || (typeof claim.paneId === "string" && claim.paneId.length <= 120 && !CONTROL_CHARS.test(claim.paneId))) &&
    typeof claim.paneName === "string" &&
    claim.paneName.trim().length > 0 &&
    claim.paneName.length <= MAX_ASSIGNEE_CHARS &&
    !CONTROL_CHARS.test(claim.paneName) &&
    typeof claim.since === "string" &&
    Number.isFinite(Date.parse(claim.since)) &&
    (claim.startup === undefined || ["reserved", "sending", "sent"].includes(claim.startup as string))
  );
}

function isCard(value: unknown, columnIds?: ReadonlySet<string>): value is KanbanCard {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const card = value as Record<string, unknown>;
  if (
    typeof card.id !== "string" ||
    !ID_RE.test(card.id) ||
    typeof card.columnId !== "string" ||
    (columnIds ? !columnIds.has(card.columnId) : !ID_RE.test(card.columnId)) ||
    typeof card.title !== "string" ||
    card.title.trim().length === 0 ||
    card.title.length > MAX_CARD_TITLE_CHARS ||
    CONTROL_CHARS.test(card.title) ||
    typeof card.createdAt !== "string" ||
    !Number.isFinite(Date.parse(card.createdAt)) ||
    typeof card.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(card.updatedAt))
  ) {
    return false;
  }
  if (
    card.archivedAt !== undefined &&
    (typeof card.archivedAt !== "string" || !Number.isFinite(Date.parse(card.archivedAt)))
  ) {
    return false;
  }
  if (
    card.description !== undefined &&
    (typeof card.description !== "string" || card.description.length > MAX_CARD_DESCRIPTION_CHARS)
  ) {
    return false;
  }
  if (
    card.assignee !== undefined &&
    (typeof card.assignee !== "string" || card.assignee.length > MAX_ASSIGNEE_CHARS || CONTROL_CHARS.test(card.assignee))
  ) {
    return false;
  }
  if (
    card.priority !== undefined &&
    (typeof card.priority !== "string" || !VALID_KANBAN_PRIORITIES.includes(card.priority as KanbanPriority))
  ) {
    return false;
  }
  if (card.labels !== undefined) {
    if (
      !Array.isArray(card.labels) ||
      card.labels.length > MAX_CARD_LABELS ||
      !card.labels.every(
        (label) =>
          typeof label === "string" &&
          label.trim().length > 0 &&
          label.length <= MAX_CARD_LABEL_CHARS &&
          !CONTROL_CHARS.test(label),
      )
    ) {
      return false;
    }
  }
  if (card.claim !== undefined && !isClaim(card.claim)) {
    return false;
  }
  return true;
}

function normalizeStoredCard(c: KanbanCard, includeArchivedAt: boolean): KanbanCard {
  const cleanedLabels = cleanLabels(c.labels);
  return {
    id: c.id,
    columnId: c.columnId,
    title: c.title.trim(),
    ...(c.description && c.description.trim() ? { description: c.description.trim() } : {}),
    ...(c.assignee && c.assignee.trim() ? { assignee: c.assignee.trim() } : {}),
    ...(c.priority ? { priority: c.priority } : {}),
    ...(cleanedLabels ? { labels: cleanedLabels } : {}),
    ...(c.claim
      ? {
          claim: {
            ...(c.claim.paneId ? { paneId: c.claim.paneId } : {}),
            paneName: c.claim.paneName.trim(),
            since: c.claim.since,
            ...(c.claim.startup ? { startup: c.claim.startup } : {}),
          },
        }
      : {}),
    ...(includeArchivedAt ? { archivedAt: c.archivedAt ?? c.updatedAt } : {}),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

function parseStoredBoard(raw: string, fileLabel: string): StoredBoard {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${fileLabel} is not valid JSON; nothing was changed.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${fileLabel} is not a valid Kanban board object; nothing was changed.`);
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== BOARD_FORMAT_VERSION) {
    throw new Error(`${fileLabel} has unsupported version ${String(record.version)}; nothing was changed.`);
  }
  if (!Array.isArray(record.columns) || record.columns.length === 0 || record.columns.length > MAX_BOARD_COLUMNS) {
    throw new Error(`${fileLabel} has an invalid columns list; nothing was changed.`);
  }
  if (!record.columns.every(isColumn)) {
    throw new Error(`${fileLabel} has invalid column definitions; nothing was changed.`);
  }
  const columns = record.columns.map((c) => ({ id: c.id, title: c.title.trim() }));
  const colIds = new Set(columns.map((c) => c.id));
  if (colIds.size !== columns.length) {
    throw new Error(`${fileLabel} has duplicate column ids; nothing was changed.`);
  }
  if (!Array.isArray(record.cards) || record.cards.length > MAX_BOARD_CARDS) {
    throw new Error(`${fileLabel} has an invalid cards list; nothing was changed.`);
  }
  if (!record.cards.every((c) => isCard(c, colIds))) {
    throw new Error(`${fileLabel} has invalid card entries; nothing was changed.`);
  }
  const cards = (record.cards as KanbanCard[]).map((c) => normalizeStoredCard(c, false));
  const activeCardIds = new Set(cards.map((c) => c.id.toLowerCase()));
  if (activeCardIds.size !== cards.length) {
    throw new Error(`${fileLabel} has duplicate card ids; nothing was changed.`);
  }
  let archivedCards: KanbanCard[] | undefined;
  if (record.archivedCards !== undefined) {
    if (!Array.isArray(record.archivedCards) || record.archivedCards.length > MAX_BOARD_CARDS) {
      throw new Error(`${fileLabel} has an invalid archivedCards list; nothing was changed.`);
    }
    if (!record.archivedCards.every((c) => isCard(c))) {
      throw new Error(`${fileLabel} has invalid archived card entries; nothing was changed.`);
    }
    const seenArchived = new Set<string>(activeCardIds);
    archivedCards = [];
    for (const rawArch of record.archivedCards as KanbanCard[]) {
      const lower = rawArch.id.toLowerCase();
      if (seenArchived.has(lower)) continue;
      seenArchived.add(lower);
      archivedCards.push(normalizeStoredCard(rawArch, true));
    }
  }
  return {
    version: BOARD_FORMAT_VERSION,
    columns,
    cards,
    ...(archivedCards && archivedCards.length > 0 ? { archivedCards } : {}),
  };
}

async function readBoundedRegularFile(filePath: string): Promise<string | null> {
  let handle;
  try {
    handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Aya could not open ${filePath}. Nothing was changed.`);
  }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size > MAX_BOARD_FILE_BYTES) {
      throw new Error(`${filePath} is not a regular file within the size limit. Nothing was changed.`);
    }
    const buffer = Buffer.alloc(MAX_BOARD_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BOARD_FILE_BYTES) {
      throw new Error(`${filePath} exceeds the size limit. Nothing was changed.`);
    }
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function defaultStoredBoard(): StoredBoard {
  return {
    version: BOARD_FORMAT_VERSION,
    columns: DEFAULT_BOARD_COLUMNS.map((c) => ({ ...c })),
    cards: [],
  };
}

async function loadBoardUnlocked(
  ayaHome: string,
  project: Pick<ProjectConfig, "slug" | "directory">,
): Promise<BoardSnapshot> {
  const notices = await displayBoardNotices(ayaHome, project.slug);
  if (await hasRepoBoardFile(project.directory)) {
    const filePath = repoBoardFile(project.directory);
    const raw = await readBoundedRegularFile(filePath);
    const stored = raw !== null ? parseStoredBoard(raw, filePath) : defaultStoredBoard();
    return {
      version: BOARD_FORMAT_VERSION,
      projectSlug: project.slug,
      source: "repo",
      filePath,
      columns: stored.columns,
      cards: stored.cards,
      ...(notices.length ? { notices } : {}),
      archivedCards: stored.archivedCards ?? [],
    };
  }
  const filePath = userBoardFile(ayaHome, project.slug);
  const raw = await readBoundedRegularFile(filePath);
  const stored = raw !== null ? parseStoredBoard(raw, filePath) : defaultStoredBoard();
  return {
    version: BOARD_FORMAT_VERSION,
    projectSlug: project.slug,
    source: "user",
    filePath,
    columns: stored.columns,
    cards: stored.cards,
    ...(notices.length ? { notices } : {}),
    archivedCards: stored.archivedCards ?? [],
  };
}

async function saveBoardUnlocked(
  ayaHome: string,
  project: Pick<ProjectConfig, "slug" | "directory">,
  stored: StoredBoard,
  forceSource?: "repo" | "user",
): Promise<BoardSnapshot> {
  const useRepo = forceSource ? forceSource === "repo" : await hasRepoBoardFile(project.directory);
  const filePath = useRepo ? repoBoardFile(project.directory) : userBoardFile(ayaHome, project.slug);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: useRepo ? 0o755 : 0o700 });
  const dirStat = await fs.lstat(dir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    throw new Error(`${dir} is not a regular directory; nothing was saved.`);
  }
  const archivedCards =
    stored.archivedCards && stored.archivedCards.length > 0 ? stored.archivedCards : undefined;
  const text = `${JSON.stringify(
    {
      version: BOARD_FORMAT_VERSION,
      columns: stored.columns,
      cards: stored.cards,
      ...(archivedCards ? { archivedCards } : {}),
    },
    null,
    2,
  )}\n`;
  if (Buffer.byteLength(text, "utf8") > MAX_BOARD_FILE_BYTES) {
    throw new Error("The Kanban board is too large to save.");
  }
  await writeFileAtomic(filePath, text, useRepo ? 0o644 : 0o600);
  const notices = await displayBoardNotices(ayaHome, project.slug);
  return {
    version: BOARD_FORMAT_VERSION,
    projectSlug: project.slug,
    source: useRepo ? "repo" : "user",
    filePath,
    columns: stored.columns,
    cards: stored.cards,
    ...(notices.length ? { notices } : {}),
    archivedCards: archivedCards ?? [],
  };
}

function nextCardId(
  cards: readonly KanbanCard[],
  archivedCards: readonly KanbanCard[] = [],
): string {
  const all = [...cards, ...archivedCards];
  let max = 0;
  for (const card of all) {
    const match = /^t-(\d+)$/i.exec(card.id);
    if (match) {
      const n = Number(match[1]);
      if (Number.isSafeInteger(n) && n > max) max = n;
    }
  }
  let candidate = max + 1;
  const existing = new Set(all.map((c) => c.id.toLowerCase()));
  while (existing.has(`t-${candidate}`)) candidate += 1;
  return `t-${candidate}`;
}

export function resolveColumn(columns: readonly KanbanColumn[], query: string): KanbanColumn {
  const trimmed = query.trim();
  const lower = trimmed.toLowerCase();
  const slug = slugifyName(trimmed, "");
  const found =
    columns.find((c) => c.id.toLowerCase() === lower) ??
    columns.find((c) => c.title.toLowerCase() === lower) ??
    (slug ? columns.find((c) => c.id.toLowerCase() === slug) : undefined);
  if (!found) {
    throw new Error(
      `no column "${query}"; columns: ${columns.map((c) => `${c.id} (${c.title})`).join(", ")}`,
    );
  }
  return found;
}

export function resolveCard(cards: readonly KanbanCard[], query: string): KanbanCard {
  const trimmed = query.trim();
  const lower = trimmed.toLowerCase();
  const found =
    cards.find((c) => c.id.toLowerCase() === lower) ??
    (/^\d+$/.test(trimmed) ? cards.find((c) => c.id.toLowerCase() === `t-${trimmed}`) : undefined);
  if (!found) {
    throw new Error(
      cards.length > 0
        ? `no card "${query}"; cards: ${cards.map((c) => c.id).join(", ")}`
        : `no card "${query}"; the board has no cards yet`,
    );
  }
  return found;
}

function cleanCardTitle(title: string): string {
  const trimmed = title.replace(/\s+/g, " ").trim();
  if (!trimmed) throw new Error("Card title cannot be empty.");
  if (CONTROL_CHARS.test(trimmed)) throw new Error("Card title must be plain text.");
  if (trimmed.length > MAX_CARD_TITLE_CHARS) {
    throw new Error(`Card title is ${trimmed.length} characters; the maximum is ${MAX_CARD_TITLE_CHARS}.`);
  }
  return trimmed;
}

function cleanColumnTitle(title: string): string {
  const trimmed = title.replace(/\s+/g, " ").trim();
  if (!trimmed) throw new Error("Column title cannot be empty.");
  if (CONTROL_CHARS.test(trimmed)) throw new Error("Column title must be plain text.");
  if (trimmed.length > MAX_COLUMN_TITLE_CHARS) {
    throw new Error(`Column title is ${trimmed.length} characters; the maximum is ${MAX_COLUMN_TITLE_CHARS}.`);
  }
  return trimmed;
}

function cleanDescription(description: string | undefined): string | undefined {
  if (description === undefined) return undefined;
  const trimmed = description.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_CARD_DESCRIPTION_CHARS) {
    throw new Error(`Card description is ${trimmed.length} characters; the maximum is ${MAX_CARD_DESCRIPTION_CHARS}.`);
  }
  return trimmed;
}

function cleanAssignee(assignee: string | undefined): string | undefined {
  if (assignee === undefined) return undefined;
  const trimmed = assignee.replace(/\s+/g, " ").trim();
  if (!trimmed || trimmed.toLowerCase() === "none") return undefined;
  if (CONTROL_CHARS.test(trimmed)) throw new Error("Assignee must be plain text.");
  if (trimmed.length > MAX_ASSIGNEE_CHARS) {
    throw new Error(`Assignee is ${trimmed.length} characters; the maximum is ${MAX_ASSIGNEE_CHARS}.`);
  }
  return trimmed;
}

function cleanPriority(priority: string | undefined | null): KanbanPriority | undefined {
  if (priority === undefined || priority === null) return undefined;
  const trimmed = priority.trim().toLowerCase();
  if (!trimmed || trimmed === "none") return undefined;
  if (!VALID_KANBAN_PRIORITIES.includes(trimmed as KanbanPriority)) {
    throw new Error(`Invalid priority "${priority}"; choose one of: ${VALID_KANBAN_PRIORITIES.join(", ")}.`);
  }
  return trimmed as KanbanPriority;
}

function cleanLabels(labels: readonly string[] | string | undefined | null): string[] | undefined {
  if (labels === undefined || labels === null) return undefined;
  const rawList = typeof labels === "string" ? labels.split(",") : labels;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of rawList) {
    if (typeof item !== "string") continue;
    const trimmed = item.replace(/\s+/g, " ").trim().replace(/^#+/, "").trim();
    if (!trimmed || trimmed.toLowerCase() === "none") continue;
    if (CONTROL_CHARS.test(trimmed)) throw new Error("Card label must be plain text.");
    if (trimmed.length > MAX_CARD_LABEL_CHARS) {
      throw new Error(`Card label "${trimmed}" exceeds maximum length of ${MAX_CARD_LABEL_CHARS}.`);
    }
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(trimmed);
  }
  if (out.length > MAX_CARD_LABELS) {
    throw new Error(`Card has ${out.length} labels; the maximum is ${MAX_CARD_LABELS}.`);
  }
  return out.length > 0 ? out : undefined;
}

export function getBoard(
  ayaHome: string,
  project: Pick<ProjectConfig, "slug" | "directory">,
): Promise<BoardSnapshot> {
  return serial(project.slug, () => loadBoardUnlocked(ayaHome, project));
}

export function addBoardCard(
  ayaHome: string,
  project: Pick<ProjectConfig, "slug" | "directory">,
  input: {
    id?: string;
    title: string;
    description?: string;
    columnId?: string;
    assignee?: string;
    priority?: KanbanPriority | string;
    labels?: string[] | string;
    index?: number;
    now?: Date;
  },
): Promise<{ board: BoardSnapshot; card: KanbanCard }> {
  return serial(project.slug, async () => {
    const current = await loadBoardUnlocked(ayaHome, project);
    if (current.cards.length >= MAX_BOARD_CARDS) {
      throw new Error(`The board already has the maximum of ${MAX_BOARD_CARDS} cards.`);
    }
    const title = cleanCardTitle(input.title);
    const description = cleanDescription(input.description);
    const assignee = cleanAssignee(input.assignee);
    const priority = cleanPriority(input.priority);
    const labels = cleanLabels(input.labels);
    const column = input.columnId
      ? resolveColumn(current.columns, input.columnId)
      : current.columns[0];
    if (!column) throw new Error("The board has no columns.");
    const iso = (input.now ?? new Date()).toISOString();
    const existingIds = new Set(
      [...current.cards, ...(current.archivedCards ?? [])].map((c) => c.id.toLowerCase()),
    );
    const customId =
      input.id && ID_RE.test(input.id.trim()) && !existingIds.has(input.id.trim().toLowerCase())
        ? input.id.trim()
        : undefined;
    const card: KanbanCard = {
      id: customId ?? nextCardId(current.cards, current.archivedCards),
      columnId: column.id,
      title,
      ...(description ? { description } : {}),
      ...(assignee ? { assignee } : {}),
      ...(priority ? { priority } : {}),
      ...(labels ? { labels } : {}),
      createdAt: iso,
      updatedAt: iso,
    };
    let cards: KanbanCard[];
    if (typeof input.index === "number" && Number.isInteger(input.index) && input.index >= 0) {
      const inCol = current.cards.filter((c) => c.columnId === column.id);
      const clamped = Math.min(input.index, inCol.length);
      if (clamped === inCol.length) {
        cards = [...current.cards, card];
      } else {
        const beforeCard = inCol[clamped];
        const insertAt = current.cards.findIndex((c) => c.id === beforeCard.id);
        cards = [...current.cards.slice(0, insertAt), card, ...current.cards.slice(insertAt)];
      }
    } else {
      cards = [...current.cards, card];
    }
    const board = await saveBoardUnlocked(ayaHome, project, {
      version: BOARD_FORMAT_VERSION,
      columns: current.columns,
      cards,
      archivedCards: current.archivedCards,
    });
    notifyBoardChanged(project.slug);
    return { board, card };
  });
}

export function updateBoardCard(
  ayaHome: string,
  project: Pick<ProjectConfig, "slug" | "directory">,
  cardId: string,
  patch: {
    title?: string;
    description?: string;
    columnId?: string;
    assignee?: string | null;
    actorPaneId?: string;
    priority?: KanbanPriority | string | null;
    labels?: string[] | string | null;
    now?: Date;
  },
): Promise<{ board: BoardSnapshot; card: KanbanCard }> {
  return serial(project.slug, async () => {
    const current = await loadBoardUnlocked(ayaHome, project);
    const target = resolveCard(current.cards, cardId);
    const column = patch.columnId ? resolveColumn(current.columns, patch.columnId) : undefined;
    const title = patch.title !== undefined ? cleanCardTitle(patch.title) : target.title;
    const description =
      patch.description !== undefined ? cleanDescription(patch.description) : target.description;
    const assignee =
      patch.assignee === null
        ? undefined
        : patch.assignee !== undefined
          ? cleanAssignee(patch.assignee)
          : target.assignee;
    const priority =
      patch.priority === null
        ? undefined
        : patch.priority !== undefined
          ? cleanPriority(patch.priority)
          : target.priority;
    const labels =
      patch.labels === null
        ? undefined
        : patch.labels !== undefined
          ? cleanLabels(patch.labels)
          : target.labels;
    const updated: KanbanCard = {
      ...target,
      columnId: column ? column.id : target.columnId,
      title,
      updatedAt: (patch.now ?? new Date()).toISOString(),
    };
    if (description) updated.description = description;
    else delete updated.description;
    if (assignee) updated.assignee = assignee;
    else delete updated.assignee;
    if (priority) updated.priority = priority;
    else delete updated.priority;
    if (labels && labels.length > 0) updated.labels = labels;
    else delete updated.labels;
    if (column) await withdrawToPendingColumn(ayaHome, project.slug, target, updated, column, patch.actorPaneId);
    const cards = current.cards.map((c) => (c.id === target.id ? updated : c));
    const board = await saveBoardUnlocked(ayaHome, project, {
      version: BOARD_FORMAT_VERSION,
      columns: current.columns,
      cards,
      archivedCards: current.archivedCards,
    });
    notifyBoardChanged(project.slug);
    return { board, card: updated };
  });
}

export function moveBoardCard(
  ayaHome: string,
  project: Pick<ProjectConfig, "slug" | "directory">,
  cardId: string,
  columnQuery: string,
  targetIndex?: number,
  now?: Date,
  actorPaneId?: string,
): Promise<{ board: BoardSnapshot; card: KanbanCard }> {
  return serial(project.slug, async () => {
    const current = await loadBoardUnlocked(ayaHome, project);
    const target = resolveCard(current.cards, cardId);
    const column = resolveColumn(current.columns, columnQuery);
    const updated: KanbanCard = {
      ...target,
      columnId: column.id,
      updatedAt: (now ?? new Date()).toISOString(),
    };
    await withdrawToPendingColumn(ayaHome, project.slug, target, updated, column, actorPaneId);
    const remaining = current.cards.filter((c) => c.id !== target.id);
    let cards: KanbanCard[];
    if (typeof targetIndex === "number" && Number.isInteger(targetIndex) && targetIndex >= 0) {
      const inCol = remaining.filter((c) => c.columnId === column.id);
      const clamped = Math.min(targetIndex, inCol.length);
      if (clamped === inCol.length) {
        cards = [...remaining, updated];
      } else {
        const beforeCard = inCol[clamped];
        const insertAt = remaining.findIndex((c) => c.id === beforeCard.id);
        cards = [...remaining.slice(0, insertAt), updated, ...remaining.slice(insertAt)];
      }
    } else {
      cards = [...remaining, updated];
    }
    const board = await saveBoardUnlocked(ayaHome, project, {
      version: BOARD_FORMAT_VERSION,
      columns: current.columns,
      cards,
      archivedCards: current.archivedCards,
    });
    notifyBoardChanged(project.slug);
    return { board, card: updated };
  });
}

export function archiveBoardCard(
  ayaHome: string,
  project: Pick<ProjectConfig, "slug" | "directory">,
  cardId: string,
  now?: Date,
  actorPaneId?: string,
): Promise<{ board: BoardSnapshot; archived: KanbanCard }> {
  return serial(project.slug, async () => {
    const current = await loadBoardUnlocked(ayaHome, project);
    const target = resolveCard(current.cards, cardId);
    await notifyTaskWithdrawal(ayaHome, project.slug, target, "removed from the board", actorPaneId);
    const nowIso = (now ?? new Date()).toISOString();
    const archived: KanbanCard = {
      ...target,
      updatedAt: nowIso,
      archivedAt: nowIso,
    };
    delete archived.claim;
    const cards = current.cards.filter((c) => c.id !== target.id);
    const existingArchived = (current.archivedCards ?? []).filter(
      (c) => c.id.toLowerCase() !== target.id.toLowerCase(),
    );
    const archivedCards = [archived, ...existingArchived].slice(0, MAX_BOARD_CARDS);
    const board = await saveBoardUnlocked(ayaHome, project, {
      version: BOARD_FORMAT_VERSION,
      columns: current.columns,
      cards,
      archivedCards,
    });
    notifyBoardChanged(project.slug);
    return { board, archived };
  });
}

export function unarchiveBoardCard(
  ayaHome: string,
  project: Pick<ProjectConfig, "slug" | "directory">,
  cardId: string,
  columnQuery?: string,
  now?: Date,
): Promise<{ board: BoardSnapshot; card: KanbanCard }> {
  return serial(project.slug, async () => {
    const current = await loadBoardUnlocked(ayaHome, project);
    const archivedList = current.archivedCards ?? [];
    const target = resolveCard(archivedList, cardId);
    if (current.cards.length >= MAX_BOARD_CARDS) {
      throw new Error(`The board already has the maximum of ${MAX_BOARD_CARDS} cards.`);
    }
    const col = columnQuery
      ? resolveColumn(current.columns, columnQuery)
      : current.columns.find((c) => c.id === target.columnId) ?? current.columns[0];
    if (!col) throw new Error("The board has no columns.");
    const nowIso = (now ?? new Date()).toISOString();
    const restored: KanbanCard = {
      ...target,
      columnId: col.id,
      updatedAt: nowIso,
    };
    delete restored.archivedAt;
    delete restored.claim;
    const archivedCards = archivedList.filter((c) => c.id !== target.id);
    const cards = [...current.cards, restored];
    const board = await saveBoardUnlocked(ayaHome, project, {
      version: BOARD_FORMAT_VERSION,
      columns: current.columns,
      cards,
      archivedCards,
    });
    notifyBoardChanged(project.slug);
    return { board, card: restored };
  });
}

export function deleteBoardCard(
  ayaHome: string,
  project: Pick<ProjectConfig, "slug" | "directory">,
  cardId: string,
  optionsOrActorPaneId?: string | { archive?: boolean; now?: Date; actorPaneId?: string },
): Promise<{ board: BoardSnapshot; deleted: KanbanCard }> {
  const options =
    typeof optionsOrActorPaneId === "string"
      ? { actorPaneId: optionsOrActorPaneId }
      : optionsOrActorPaneId;
  if (options?.archive) {
    return archiveBoardCard(ayaHome, project, cardId, options.now, options.actorPaneId).then(
      ({ board, archived }) => ({
        board,
        deleted: archived,
      }),
    );
  }
  return serial(project.slug, async () => {
    const current = await loadBoardUnlocked(ayaHome, project);
    const trimmed = cardId.trim();
    const lower = trimmed.toLowerCase();
    const activeTarget =
      current.cards.find((c) => c.id.toLowerCase() === lower) ??
      (/^\d+$/.test(trimmed)
        ? current.cards.find((c) => c.id.toLowerCase() === `t-${trimmed}`)
        : undefined);
    if (activeTarget) {
      await notifyTaskWithdrawal(
        ayaHome,
        project.slug,
        activeTarget,
        "removed from the board",
        options?.actorPaneId,
      );
      const cards = current.cards.filter((c) => c.id !== activeTarget.id);
      const board = await saveBoardUnlocked(ayaHome, project, {
        version: BOARD_FORMAT_VERSION,
        columns: current.columns,
        cards,
        archivedCards: current.archivedCards,
      });
      notifyBoardChanged(project.slug);
      return { board, deleted: activeTarget };
    }
    const archivedList = current.archivedCards ?? [];
    const archivedTarget =
      archivedList.find((c) => c.id.toLowerCase() === lower) ??
      (/^\d+$/.test(trimmed)
        ? archivedList.find((c) => c.id.toLowerCase() === `t-${trimmed}`)
        : undefined);
    if (archivedTarget) {
      const archivedCards = archivedList.filter((c) => c.id !== archivedTarget.id);
      const board = await saveBoardUnlocked(ayaHome, project, {
        version: BOARD_FORMAT_VERSION,
        columns: current.columns,
        cards: current.cards,
        archivedCards,
      });
      notifyBoardChanged(project.slug);
      return { board, deleted: archivedTarget };
    }
    const target = resolveCard(current.cards, cardId);
    return { board: current, deleted: target };
  });
}

export function clearBoardColumn(
  ayaHome: string,
  project: Pick<ProjectConfig, "slug" | "directory">,
  columnQuery: string,
  options?: { archive?: boolean; now?: Date; actorPaneId?: string },
): Promise<{ board: BoardSnapshot; deleted: KanbanCard[] }> {
  return serial(project.slug, async () => {
    const current = await loadBoardUnlocked(ayaHome, project);
    if (columnQuery.trim() === "__archive__") {
      const deleted = current.archivedCards ?? [];
      if (deleted.length === 0) {
        return { board: current, deleted: [] };
      }
      const board = await saveBoardUnlocked(ayaHome, project, {
        version: BOARD_FORMAT_VERSION,
        columns: current.columns,
        cards: current.cards,
        archivedCards: [],
      });
      notifyBoardChanged(project.slug);
      return { board, deleted };
    }
    const targetCol = resolveColumn(current.columns, columnQuery);
    const deleted = current.cards.filter((c) => c.columnId === targetCol.id);
    if (deleted.length === 0) {
      return { board: current, deleted: [] };
    }
    for (const card of deleted) {
      await notifyTaskWithdrawal(
        ayaHome,
        project.slug,
        card,
        "removed from the board",
        options?.actorPaneId,
      );
    }
    const cards = current.cards.filter((c) => c.columnId !== targetCol.id);
    const shouldArchive = options?.archive !== false;
    let archivedCards = current.archivedCards ?? [];
    if (shouldArchive) {
      const nowIso = (options?.now ?? new Date()).toISOString();
      const newlyArchived: KanbanCard[] = deleted.map((c) => {
        const item: KanbanCard = {
          ...c,
          updatedAt: nowIso,
          archivedAt: nowIso,
        };
        delete item.claim;
        return item;
      });
      const newlyIds = new Set(newlyArchived.map((c) => c.id.toLowerCase()));
      archivedCards = [
        ...newlyArchived,
        ...archivedCards.filter((c) => !newlyIds.has(c.id.toLowerCase())),
      ].slice(0, MAX_BOARD_CARDS);
    }
    const board = await saveBoardUnlocked(ayaHome, project, {
      version: BOARD_FORMAT_VERSION,
      columns: current.columns,
      cards,
      archivedCards,
    });
    notifyBoardChanged(project.slug);
    return { board, deleted };
  });
}

export function restoreBoardCards(
  ayaHome: string,
  project: Pick<ProjectConfig, "slug" | "directory">,
  entries: ReadonlyArray<{ card: KanbanCard; index?: number }>,
): Promise<BoardSnapshot> {
  return serial(project.slug, async () => {
    const current = await loadBoardUnlocked(ayaHome, project);
    if (entries.length === 0) return current;
    const colIds = new Set(current.columns.map((c) => c.id));
    const fallbackColId = current.columns[0]?.id;
    if (!fallbackColId) return current;
    const nextCards = [...current.cards];
    const existingIds = new Set(nextCards.map((c) => c.id.toLowerCase()));
    const restoredIds = new Set<string>();
    const sorted = [...entries].sort((a, b) => (a.index ?? 999999) - (b.index ?? 999999));
    for (const entry of sorted) {
      if (nextCards.length >= MAX_BOARD_CARDS) break;
      const raw = entry.card;
      if (!raw || typeof raw.title !== "string" || !raw.title.trim()) continue;
      const colId = colIds.has(raw.columnId) ? raw.columnId : fallbackColId;
      const id =
        typeof raw.id === "string" && ID_RE.test(raw.id) && !existingIds.has(raw.id.toLowerCase())
          ? raw.id
          : nextCardId(nextCards, current.archivedCards);
      existingIds.add(id.toLowerCase());
      restoredIds.add(id.toLowerCase());
      if (typeof raw.id === "string") restoredIds.add(raw.id.toLowerCase());
      const nowIso = new Date().toISOString();
      const restored: KanbanCard = {
        id,
        columnId: colId,
        title: cleanCardTitle(raw.title),
        ...(raw.description ? { description: cleanDescription(raw.description) } : {}),
        ...(raw.assignee ? { assignee: cleanAssignee(raw.assignee) } : {}),
        ...(raw.priority ? { priority: cleanPriority(raw.priority) } : {}),
        ...(raw.labels ? { labels: cleanLabels(raw.labels) } : {}),
        ...(raw.claim && isClaim(raw.claim) ? { claim: raw.claim } : {}),
        createdAt: typeof raw.createdAt === "string" && Number.isFinite(Date.parse(raw.createdAt)) ? raw.createdAt : nowIso,
        updatedAt: nowIso,
      };
      if (typeof entry.index === "number" && Number.isInteger(entry.index) && entry.index >= 0) {
        const inCol = nextCards.filter((c) => c.columnId === colId);
        const clamped = Math.min(entry.index, inCol.length);
        if (clamped === inCol.length) {
          nextCards.push(restored);
        } else {
          const beforeCard = inCol[clamped];
          const insertAt = nextCards.findIndex((c) => c.id === beforeCard.id);
          nextCards.splice(insertAt, 0, restored);
        }
      } else {
        nextCards.push(restored);
      }
    }
    const archivedCards = (current.archivedCards ?? []).filter(
      (c) => !restoredIds.has(c.id.toLowerCase()),
    );
    const board = await saveBoardUnlocked(ayaHome, project, {
      version: BOARD_FORMAT_VERSION,
      columns: current.columns,
      cards: nextCards,
      archivedCards,
    });
    notifyBoardChanged(project.slug);
    return board;
  });
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function claimBoardCard(
  ayaHome: string,
  project: Pick<ProjectConfig, "slug" | "directory">,
  cardId: string,
  claimant: {
    paneId?: string;
    paneName: string;
    replace?: boolean;
    pendingStart?: boolean;
    now?: Date;
  },
): Promise<{ board: BoardSnapshot; card: KanbanCard; previous: KanbanCard; tookOver?: KanbanClaim }> {
  return serial(project.slug, async () => {
    const current = await loadBoardUnlocked(ayaHome, project);
    const target = resolveCard(current.cards, cardId);
    const paneName = cleanAssignee(claimant.paneName) ?? "terminal";
    const held = target.claim;
    const isOwn =
      held &&
      (claimant.paneId && held.paneId
        ? held.paneId === claimant.paneId
        : held.paneName.toLowerCase() === paneName.toLowerCase());
    if (held && !isOwn && !claimant.replace) {
      throw new Error(
        `${target.id} is already claimed by ${held.paneName} since ${hhmm(held.since)}. Not changed; pass --replace to take it over.`,
      );
    }
    const iso = (claimant.now ?? new Date()).toISOString();
    if (held && !isOwn) await notifyTaskWithdrawal(ayaHome, project.slug, target, `reassigned to ${paneName}`);
    // Starting a pending task advances it regardless of the visual column order.
    const inProgress = current.columns.find((c) => c.id === STARTED_COLUMN_ID);
    const nextColumnId =
      isPendingColumn(target.columnId) && inProgress ? inProgress.id : target.columnId;
    const updated: KanbanCard = {
      ...target,
      columnId: nextColumnId,
      assignee: paneName,
      claim: {
        ...(claimant.paneId ? { paneId: claimant.paneId } : {}),
        paneName,
        since: iso,
        ...(claimant.pendingStart ? { startup: "reserved" as const } : {}),
      },
      updatedAt: iso,
    };
    const cards = current.cards.map((c) => (c.id === target.id ? updated : c));
    const board = await saveBoardUnlocked(ayaHome, project, {
      version: BOARD_FORMAT_VERSION,
      columns: current.columns,
      cards,
      archivedCards: current.archivedCards,
    });
    notifyBoardChanged(project.slug);
    return {
      board,
      card: updated,
      previous: target,
      ...(held && !isOwn ? { tookOver: held } : {}),
    };
  });
}

/** A delayed startup must recheck ownership under the same lock as withdrawals. */
export function dispatchBoardCard(ayaHome: string, project: Pick<ProjectConfig, "slug" | "directory">,
  cardId: string, paneId: string, claimSince: string, deliver: (text: string) => Promise<unknown>): Promise<BoardSnapshot> {
  return serial(project.slug, async () => {
    const board = await loadBoardUnlocked(ayaHome, project);
    const card = board.cards.find(c => c.id === cardId);
    if (card?.claim?.paneId !== paneId || card.claim.since !== claimSince || card.claim.startup !== "reserved") return board;
    const save = (startup: "reserved" | "sending" | "sent") => saveBoardUnlocked(ayaHome, project, {
      version: BOARD_FORMAT_VERSION, columns: board.columns,
      cards: board.cards.map(c => c.id === cardId ? { ...c, claim: { ...card.claim!, startup } } : c),
      archivedCards: board.archivedCards,
    });
    // Persist before typing so a remount or crash cannot resend an uncertain prompt.
    await save("sending");
    try { await deliver(formatBoardPrompt(card)); }
    catch (error) {
      if (!inputMayHaveBeenWritten(error)) await save("reserved");
      notifyBoardChanged(project.slug);
      throw error;
    }
    let delivered;
    try { delivered = await save("sent"); }
    catch { throw new Error("Task was submitted, but its confirmation could not be saved. Check the pane before retrying."); }
    notifyBoardChanged(project.slug);
    return delivered;
  });
}

export function deliverBoardWithdrawal(ayaHome: string, project: Pick<ProjectConfig, "slug" | "directory">,
  cardId: string, paneId: string, deliver: () => Promise<unknown>): Promise<unknown> {
  return serial(project.slug, async () => {
    const board = await loadBoardUnlocked(ayaHome, project);
    if (board.cards.find(c => c.id === cardId)?.claim?.paneId === paneId) return;
    return deliver();
  });
}

export function cancelBoardCardStart(ayaHome: string, project: Pick<ProjectConfig, "slug" | "directory">,
  cardId: string, paneId: string, claimSince: string, previousColumn: string, previousAssignee?: string): Promise<BoardSnapshot> {
  return serial(project.slug, async () => {
    const current = await loadBoardUnlocked(ayaHome, project);
    const target = current.cards.find(c => c.id === cardId);
    if (target?.claim?.paneId !== paneId || target.claim.since !== claimSince || target.claim.startup !== "reserved") return current;
    const updated = { ...target, updatedAt: new Date().toISOString() };
    delete updated.claim;
    if (previousAssignee) updated.assignee = previousAssignee;
    else delete updated.assignee;
    if (current.columns.some(c => c.id === previousColumn)) updated.columnId = previousColumn;
    const board = await saveBoardUnlocked(ayaHome, project, { version: BOARD_FORMAT_VERSION, columns: current.columns,
      cards: current.cards.map(c => c.id === cardId ? updated : c), archivedCards: current.archivedCards });
    notifyBoardChanged(project.slug);
    return board;
  });
}

export function releaseBoardCard(
  ayaHome: string,
  project: Pick<ProjectConfig, "slug" | "directory">,
  cardId: string,
  caller: {
    paneId?: string;
    paneName?: string;
    force?: boolean;
    now?: Date;
  } = {},
): Promise<{ board: BoardSnapshot; card: KanbanCard; previous?: KanbanClaim }> {
  return serial(project.slug, async () => {
    const current = await loadBoardUnlocked(ayaHome, project);
    const target = resolveCard(current.cards, cardId);
    const previous = target.claim;
    if (!previous) {
      return { board: current, card: target };
    }
    const isOtherPane =
      !caller.force &&
      caller.paneId &&
      previous.paneId &&
      previous.paneId !== caller.paneId;
    if (isOtherPane) {
      throw new Error(
        `${target.id} is claimed by ${previous.paneName}, not this pane; pass --force to release it anyway.`,
      );
    }
    if (!caller.paneId || caller.paneId !== previous.paneId) {
      await notifyTaskWithdrawal(ayaHome, project.slug, target, "released from your pane");
    }
    const updated: KanbanCard = {
      ...target,
      updatedAt: (caller.now ?? new Date()).toISOString(),
    };
    delete updated.claim;
    const cards = current.cards.map((c) => (c.id === target.id ? updated : c));
    const board = await saveBoardUnlocked(ayaHome, project, {
      version: BOARD_FORMAT_VERSION,
      columns: current.columns,
      cards,
      archivedCards: current.archivedCards,
    });
    notifyBoardChanged(project.slug);
    return { board, card: updated, previous };
  });
}

async function hasExistingBoardFile(
  ayaHome: string,
  project: Pick<ProjectConfig, "slug" | "directory">,
): Promise<boolean> {
  if (await hasRepoBoardFile(project.directory)) return true;
  try {
    const stat = await fs.lstat(userBoardFile(ayaHome, project.slug));
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

export function releaseBoardClaimsForPane(
  ayaHome: string,
  project: Pick<ProjectConfig, "slug" | "directory">,
  paneId: string,
): Promise<BoardSnapshot | null> {
  return serial(project.slug, async () => {
    if (!(await hasExistingBoardFile(ayaHome, project))) return null;
    const current = await loadBoardUnlocked(ayaHome, project);
    if (!current.cards.some((c) => c.claim?.paneId === paneId)) return current;
    const iso = new Date().toISOString();
    const cards = current.cards.map((c) => {
      if (c.claim?.paneId !== paneId) return c;
      const updated: KanbanCard = { ...c, updatedAt: iso };
      delete updated.claim;
      return updated;
    });
    const board = await saveBoardUnlocked(ayaHome, project, {
      version: BOARD_FORMAT_VERSION,
      columns: current.columns,
      cards,
      archivedCards: current.archivedCards,
    });
    notifyBoardChanged(project.slug);
    return board;
  });
}

export function syncBoardPaneName(
  ayaHome: string,
  project: Pick<ProjectConfig, "slug" | "directory">,
  paneId: string,
  paneName: string,
): Promise<BoardSnapshot | null> {
  return serial(project.slug, async () => {
    const clean = cleanAssignee(paneName);
    if (!clean) return null;
    if (!(await hasExistingBoardFile(ayaHome, project))) return null;
    const current = await loadBoardUnlocked(ayaHome, project);
    if (!current.cards.some((c) => c.claim?.paneId === paneId && c.claim.paneName !== clean)) {
      return current;
    }
    const iso = new Date().toISOString();
    const cards = current.cards.map((c) => {
      if (c.claim?.paneId !== paneId || c.claim.paneName === clean) return c;
      const oldName = c.claim.paneName;
      return {
        ...c,
        ...(c.assignee === oldName ? { assignee: clean } : {}),
        claim: { ...c.claim, paneName: clean },
        updatedAt: iso,
      };
    });
    const board = await saveBoardUnlocked(ayaHome, project, {
      version: BOARD_FORMAT_VERSION,
      columns: current.columns,
      cards,
      archivedCards: current.archivedCards,
    });
    notifyBoardChanged(project.slug);
    return board;
  });
}

export async function saveBoardImage(
  ayaHome: string,
  project: Pick<ProjectConfig, "slug" | "directory">,
  input: { dataBase64: string; name?: string },
): Promise<{ path: string; markdown: string }> {
  const stripped = input.dataBase64.replace(/^data:[^;]+;base64,/, "").trim();
  if (!stripped) throw new Error("Image data is empty.");
  const bytes = Buffer.from(stripped, "base64");
  if (bytes.length === 0 || bytes.length > MAX_BOARD_IMAGE_BYTES) {
    throw new Error(`Image must be between 1 byte and ${MAX_BOARD_IMAGE_MB} MB.`);
  }
  const detected = detectBoardImageFormat(bytes);
  if (!detected) {
    throw new Error(`Only ${listBoardImageFormats("and")} images are supported.`);
  }
  const useRepo = await hasRepoBoardFile(project.directory);
  const baseName = input.name
    ? slugifyName(input.name.replace(/\.[a-z0-9]+$/i, ""), "image").slice(0, 32)
    : "image";
  const fileName = `${baseName}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}${detected.ext}`;
  const dir = useRepo
    ? path.join(project.directory, PROJECT_AYA_DIRNAME, BOARD_ASSETS_DIR_NAME)
    : path.join(ayaHome, BOARDS_DIR_NAME, BOARD_ASSETS_DIR_NAME, project.slug);
  await fs.mkdir(dir, { recursive: true, mode: useRepo ? 0o755 : 0o700 });
  const dirStat = await fs.lstat(dir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    throw new Error("Board assets directory is not a regular folder.");
  }
  const fullPath = path.join(dir, fileName);
  const handle = await fs.open(
    fullPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    useRepo ? 0o644 : 0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const displayPath = useRepo
    ? path.posix.join(PROJECT_AYA_DIRNAME, BOARD_ASSETS_DIR_NAME, fileName)
    : fullPath;
  const alt = input.name ? input.name.replace(/[\[\]\r\n]/g, "").trim() || "screenshot" : "screenshot";
  return {
    path: displayPath,
    markdown: `![${alt}](${displayPath})`,
  };
}

export async function readBoardImageDataUrl(
  _ayaHome: string,
  project: Pick<ProjectConfig, "slug" | "directory">,
  rawSrc: string,
): Promise<string> {
  const trimmed = rawSrc.trim();
  if (!trimmed || CONTROL_CHARS.test(trimmed)) {
    throw new Error("Invalid image path.");
  }
  if (BOARD_IMAGE_DATA_URL.test(trimmed)) {
    return trimmed;
  }
  const filePart = trimmed.startsWith("file://") ? decodeURIComponent(trimmed.slice(7)) : trimmed;
  const candidate = path.isAbsolute(filePart)
    ? path.resolve(filePart)
    : path.resolve(project.directory, filePart);
  const handle = await fs.open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_BOARD_IMAGE_BYTES) {
      throw new Error(`Image must be a regular file under ${MAX_BOARD_IMAGE_MB} MB.`);
    }
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(buffer, 0, stat.size, 0);
    const bytes = buffer.subarray(0, bytesRead);
    const detected = detectBoardImageFormat(bytes);
    if (!detected) {
      throw new Error(`Unsupported image format (use ${listBoardImageFormats("or")}).`);
    }
    return `data:${detected.mime};base64,${bytes.toString("base64")}`;
  } finally {
    await handle.close();
  }
}

export function addBoardColumn(
  ayaHome: string,
  project: Pick<ProjectConfig, "slug" | "directory">,
  title: string,
): Promise<{ board: BoardSnapshot; column: KanbanColumn }> {
  return serial(project.slug, async () => {
    const current = await loadBoardUnlocked(ayaHome, project);
    if (current.columns.length >= MAX_BOARD_COLUMNS) {
      throw new Error(`The board already has the maximum of ${MAX_BOARD_COLUMNS} columns.`);
    }
    const clean = cleanColumnTitle(title);
    const baseId = slugifyName(clean, "column");
    const existingIds = new Set(current.columns.map((c) => c.id.toLowerCase()));
    let id = baseId;
    let idx = 2;
    while (existingIds.has(id.toLowerCase())) {
      id = `${baseId}-${idx}`;
      idx += 1;
    }
    const column: KanbanColumn = { id, title: clean };
    const board = await saveBoardUnlocked(ayaHome, project, {
      version: BOARD_FORMAT_VERSION,
      columns: [...current.columns, column],
      cards: current.cards,
      archivedCards: current.archivedCards,
    });
    notifyBoardChanged(project.slug);
    return { board, column };
  });
}

/** Resolve relative placement against the latest board inside the mutation queue. */
export function moveBoardColumn(
  ayaHome: string,
  project: Pick<ProjectConfig, "slug" | "directory">,
  columnQuery: string,
  placement: { before?: string; after?: string },
): Promise<{ board: BoardSnapshot; column: KanbanColumn }> {
  return serial(project.slug, async () => {
    if ((placement.before !== undefined) === (placement.after !== undefined)) {
      throw new Error("Choose exactly one column to move before or after.");
    }
    const current = await loadBoardUnlocked(ayaHome, project);
    const column = resolveColumn(current.columns, columnQuery);
    const anchor = resolveColumn(current.columns, placement.before ?? placement.after!);
    if (column.id === anchor.id) throw new Error("A column cannot be moved relative to itself.");
    const columns = current.columns.filter(c => c.id !== column.id);
    const index = columns.findIndex(c => c.id === anchor.id) + (placement.after !== undefined ? 1 : 0);
    columns.splice(index, 0, column);
    if (columns.every((c, i) => c.id === current.columns[i].id)) return { board: current, column };
    const board = await saveBoardUnlocked(ayaHome, project, {
      version: BOARD_FORMAT_VERSION,
      columns,
      cards: current.cards,
      archivedCards: current.archivedCards,
    });
    notifyBoardChanged(project.slug);
    return { board, column };
  });
}

export function renameBoardColumn(
  ayaHome: string,
  project: Pick<ProjectConfig, "slug" | "directory">,
  columnQuery: string,
  title: string,
): Promise<{ board: BoardSnapshot; column: KanbanColumn }> {
  return serial(project.slug, async () => {
    const current = await loadBoardUnlocked(ayaHome, project);
    const target = resolveColumn(current.columns, columnQuery);
    const clean = cleanColumnTitle(title);
    const updated: KanbanColumn = { id: target.id, title: clean };
    const columns = current.columns.map((c) => (c.id === target.id ? updated : c));
    const board = await saveBoardUnlocked(ayaHome, project, {
      version: BOARD_FORMAT_VERSION,
      columns,
      cards: current.cards,
      archivedCards: current.archivedCards,
    });
    notifyBoardChanged(project.slug);
    return { board, column: updated };
  });
}

export function deleteBoardColumn(
  ayaHome: string,
  project: Pick<ProjectConfig, "slug" | "directory">,
  columnQuery: string,
): Promise<BoardSnapshot> {
  return serial(project.slug, async () => {
    const current = await loadBoardUnlocked(ayaHome, project);
    const target = resolveColumn(current.columns, columnQuery);
    if (current.columns.length <= 1) {
      throw new Error("Cannot remove the last column on the board.");
    }
    const count = current.cards.filter((c) => c.columnId === target.id).length;
    if (count > 0) {
      throw new Error(
        `Column "${target.title}" still has ${count} card${count === 1 ? "" : "s"}; move or remove them first.`,
      );
    }
    const columns = current.columns.filter((c) => c.id !== target.id);
    const board = await saveBoardUnlocked(ayaHome, project, {
      version: BOARD_FORMAT_VERSION,
      columns,
      cards: current.cards,
      archivedCards: current.archivedCards,
    });
    notifyBoardChanged(project.slug);
    return board;
  });
}

export function exportBoardToRepo(
  ayaHome: string,
  project: Pick<ProjectConfig, "slug" | "directory">,
): Promise<BoardSnapshot> {
  return serial(project.slug, async () => {
    const current = await loadBoardUnlocked(ayaHome, project);
    const userAssetsDir = path.join(
      ayaHome,
      BOARDS_DIR_NAME,
      BOARD_ASSETS_DIR_NAME,
      project.slug,
    );
    const repoAssetsDir = path.join(
      project.directory,
      PROJECT_AYA_DIRNAME,
      BOARD_ASSETS_DIR_NAME,
    );
    const migrateCardAssets = async (list: readonly KanbanCard[]): Promise<KanbanCard[]> => {
      const out: KanbanCard[] = [];
      for (const card of list) {
        if (!card.description || !card.description.includes(userAssetsDir)) {
          out.push(card);
          continue;
        }
        let nextDesc = card.description;
        const escapedPrefix = userAssetsDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const assetRe = new RegExp(`${escapedPrefix}[/\\\\]([a-z0-9_.-]+\\.(?:png|jpg|webp|gif))`, "gi");
        const matches = Array.from(card.description.matchAll(assetRe));
        for (const m of matches) {
          const fullMatch = m[0];
          const fileName = m[1];
          const srcFile = path.join(userAssetsDir, fileName);
          const dstFile = path.join(repoAssetsDir, fileName);
          try {
            await fs.mkdir(repoAssetsDir, { recursive: true, mode: 0o755 });
            await fs.copyFile(srcFile, dstFile);
            const relPath = path.posix.join(
              PROJECT_AYA_DIRNAME,
              BOARD_ASSETS_DIR_NAME,
              fileName,
            );
            nextDesc = nextDesc.split(fullMatch).join(relPath);
          } catch {
            // Keep original reference if asset file could not be copied.
          }
        }
        out.push(nextDesc === card.description ? card : { ...card, description: nextDesc });
      }
      return out;
    };
    const cards = await migrateCardAssets(current.cards);
    const archivedCards = await migrateCardAssets(current.archivedCards ?? []);
    const board = await saveBoardUnlocked(
      ayaHome,
      project,
      {
        version: BOARD_FORMAT_VERSION,
        columns: current.columns,
        cards,
        archivedCards,
      },
      "repo",
    );
    notifyBoardChanged(project.slug);
    return board;
  });
}

export function formatBoardPrompt(card: KanbanCard): string {
  const metaParts: string[] = [];
  if (card.priority) metaParts.push(`priority: ${card.priority}`);
  if (card.labels && card.labels.length > 0) metaParts.push(`labels: ${card.labels.join(", ")}`);
  const metaSuffix = metaParts.length > 0 ? ` (${metaParts.join(" · ")})` : "";
  const lines = [`Task ${card.id}: ${card.title}${metaSuffix}`];
  if (card.description) {
    lines.push("", card.description);
  }
  lines.push(
    "",
    `Use \`aya board\` to inspect or update the board (e.g. \`aya board move ${card.id} review\` or \`aya board move ${card.id} done\` when finished).`,
  );
  return lines.join("\n");
}

export function formatBoardText(board: BoardSnapshot): string {
  const lines: string[] = [
    `Board for ${board.projectSlug} (${board.source === "repo" ? ".aya/board.json in repo" : "user config"}):`,
  ];
  for (const col of board.columns) {
    const cards = board.cards.filter((c) => c.columnId === col.id);
    lines.push(`\n## ${col.title} (${col.id}) [${cards.length}]`);
    if (cards.length === 0) {
      lines.push("  (empty)");
      continue;
    }
    for (const card of cards) {
      const meta: string[] = [];
      if (card.priority) meta.push(`priority: ${card.priority}`);
      if (card.labels && card.labels.length > 0) meta.push(`labels: ${card.labels.join(", ")}`);
      if (card.claim) {
        meta.push(`claimed by ${card.claim.paneName}`);
      } else if (card.assignee) {
        meta.push(`assigned: ${card.assignee}`);
      }
      const suffix = meta.length > 0 ? `  [${meta.join(", ")}]` : "";
      lines.push(`  ${card.id}  ${card.title}${suffix}`);
      if (card.description) {
        for (const descLine of card.description.split(/\r?\n/)) {
          lines.push(`       ${descLine}`);
        }
      }
    }
  }
  if (board.archivedCards && board.archivedCards.length > 0) {
    lines.push(`\n## Archive [${board.archivedCards.length} archived — run "aya board archive" to view]`);
  }
  return `${lines.join("\n")}\n`;
}

const PRIORITY_TOKEN_MAP: Record<string, KanbanPriority> = {
  p0: "urgent",
  urgent: "urgent",
  p1: "high",
  high: "high",
  p2: "medium",
  medium: "medium",
  p3: "low",
  low: "low",
};

export function matchesBoardQuery(
  card: KanbanCard,
  rawQuery: string,
  options?: { isArchived?: boolean },
): boolean {
  const trimmed = rawQuery.trim().toLowerCase();
  if (!trimmed) return true;
  const isArchived = options?.isArchived ?? Boolean(card.archivedAt);
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    if (token.startsWith("#") && token.length > 1) {
      const needle = token.slice(1);
      if (!card.labels?.some((l) => l.toLowerCase().includes(needle))) return false;
      continue;
    }
    if ((token.startsWith("label:") || token.startsWith("tag:")) && token.includes(":")) {
      const needle = token.slice(token.indexOf(":") + 1);
      if (!needle) continue;
      if (!card.labels?.some((l) => l.toLowerCase().includes(needle))) return false;
      continue;
    }
    if (token.startsWith("@") && token.length > 1) {
      const needle = token.slice(1);
      const assigneeMatch = card.assignee?.toLowerCase().includes(needle) ?? false;
      const claimMatch = card.claim?.paneName.toLowerCase().includes(needle) ?? false;
      if (!assigneeMatch && !claimMatch) return false;
      continue;
    }
    if (token.startsWith("assignee:") || token.startsWith("owner:")) {
      const needle = token.slice(token.indexOf(":") + 1);
      if (!needle) continue;
      const assigneeMatch = card.assignee?.toLowerCase().includes(needle) ?? false;
      const claimMatch = card.claim?.paneName.toLowerCase().includes(needle) ?? false;
      if (!assigneeMatch && !claimMatch) return false;
      continue;
    }
    if (token in PRIORITY_TOKEN_MAP && (token === "p0" || token === "p1" || token === "p2" || token === "p3")) {
      if (card.priority !== PRIORITY_TOKEN_MAP[token]) return false;
      continue;
    }
    if (token.startsWith("p:") || token.startsWith("priority:")) {
      const rawP = token.slice(token.indexOf(":") + 1);
      const mapped = PRIORITY_TOKEN_MAP[rawP];
      if (mapped) {
        if (card.priority !== mapped) return false;
        continue;
      }
      if ((card.priority?.toLowerCase() ?? "") !== rawP) return false;
      continue;
    }
    if (token.startsWith("col:") || token.startsWith("column:")) {
      const needle = token.slice(token.indexOf(":") + 1);
      if (needle && !card.columnId.toLowerCase().includes(needle)) return false;
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
}

export async function searchBoard(
  ayaHome: string,
  project: ProjectConfig,
  query: string,
  options?: { scope?: "all" | "active" | "archive" },
): Promise<{ board: BoardSnapshot; activeMatches: KanbanCard[]; archivedMatches: KanbanCard[] }> {
  const board = await getBoard(ayaHome, project);
  const scope = options?.scope ?? "all";
  const activeMatches =
    scope === "archive"
      ? []
      : board.cards.filter((c) => matchesBoardQuery(c, query, { isArchived: false }));
  const archivedMatches =
    scope === "active"
      ? []
      : (board.archivedCards ?? []).filter((c) => matchesBoardQuery(c, query, { isArchived: true }));
  return { board, activeMatches, archivedMatches };
}

function formatSearchCardLine(card: KanbanCard, prefixLabel: string): string {
  const meta: string[] = [prefixLabel];
  if (card.priority) meta.push(`priority: ${card.priority}`);
  if (card.labels && card.labels.length > 0) meta.push(`labels: ${card.labels.join(", ")}`);
  if (card.claim) {
    meta.push(`claimed by ${card.claim.paneName}`);
  } else if (card.assignee) {
    meta.push(`assigned: ${card.assignee}`);
  }
  if (card.archivedAt) {
    meta.push(`archived: ${card.archivedAt.slice(0, 10)}`);
  }
  const lines = [`  ${card.id}  ${card.title}  [${meta.join(", ")}]`];
  if (card.description) {
    for (const descLine of card.description.split(/\r?\n/)) {
      lines.push(`       ${descLine}`);
    }
  }
  return lines.join("\n");
}

// ---- CLI (`aya board ...`) ----

const BOARD_USAGE =
  "usage: aya board [--json] [--project slug] | search <query> [--archive|--active] [--json] [--project slug] | columns [--json] [--project slug] | add <title> [--column <col>] [--description <text>] [--assignee <name>] [--priority <low|medium|high|urgent>] [--labels <a,b>] [--project slug] | move <id> <column> [--project slug] | edit <id> [--title <title>] [--description <text>] [--assignee <name|none>] [--priority <low|medium|high|urgent|none>] [--labels <a,b|none>] [--project slug] | remove <id> [--project slug] | clear <column> [--project slug] | archive [list|<id>|restore <id> [column]|clear|search <query>] [--project slug] | claim <id> [--replace] [--project slug] | release <id> [--force] [--project slug] | column add|rename|remove ... [--project slug] | column move <column> --before|--after <other-column> [--project slug] | export-repo [--project slug]";

export interface BoardControlRequest {
  argv: string[];
  projectSlug?: string;
  cwd?: string;
}

export interface BoardControlDeps {
  ayaHome: string;
  listProjects: () => Promise<ProjectConfig[]>;
  now?: () => Date;
}

function extractProjectFlag(argv: readonly string[], fallbackSlug?: string): { args: string[]; projectSlug?: string } {
  const args: string[] = [];
  let projectSlug = fallbackSlug;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project") {
      const next = argv[i + 1];
      if (!next) throw new Error(BOARD_USAGE);
      projectSlug = next;
      i += 1;
      continue;
    }
    if (arg.startsWith("--project=")) {
      const val = arg.slice("--project=".length);
      if (!val) throw new Error(BOARD_USAGE);
      projectSlug = val;
      continue;
    }
    args.push(arg);
  }
  return { args, projectSlug };
}

export async function handleBoardRequest(
  request: BoardControlRequest,
  callerId: string | undefined,
  deps: BoardControlDeps,
): Promise<{ output: string }> {
  const { args, projectSlug } = extractProjectFlag(request.argv, request.projectSlug);
  const projects = await deps.listProjects();
  const project = projectSlug
    ? projects.find((p) => p.slug === projectSlug) ?? null
    : await callerProject(projects, callerId, { cwd: request.cwd });
  if (!project) {
    const where = projectSlug
      ? `no project "${projectSlug}"; projects: ${projects.map((p) => p.slug).join(", ")}`
      : "run aya board in an Aya pane, in the directory of a project open in Aya, or pass --project <slug>";
    throw new Error(where);
  }
  if (project.remote) {
    throw new Error(`project ${project.slug} is remote; aya board works only on local projects`);
  }

  const callerTab = callerId ? project.tabs.find((t) => t.id === callerId) : undefined;
  const callerName = callerTab?.name ?? (callerId ? callerId : "cli");
  const now = () => deps.now?.() ?? new Date();

  const [sub, ...rest] = args;
  if (sub === undefined || sub === "--json" || sub === "list" || sub === "ls") {
    const jsonFlag = sub === "--json" || rest.includes("--json");
    const extra = (sub === "--json" ? rest : rest.filter((a) => a !== "--json"));
    if (extra.length > 0) throw new Error(BOARD_USAGE);
    const board = await getBoard(deps.ayaHome, project);
    return {
      output: jsonFlag ? `${JSON.stringify(board, null, 2)}\n` : formatBoardText(board),
    };
  }

  const runSearchCommand = async (
    rawArgs: readonly string[],
    defaultScope: "all" | "active" | "archive" = "all",
  ): Promise<{ output: string }> => {
    let scope: "all" | "active" | "archive" = defaultScope;
    let jsonFlag = false;
    const queryWords: string[] = [];
    for (const a of rawArgs) {
      if (a === "--archive" || a === "-a") {
        scope = "archive";
      } else if (a === "--active") {
        scope = "active";
      } else if (a === "--all") {
        scope = "all";
      } else if (a === "--json") {
        jsonFlag = true;
      } else if (a.startsWith("-")) {
        throw new Error(BOARD_USAGE);
      } else {
        queryWords.push(a);
      }
    }
    const query = queryWords.join(" ").trim();
    if (!query) throw new Error(BOARD_USAGE);
    const { board, activeMatches, archivedMatches } = await searchBoard(deps.ayaHome, project, query, { scope });
    if (jsonFlag) {
      return {
        output: `${JSON.stringify(
          {
            projectSlug: board.projectSlug,
            query,
            scope,
            active: activeMatches,
            archived: archivedMatches,
          },
          null,
          2,
        )}\n`,
      };
    }
    const total = activeMatches.length + archivedMatches.length;
    if (total === 0) {
      return {
        output: `No cards matching "${query}" on ${board.projectSlug}.\n`,
      };
    }
    const colTitleById = new Map(board.columns.map((c) => [c.id, c.title]));
    const lines: string[] = [
      `Search "${query}" on ${board.projectSlug} — ${total} match${total === 1 ? "" : "es"}:`,
    ];
    if (activeMatches.length > 0) {
      lines.push(`\n## Active (${activeMatches.length})`);
      for (const card of activeMatches) {
        const colLabel = colTitleById.get(card.columnId) ?? card.columnId;
        lines.push(formatSearchCardLine(card, `${colLabel} (${card.columnId})`));
      }
    }
    if (archivedMatches.length > 0) {
      lines.push(`\n## Archive (${archivedMatches.length})`);
      for (const card of archivedMatches) {
        lines.push(formatSearchCardLine(card, `archived from ${card.columnId}`));
      }
    }
    return { output: `${lines.join("\n")}\n` };
  };

  if (sub === "columns") {
    const jsonFlag = rest.includes("--json");
    if (rest.some((a) => a !== "--json")) throw new Error(BOARD_USAGE);
    const board = await getBoard(deps.ayaHome, project);
    const columns = board.columns.map((c) => ({ id: c.id, title: c.title, definition: COLUMN_DEFINITIONS[c.id] ?? null }));
    if (jsonFlag) {
      return { output: `${JSON.stringify({ projectSlug: board.projectSlug, columns, fixedRules: FIXED_RULES }, null, 2)}\n` };
    }
    return {
      output: [
        `Columns on ${board.projectSlug}:`,
        ...columns.map((c) => `- ${c.id} (${c.title}): ${c.definition ?? "custom column, no built-in meaning."}`),
        "",
        "Fixed rules (Aya enforces these; they cannot be changed):",
        ...FIXED_RULES.map((rule) => `- ${rule}`),
        "",
      ].join("\n"),
    };
  }

  if (sub === "search" || sub === "find") {
    return runSearchCommand(rest, "all");
  }

  if (sub === "add") {
    let columnId: string | undefined;
    let description: string | undefined;
    let assignee: string | undefined;
    let priority: string | undefined;
    const labels: string[] = [];
    const titleWords: string[] = [];
    for (let i = 0; i < rest.length; i += 1) {
      const a = rest[i];
      if (a === "--column" || a === "-c") {
        if (i + 1 >= rest.length) throw new Error(BOARD_USAGE);
        columnId = rest[++i];
      } else if (a === "--description" || a === "-d") {
        if (i + 1 >= rest.length) throw new Error(BOARD_USAGE);
        description = rest[++i];
      } else if (a === "--assignee" || a === "-a") {
        if (i + 1 >= rest.length) throw new Error(BOARD_USAGE);
        assignee = rest[++i];
      } else if (a === "--priority" || a === "-p") {
        if (i + 1 >= rest.length) throw new Error(BOARD_USAGE);
        priority = rest[++i];
      } else if (a === "--labels" || a === "--label" || a === "-l") {
        if (i + 1 >= rest.length) throw new Error(BOARD_USAGE);
        labels.push(...rest[++i].split(","));
      } else if (a.startsWith("-")) {
        throw new Error(BOARD_USAGE);
      } else {
        titleWords.push(a);
      }
    }
    const title = titleWords.join(" ").trim();
    if (!title) throw new Error(BOARD_USAGE);
    const { card } = await addBoardCard(deps.ayaHome, project, {
      title,
      columnId,
      description,
      assignee,
      priority,
      ...(labels.length > 0 ? { labels } : {}),
      now: now(),
    });
    return { output: `added ${card.id} (${card.columnId}): ${card.title}\n` };
  }

  if (sub === "move" || sub === "mv") {
    if (rest.length < 2) throw new Error(BOARD_USAGE);
    const [cardId, ...colWords] = rest;
    const columnQuery = colWords.join(" ").trim();
    if (!cardId || !columnQuery) throw new Error(BOARD_USAGE);
    const { card } = await moveBoardCard(deps.ayaHome, project, cardId, columnQuery, undefined, now(), callerId);
    return { output: `moved ${card.id} to ${card.columnId}\n` };
  }

  if (sub === "edit") {
    const [cardId, ...flags] = rest;
    if (!cardId) throw new Error(BOARD_USAGE);
    let title: string | undefined;
    let description: string | undefined;
    let assignee: string | null | undefined;
    let priority: string | null | undefined;
    let labels: string[] | null | undefined;
    for (let i = 0; i < flags.length; i += 1) {
      const a = flags[i];
      if (a === "--title" || a === "-t") {
        if (i + 1 >= flags.length) throw new Error(BOARD_USAGE);
        title = flags[++i];
      } else if (a === "--description" || a === "-d") {
        if (i + 1 >= flags.length) throw new Error(BOARD_USAGE);
        description = flags[++i];
      } else if (a === "--assignee" || a === "-a") {
        if (i + 1 >= flags.length) throw new Error(BOARD_USAGE);
        const val = flags[++i];
        assignee = val.toLowerCase() === "none" || val === "" ? null : val;
      } else if (a === "--priority" || a === "-p") {
        if (i + 1 >= flags.length) throw new Error(BOARD_USAGE);
        const val = flags[++i];
        priority = val.toLowerCase() === "none" || val === "" ? null : val;
      } else if (a === "--labels" || a === "--label" || a === "-l") {
        if (i + 1 >= flags.length) throw new Error(BOARD_USAGE);
        const val = flags[++i];
        labels = val.toLowerCase() === "none" || val === "" ? null : val.split(",");
      } else {
        throw new Error(BOARD_USAGE);
      }
    }
    if (
      title === undefined &&
      description === undefined &&
      assignee === undefined &&
      priority === undefined &&
      labels === undefined
    ) {
      throw new Error(BOARD_USAGE);
    }
    const { card } = await updateBoardCard(deps.ayaHome, project, cardId, {
      title,
      description,
      assignee,
      priority,
      labels,
      now: now(),
      actorPaneId: callerId,
    });
    return { output: `updated ${card.id}: ${card.title}\n` };
  }

  if (sub === "remove" || sub === "rm" || sub === "delete") {
    if (rest.length !== 1 || !rest[0]) throw new Error(BOARD_USAGE);
    const { deleted } = await deleteBoardCard(deps.ayaHome, project, rest[0], callerId);
    return { output: `removed ${deleted.id}: ${deleted.title}\n` };
  }

  if (sub === "clear") {
    const colQuery = rest.join(" ").trim() || FINISHED_COLUMN_ID;
    const { deleted } = await clearBoardColumn(deps.ayaHome, project, colQuery, {
      archive: true,
      now: now(),
      actorPaneId: callerId,
    });
    return {
      output: `archived ${deleted.length} card${deleted.length === 1 ? "" : "s"} from ${colQuery}\n`,
    };
  }

  if (sub === "archive") {
    const [archAction, ...archRest] = rest;
    if (archAction === undefined || archAction === "list" || archAction === "ls" || archAction === "--json") {
      const jsonFlag = archAction === "--json" || archRest.includes("--json");
      const board = await getBoard(deps.ayaHome, project);
      const archived = board.archivedCards ?? [];
      if (jsonFlag) {
        return { output: `${JSON.stringify(archived, null, 2)}\n` };
      }
      if (archived.length === 0) {
        return { output: `Archive for ${board.projectSlug} is empty.\n` };
      }
      const lines = [`Archive for ${board.projectSlug} [${archived.length}]:`];
      for (const c of archived) {
        const meta = [`from: ${c.columnId}`];
        if (c.priority) meta.push(`priority: ${c.priority}`);
        if (c.labels && c.labels.length > 0) meta.push(`labels: ${c.labels.join(", ")}`);
        if (c.archivedAt) meta.push(`archived: ${c.archivedAt.slice(0, 10)}`);
        lines.push(`  ${c.id}  ${c.title}  [${meta.join(", ")}]`);
      }
      return { output: `${lines.join("\n")}\n` };
    }
    if (archAction === "restore" || archAction === "unarchive") {
      const [cardId, ...colWords] = archRest;
      if (!cardId) throw new Error(BOARD_USAGE);
      const colQuery = colWords.join(" ").trim() || undefined;
      const { card } = await unarchiveBoardCard(deps.ayaHome, project, cardId, colQuery, now());
      return { output: `restored ${card.id} to ${card.columnId}: ${card.title}\n` };
    }
    if (archAction === "clear" || archAction === "empty") {
      const { deleted } = await clearBoardColumn(deps.ayaHome, project, "__archive__");
      return {
        output: `permanently removed ${deleted.length} archived card${deleted.length === 1 ? "" : "s"}\n`,
      };
    }
    if (archAction === "search" || archAction === "find") {
      return runSearchCommand(archRest, "archive");
    }
    if (archRest.length === 0 && !archAction.startsWith("-")) {
      const { archived } = await archiveBoardCard(deps.ayaHome, project, archAction, now(), callerId);
      return { output: `archived ${archived.id}: ${archived.title}\n` };
    }
    throw new Error(BOARD_USAGE);
  }

  if (sub === "claim") {
    const replace = rest.includes("--replace");
    const positional = rest.filter((a) => a !== "--replace");
    if (positional.length !== 1 || positional[0].startsWith("-")) throw new Error(BOARD_USAGE);
    const { card, tookOver } = await claimBoardCard(deps.ayaHome, project, positional[0], {
      paneId: callerId,
      paneName: callerName,
      replace,
      now: now(),
    });
    const took = tookOver ? ` (took over from ${tookOver.paneName})` : "";
    return {
      output: `claimed ${card.id} (${card.columnId}) for ${callerName}: ${card.title}${took}\n`,
    };
  }

  if (sub === "release") {
    const force = rest.includes("--force");
    const positional = rest.filter((a) => a !== "--force");
    if (positional.length !== 1 || positional[0].startsWith("-")) throw new Error(BOARD_USAGE);
    const { card, previous } = await releaseBoardCard(deps.ayaHome, project, positional[0], {
      paneId: callerId,
      paneName: callerName,
      force,
      now: now(),
    });
    return {
      output: previous
        ? `released ${card.id} (was claimed by ${previous.paneName})\n`
        : `${card.id} was not claimed\n`,
    };
  }

  if (sub === "column") {
    const [colAction, ...colRest] = rest;
    if (colAction === "move" || colAction === "mv") {
      if (colRest.length !== 3 || !["--before", "--after"].includes(colRest[1])) throw new Error(BOARD_USAGE);
      const [columnId, direction, anchor] = colRest;
      const { column } = await moveBoardColumn(deps.ayaHome, project, columnId, direction === "--before" ? { before: anchor } : { after: anchor });
      return { output: `moved column ${column.id} ${direction.slice(2)} ${anchor}\n` };
    }
    if (colAction === "add") {
      const title = colRest.join(" ").trim();
      if (!title) throw new Error(BOARD_USAGE);
      const { column } = await addBoardColumn(deps.ayaHome, project, title);
      return { output: `added column ${column.id} (${column.title})\n` };
    }
    if (colAction === "rename") {
      if (colRest.length < 2) throw new Error(BOARD_USAGE);
      const [colId, ...titleWords] = colRest;
      const title = titleWords.join(" ").trim();
      if (!colId || !title) throw new Error(BOARD_USAGE);
      const { column } = await renameBoardColumn(deps.ayaHome, project, colId, title);
      return { output: `renamed column ${column.id} to ${column.title}\n` };
    }
    if (colAction === "remove" || colAction === "rm" || colAction === "delete") {
      if (colRest.length !== 1 || !colRest[0]) throw new Error(BOARD_USAGE);
      await deleteBoardColumn(deps.ayaHome, project, colRest[0]);
      return { output: `removed column ${colRest[0]}\n` };
    }
    throw new Error(BOARD_USAGE);
  }

  if (sub === "export-repo") {
    if (rest.length > 0) throw new Error(BOARD_USAGE);
    const board = await exportBoardToRepo(deps.ayaHome, project);
    return { output: `saved Kanban board to ${board.filePath}\n` };
  }

  throw new Error(BOARD_USAGE);
}
