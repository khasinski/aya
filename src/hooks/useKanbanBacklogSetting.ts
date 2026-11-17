import { KANBAN_BACKLOG_SHELF_CODEC } from "../app-preferences";
import { KANBAN_BACKLOG_SHELF_STORAGE_KEY } from "../storage-keys";
import { usePersistentPreference } from "./usePersistentPreference";

/** Settings > Kanban > Move backlog to shelf: a view preference, off by default. */
export function useKanbanBacklogSetting(): [boolean, (enabled: boolean) => void] {
  return usePersistentPreference(KANBAN_BACKLOG_SHELF_STORAGE_KEY, KANBAN_BACKLOG_SHELF_CODEC);
}
