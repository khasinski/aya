// Renderer copies of main-process constants the renderer can't import;
// tests/main-mirrors-parity.test.mjs holds each equal to its electron source.

/** electron/local-summary-errors.ts LOCAL_SUMMARY_MAX_LINES. */
export const LOCAL_SUMMARY_MAX_LINES = 30;

/** Persisted schema version for ProjectCollectionState; electron/validation.ts. */
export const PROJECT_STATE_VERSION = 1;

/** Largest team cadence electron/teams.ts accepts. */
export const MAX_CADENCE_MINUTES = 24 * 60;

/** electron/usage-hook.ts HOOK_THROTTLE_SECONDS, in the minutes the UI shows. */
export const HOOK_THROTTLE_MINUTES = 5;

/** electron/usage-grok.ts GROK_USAGE_WINDOW_MS, in the days the UI shows. */
export const GROK_USAGE_WINDOW_DAYS = 7;

/** electron/usage-grok.ts USD_PER_GROK_TICK: Grok cost ticks are 1e-10 USD. */
export const USD_PER_GROK_TICK = 1e-10;
