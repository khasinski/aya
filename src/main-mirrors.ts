// Renderer copies of main-process constants the renderer can't import;
// tests/main-mirrors-parity.test.mjs holds each equal to its electron source.

/** electron/local-summary-errors.ts LOCAL_SUMMARY_MAX_LINES. */
export const LOCAL_SUMMARY_MAX_LINES = 30;

/** Persisted schema version for ProjectCollectionState; electron/validation.ts. */
export const PROJECT_STATE_VERSION = 1;

/** Largest team cadence electron/team-definition.ts accepts. */
export const MAX_CADENCE_MINUTES = 24 * 60;

/** electron/team-runner.ts deliveryTest: its text opens with the prefix and asks the role to send the answer back. */
export const DELIVERY_TEST_PREFIX = "Delivery test:";
export const DELIVERY_TEST_ANSWER = "ok";

/** electron/usage-grok.ts GROK_USAGE_WINDOW_MS, in the days the UI shows. */
export const GROK_USAGE_WINDOW_DAYS = 7;

/** electron/usage-grok.ts USD_PER_GROK_TICK: Grok cost ticks are 1e-10 USD. */
export const USD_PER_GROK_TICK = 1e-10;

/** electron/board.ts MAX_CARD_DESCRIPTION_CHARS. */
export const MAX_CARD_DESCRIPTION_CHARS = 16_000;

/** electron/board.ts limits on a board and its cards; Settings > Kanban lists them. */
export const MAX_BOARD_COLUMNS = 24;
export const MAX_BOARD_CARDS = 500;
export const MAX_CARD_TITLE_CHARS = 200;
export const MAX_COLUMN_TITLE_CHARS = 80;
export const MAX_CARD_LABELS = 12;
export const MAX_CARD_LABEL_CHARS = 32;
export const MAX_ASSIGNEE_CHARS = 120;
export const MAX_BOARD_IMAGE_BYTES = 8 * 1024 * 1024;
