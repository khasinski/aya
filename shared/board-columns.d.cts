export const COLUMN_IDS: {
  readonly todo: "todo";
  readonly backlog: "backlog";
  readonly inProgress: "in-progress";
  readonly review: "review";
  readonly done: "done";
};
export const COLUMN_TITLES: { readonly [id: string]: string };
export const FINISHED_COLUMN_TITLE: "Done";
export const DEFAULT_BOARD_COLUMNS: readonly { readonly id: string; readonly title: string }[];
export const PENDING_COLUMN_IDS: readonly string[];
export const STARTED_COLUMN_ID: "in-progress";
export const FINISHED_COLUMN_ID: "done";
export function isPendingColumn(id: string): boolean;
export function isFinishedColumn(column: { id: string; title: string }): boolean;
