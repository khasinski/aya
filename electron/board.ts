// Per-project Kanban board store and `aya board` CLI handler.
//
// Storage priority:
// 1. `<project.directory>/.aya/board.json` when present in the repository.
// 2. `<ayaHome>/boards/<project.slug>.json` in the user's Aya config directory.

import { constants, promises as fs } from "node:fs";
import * as path from "node:path";
import { writeFileAtomic } from "./atomic-write";
import { oneAtATime } from "./keyed-queue";
import { PROJECT_AYA_DIRNAME } from "./paths";
import { slugifyName } from "./text";
import { callerProject } from "./team-author";
import { displayBoardNotices, type BoardNotice } from "./board-notices";
import { inputMayHaveBeenWritten } from "./pane-input-outcome";
import type { ProjectConfig } from "./types";

export const BOARDS_DIR_NAME = "boards";
export const REPO_BOARD_FILE_NAME = "board.json";
export const BOARD_FORMAT_VERSION = 1;
export const MAX_BOARD_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_BOARD_COLUMNS = 24;
export const MAX_BOARD_CARDS = 500;
export const MAX_COLUMN_TITLE_CHARS = 80;
export const MAX_CARD_TITLE_CHARS = 200;
export const MAX_CARD_DESCRIPTION_CHARS = 4_000;
export const MAX_ASSIGNEE_CHARS = 120;

const SLUG_RE = /^[a-z0-9_-]{1,80}$/;
const ID_RE = /^[a-z0-9_-]{1,64}$/i;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const serial = oneAtATime();

export interface KanbanColumn {
  id: string;
  title: string;
}

export interface KanbanClaim {
  paneId?: string;
  paneName: string;
  since: string;
  startup?: "reserved" | "sending" | "sent";
}

export interface KanbanCard {
  id: string;
  columnId: string;
  title: string;
  description?: string;
  assignee?: string;
  claim?: KanbanClaim;
  createdAt: string;
  updatedAt: string;
}

export interface BoardSnapshot {
  version: 1;
  projectSlug: string;
  source: "repo" | "user";
  filePath: string;
  columns: KanbanColumn[];
  cards: KanbanCard[];
  notices?: BoardNotice[];
}

interface StoredBoard {
  version: 1;
  columns: KanbanColumn[];
  cards: KanbanCard[];
}

export const DEFAULT_BOARD_COLUMNS: readonly KanbanColumn[] = [
  { id: "todo", title: "Todo" },
  { id: "in-progress", title: "In Progress" },
  { id: "review", title: "Review" },
  { id: "done", title: "Done" },
];

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

