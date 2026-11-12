import type { WorkingTab } from "./types";

/** Shared by disk normalization and IPC validation so neither drops a pending start. */
export function normalizeBoardStart(raw: unknown): WorkingTab["initialBoardCard"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const start = raw as Record<string, unknown>;
  if (typeof start.cardId !== "string" || !/^[a-z0-9_-]{1,64}$/i.test(start.cardId) ||
      typeof start.since !== "string" || !Number.isFinite(Date.parse(start.since)) ||
      typeof start.previousColumn !== "string" || !/^[a-z0-9_-]{1,64}$/i.test(start.previousColumn) ||
      start.previousAssignee !== undefined && (typeof start.previousAssignee !== "string" || start.previousAssignee.length > 120 || /[\x00-\x1f\x7f]/.test(start.previousAssignee))) return undefined;
  return { cardId: start.cardId, since: start.since, previousColumn: start.previousColumn,
    ...(start.previousAssignee ? { previousAssignee: start.previousAssignee as string } : {}) };
}
