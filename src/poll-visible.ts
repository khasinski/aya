// Cadence for re-reading the account-wide usage snapshot a user hook writes.
export const USAGE_POLL_INTERVAL_MS = 30_000;
export const SESSION_MONITOR_POLL_INTERVAL_MS = 5_000;

// Run `refresh` now, then on an interval - but skip ticks while the window is
// hidden (no point spawning `git`, re-reading session/usage files in the
// background), and refresh once immediately when it becomes visible again.
// Returns a cleanup that stops the interval and removes the listener.
export function pollVisible(refresh: () => void, intervalMs: number): () => void {
  refresh();
  const doc = typeof document !== "undefined" ? document : undefined;
  let timer: number | null = null;
  const updateTimer = () => {
    if (doc?.hidden) { if (timer !== null) window.clearInterval(timer); timer = null; }
    else if (timer === null) timer = window.setInterval(refresh, intervalMs);
  };
  const onVisible = () => { updateTimer(); if (!doc?.hidden) refresh(); };
  updateTimer();
  doc?.addEventListener?.("visibilitychange", onVisible);
  return () => {
    if (timer !== null) window.clearInterval(timer);
    doc?.removeEventListener?.("visibilitychange", onVisible);
  };
}
