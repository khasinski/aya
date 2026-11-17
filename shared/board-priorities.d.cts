import type { KanbanPriority } from "./ipc-types";

export const PRIORITY_OPTIONS: readonly { readonly value: KanbanPriority; readonly label: string; readonly short: string }[];
export const PRIORITY_VALUES: readonly KanbanPriority[];
export const PRIORITY_SHORT_TOKENS: readonly string[];
export const PRIORITY_QUERY_TOKENS: { readonly [token: string]: KanbanPriority };
