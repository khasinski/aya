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

/** The Backlog column as Aya creates it: Create backlog column in Settings > Kanban,
 *  and the load of cards saved with the first backlog version's shelf mark. */
exports.BACKLOG_COLUMN = Object.freeze({ id: COLUMN_IDS.backlog, title: COLUMN_TITLES[COLUMN_IDS.backlog] });

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

/** The board's backlog: the column with the Backlog id. */
exports.isBacklogColumn = (column) => column.id === COLUMN_IDS.backlog;

/** Finished work: the Done column by id, or any column titled "Done". */
exports.isFinishedColumn = (column) =>
  column.id === exports.FINISHED_COLUMN_ID ||
  column.title.toLowerCase() === exports.FINISHED_COLUMN_TITLE.toLowerCase();

/** What each built-in column means, by id; agents read it through `aya board columns`. */
exports.COLUMN_DEFINITIONS = Object.freeze({
  [COLUMN_IDS.todo]: "Waiting to be started.",
  [COLUMN_IDS.backlog]: "Waiting to be started, kept for later.",
  [COLUMN_IDS.inProgress]: "Being worked on by the pane that claimed it.",
  [COLUMN_IDS.review]: "Work is finished and waits for a check.",
  [COLUMN_IDS.done]: "Finished work; cards here can be archived.",
});

const pendingTitles = exports.PENDING_COLUMN_IDS.map((id) => COLUMN_TITLES[id]).join(" or ");

/** What electron/board.ts always enforces on cards; Settings > Kanban and `aya board columns` show it. */
exports.FIXED_RULES = Object.freeze([
  `Moving a claimed card back to ${pendingTitles} removes its claim and asks its pane to stop work on it.`,
  `Starting a card from ${pendingTitles} moves it to ${COLUMN_TITLES[exports.STARTED_COLUMN_ID]}, when the board has that column.`,
  "A card another pane holds is taken over only by Send to pane on the board or aya board claim with --replace.",
  "From a pane, aya board releases only that pane's cards unless --force is given.",
  "Taking over, releasing, deleting or archiving a claimed card asks the pane that held it to stop work on it, unless that pane made the change.",
  "Closing a terminal tab releases every card it held.",
]);