function isPendingColumn(id: string): boolean {
  return id === "todo" || id === "backlog";
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

function isCard(value: unknown, columnIds: ReadonlySet<string>): value is KanbanCard {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const card = value as Record<string, unknown>;
  if (
    typeof card.id !== "string" ||
    !ID_RE.test(card.id) ||
    typeof card.columnId !== "string" ||
    !columnIds.has(card.columnId) ||
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
  if (card.claim !== undefined && !isClaim(card.claim)) {
    return false;
  }
  return true;
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
  const cards = (record.cards as KanbanCard[]).map((c) => ({
    id: c.id,
    columnId: c.columnId,
    title: c.title.trim(),
    ...(c.description && c.description.trim() ? { description: c.description.trim() } : {}),
    ...(c.assignee && c.assignee.trim() ? { assignee: c.assignee.trim() } : {}),
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
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }));
  if (new Set(cards.map((c) => c.id.toLowerCase())).size !== cards.length) {
    throw new Error(`${fileLabel} has duplicate card ids; nothing was changed.`);
  }
  return { version: BOARD_FORMAT_VERSION, columns, cards };
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
  const text = `${JSON.stringify({ version: BOARD_FORMAT_VERSION, columns: stored.columns, cards: stored.cards }, null, 2)}\n`;
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
  };
}

function nextCardId(cards: readonly KanbanCard[]): string {
  let max = 0;
  for (const card of cards) {
    const match = /^t-(\d+)$/i.exec(card.id);
    if (match) {
      const n = Number(match[1]);
      if (Number.isSafeInteger(n) && n > max) max = n;
    }
  }
  let candidate = max + 1;
  const existing = new Set(cards.map((c) => c.id.toLowerCase()));
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
    title: string;
    description?: string;
    columnId?: string;
    assignee?: string;
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
    const column = input.columnId
      ? resolveColumn(current.columns, input.columnId)
      : current.columns[0];
    if (!column) throw new Error("The board has no columns.");
    const iso = (input.now ?? new Date()).toISOString();
    const card: KanbanCard = {
      id: nextCardId(current.cards),
      columnId: column.id,
      title,
      ...(description ? { description } : {}),
      ...(assignee ? { assignee } : {}),
      createdAt: iso,
      updatedAt: iso,
    };
    const board = await saveBoardUnlocked(ayaHome, project, {
      version: BOARD_FORMAT_VERSION,
      columns: current.columns,
      cards: [...current.cards, card],
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
    if (column) await withdrawToPendingColumn(ayaHome, project.slug, target, updated, column, patch.actorPaneId);
    const cards = current.cards.map((c) => (c.id === target.id ? updated : c));
    const board = await saveBoardUnlocked(ayaHome, project, {
      version: BOARD_FORMAT_VERSION,
      columns: current.columns,
      cards,
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
    });
    notifyBoardChanged(project.slug);
    return { board, card: updated };
  });
}

export function deleteBoardCard(
  ayaHome: string,
  project: Pick<ProjectConfig, "slug" | "directory">,
  cardId: string,
  actorPaneId?: string,
): Promise<{ board: BoardSnapshot; deleted: KanbanCard }> {
  return serial(project.slug, async () => {
    const current = await loadBoardUnlocked(ayaHome, project);
    const target = resolveCard(current.cards, cardId);
    await notifyTaskWithdrawal(ayaHome, project.slug, target, "removed from the board", actorPaneId);
    const cards = current.cards.filter((c) => c.id !== target.id);
    const board = await saveBoardUnlocked(ayaHome, project, {
      version: BOARD_FORMAT_VERSION,
      columns: current.columns,
      cards,
    });
    notifyBoardChanged(project.slug);
    return { board, deleted: target };
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
    const inProgress = current.columns.find((c) => c.id === "in-progress");
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
      cards: current.cards.map(c => c.id === cardId ? updated : c) });
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
    });
    notifyBoardChanged(project.slug);
    return { board, card: updated, previous };
  });
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
    const board = await saveBoardUnlocked(
      ayaHome,
      project,
      {
        version: BOARD_FORMAT_VERSION,
        columns: current.columns,
        cards: current.cards,
      },
      "repo",
    );
    notifyBoardChanged(project.slug);
    return board;
  });
}

export function formatBoardPrompt(card: KanbanCard): string {
  const lines = [`Task ${card.id}: ${card.title}`];
  if (card.description) {
    lines.push("", card.description);
  }
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
  return `${lines.join("\n")}\n`;
}

// ---- CLI (`aya board ...`) ----

const BOARD_USAGE =
  "usage: aya board [--json] [--project slug] | add <title> [--column <col>] [--description <text>] [--assignee <name>] [--project slug] | move <id> <column> [--project slug] | edit <id> [--title <title>] [--description <text>] [--assignee <name|none>] [--project slug] | remove <id> [--project slug] | claim <id> [--replace] [--project slug] | release <id> [--force] [--project slug] | column add|rename|remove ... [--project slug] | column move <column> --before|--after <other-column> [--project slug] | export-repo [--project slug]";

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

  if (sub === "add") {
    let columnId: string | undefined;
    let description: string | undefined;
    let assignee: string | undefined;
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
      } else {
        throw new Error(BOARD_USAGE);
      }
    }
    if (title === undefined && description === undefined && assignee === undefined) {
      throw new Error(BOARD_USAGE);
    }
    const { card } = await updateBoardCard(deps.ayaHome, project, cardId, {
      title,
      description,
      assignee,
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
