// The limits electron/board.ts enforces on a board and its cards. Settings > Kanban
// lists them, so main and the renderer read them from here.

const { BYTES_PER_KIB, BYTES_PER_MIB } = require("./units.cjs");

exports.MAX_BOARD_COLUMNS = 24;
exports.MAX_BOARD_CARDS = 500;
exports.MAX_COLUMN_TITLE_CHARS = 80;
exports.MAX_CARD_TITLE_CHARS = 200;
exports.MAX_CARD_DESCRIPTION_CHARS = 16_000;
exports.MAX_ASSIGNEE_CHARS = 120;
exports.MAX_CARD_LABELS = 12;
exports.MAX_CARD_LABEL_CHARS = 32;

/** The board file, in the repository or in Aya's config directory. */
exports.MAX_BOARD_FILE_BYTES = 2 * BYTES_PER_MIB;
/** A project's rules for agents; every task prompt carries them, so they stay short. */
exports.MAX_PROJECT_RULES_BYTES = 16 * BYTES_PER_KIB;
/** One image in a card. */
exports.MAX_BOARD_IMAGE_BYTES = 8 * BYTES_PER_MIB;
