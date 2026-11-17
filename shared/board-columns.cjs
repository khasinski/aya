// The board's column dictionary: the ids of Aya's built-in columns and the role
// each plays in the board's rules. electron/board.ts and the renderer read them
// from here, so each id is written once. Board files store these ids and
// `aya board` users type them, so changing one breaks existing boards.

const COLUMN_IDS = Object.freeze({
  todo: "todo",
  backlog: "backlog",
  inProgress: "in-progress",
  review: "review",
  done: "done",
});
exports.COLUMN_IDS = COLUMN_IDS;

/** The title each built-in column gets when Aya creates it. */
const COLUMN_TITLES = Object.freeze({
  [COLUMN_IDS.todo]: "Todo",
  [COLUMN_IDS.backlog]: "Backlog",
  [COLUMN_IDS.inProgress]: "In Progress",
  [COLUMN_IDS.review]: "Review",
  [COLUMN_IDS.done]: "Done",
});
exports.COLUMN_TITLES = COLUMN_TITLES;

/** The title of the column that holds finished work, also matched on other columns. */
exports.FINISHED_COLUMN_TITLE = COLUMN_TITLES[COLUMN_IDS.done];

/** The columns a new board starts with, in order. */
exports.DEFAULT_BOARD_COLUMNS = Object.freeze(
  [COLUMN_IDS.todo, COLUMN_IDS.inProgress, COLUMN_IDS.review, COLUMN_IDS.done]
    .map((id) => Object.freeze({ id, title: COLUMN_TITLES[id] })),
);

/** Where a card waits for work: a claimed card moved back here loses its claim,
 *  and a card started from here moves to the started column. */
exports.PENDING_COLUMN_IDS = Object.freeze([COLUMN_IDS.todo, COLUMN_IDS.backlog]);

/** Where a card goes when work on it starts, if the board has that column. */
exports.STARTED_COLUMN_ID = COLUMN_IDS.inProgress;

/** The column that holds finished work; `aya board clear` archives it when no column is named. */
exports.FINISHED_COLUMN_ID = COLUMN_IDS.done;

exports.isPendingColumn = (id) => exports.PENDING_COLUMN_IDS.includes(id);

/** Finished work: the Done column by id, or any column titled "Done". */
exports.isFinishedColumn = (column) =>
  column.id === exports.FINISHED_COLUMN_ID ||
  column.title.toLowerCase() === exports.FINISHED_COLUMN_TITLE.toLowerCase();
