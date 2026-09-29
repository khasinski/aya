// Renderer timings the e2e suite waits on, so a test derives its deadline
// from the app's own cadence instead of copying the number.

/** A usage snapshot older than this means the source stopped updating - dim it. */
export const USAGE_STALE_AFTER_MS = 15 * 60 * 1000;

/** Cadence for polling the active project's git branch/dirty count (no inotify watch). */
export const GIT_STATUS_POLL_INTERVAL_MS = 3000;
