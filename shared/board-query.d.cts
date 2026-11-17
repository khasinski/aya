import type { KanbanCard } from "./ipc-types";

export const QUERY_TOKENS: {
  readonly labelMark: string;
  readonly labelPrefixes: readonly string[];
  readonly ownerMark: string;
  readonly ownerPrefixes: readonly string[];
  readonly priorityPrefixes: readonly string[];
  readonly columnPrefixes: readonly string[];
  readonly archived: readonly string[];
  readonly active: readonly string[];
  readonly claimed: string;
  readonly unassigned: string;
};
export function matchesBoardQuery(card: KanbanCard, query: string, isArchived?: boolean): boolean;
