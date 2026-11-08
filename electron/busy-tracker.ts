// Whether an agent's screen shows work in progress, as a steady signal for the sidebar dot and project badge.
// A turn repaints between tool calls, so a screen that is not busy for one frame is not an idle agent: the
// release waits (BUSY_RELEASE_MS) and any busy frame in the meantime cancels it. A busy pane repeats its state
// now and then so a window attached later learns of it without a screen change.
export const BUSY_RELEASE_MS = 700;
export const BUSY_REPEAT_MS = 5000;

export interface BusyTrackerTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

const realTimers: BusyTrackerTimers = {
  setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); h.unref?.(); return h; },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  now: () => Date.now(),
};

interface Entry { busy: boolean; sentAt: number; release?: unknown }

export class BusyTracker {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly emit: (ptyId: string, busy: boolean) => void,
    private readonly timers: BusyTrackerTimers = realTimers,
    private readonly releaseMs = BUSY_RELEASE_MS,
  ) {}

  /** One observation of the screen: true busy, false not busy, null no opinion (an unreadable screen). */
  observe(ptyId: string, busy: boolean | null): void {
    if (busy === null) return;
    const entry = this.entries.get(ptyId);
    if (busy) {
      if (entry?.release !== undefined) { this.timers.clearTimeout(entry.release); entry.release = undefined; }
      const now = this.timers.now();
      if (entry?.busy && now - entry.sentAt < BUSY_REPEAT_MS) return;
      this.entries.set(ptyId, { busy: true, sentAt: now });
      this.emit(ptyId, true);
      return;
    }
    if (!entry?.busy || entry.release !== undefined) return;
    entry.release = this.timers.setTimeout(() => {
      this.entries.delete(ptyId);
      this.emit(ptyId, false);
    }, this.releaseMs);
  }

  /** The pane is gone (exit, close, host loss): say it is no longer busy right away. */
  release(ptyId: string): void {
    const entry = this.entries.get(ptyId);
    if (!entry) return;
    if (entry.release !== undefined) this.timers.clearTimeout(entry.release);
    this.entries.delete(ptyId);
    if (entry.busy) this.emit(ptyId, false);
  }
}
