// Cadence for re-reading the account-wide usage snapshot a user hook writes.
export const USAGE_POLL_INTERVAL_MS = 30_000;
export const SESSION_MONITOR_POLL_INTERVAL_MS = 5_000;

// Run `refresh` now, then on an interval - but skip ticks while the window is
// hidden (no point spawning `git`, re-reading session/usage files in the
// background), and refresh once immediately when it becomes visible again.
// Returns a cleanup that stops the interval and removes the listener.
export function pollVisible(refresh: () => void, intervalMs: number): () => void {
  refresh();
  const id = window.setInterval(() => {
    if (!document.hidden) refresh();
  }, intervalMs);
  const onVisible = () => {
    if (!document.hidden) refresh();
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    window.clearInterval(id);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
