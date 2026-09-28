// Renderer copies of main-process constants the renderer can't import;
// tests/main-mirrors-parity.test.mjs holds each equal to its electron source.

/** electron/local-summary-errors.ts LOCAL_SUMMARY_MAX_LINES. */
export const LOCAL_SUMMARY_MAX_LINES = 30;

/** Persisted schema version for ProjectCollectionState; electron/validation.ts. */
export const PROJECT_STATE_VERSION = 1;
