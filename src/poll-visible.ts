// Cadence for re-reading the account-wide usage snapshot a user hook writes.
export const USAGE_POLL_INTERVAL_MS = 30_000;
export const SESSION_MONITOR_POLL_INTERVAL_MS = 5_000;

// Run `refresh` now, then on an interval - but skip ticks while the window is
// hidden (no point spawning `git`, re-reading session/usage files in the
// background), and refresh once immediately when it becomes visible again.
// Returns a cleanup that stops the interval and removes the listener.
// `aligned`: ticks fall on multiples of intervalMs of the wall clock, so every caller with the same interval polls in
// the same moment (main batches what they ask then).
export function pollVisible(refresh: () => void, intervalMs: number, options: { aligned?: boolean } = {}): () => void {
  refresh();
  const doc = typeof document !== "undefined" ? document : undefined;
  let timer: number | null = null, start: number | null = null;
  const stopTimer = () => {
    if (timer !== null) window.clearInterval(timer);
    if (start !== null) window.clearTimeout(start);
    timer = start = null;
  };
  const updateTimer = () => {
    if (doc?.hidden) stopTimer();
    else if (timer === null && start === null) {
      if (!options.aligned) timer = window.setInterval(refresh, intervalMs);
      else start = window.setTimeout(() => { start = null; refresh(); timer = window.setInterval(refresh, intervalMs); }, intervalMs - (Date.now() % intervalMs));
    }
  };
  const onVisible = () => { updateTimer(); if (!doc?.hidden) refresh(); };
  updateTimer();
  doc?.addEventListener?.("visibilitychange", onVisible);
  return () => {
    stopTimer();
    doc?.removeEventListener?.("visibilitychange", onVisible);
  };
}
