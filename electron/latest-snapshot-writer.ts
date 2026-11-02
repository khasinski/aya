/** Keep one active write and one replacement snapshot, regardless of burst size.
 * Callers replaced before starting settle with the write that supersedes them. */
export class LatestSnapshotWriter<T> {
  private pending: { resolve: () => void; reject: (error: unknown) => void }[] = [];
  private latest!: T;
  private running = false;
  constructor(private write: (value: T) => Promise<void>) {}
  save(value: T): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // Keep waiters but release the superseded (potentially large) value.
      this.latest = value;
      this.pending.push({ resolve, reject });
      if (!this.running) void this.drain();
    });
  }
  private async drain() {
    this.running = true;
    while (this.pending.length) {
      const batch = this.pending;
      const value = this.latest;
      this.pending = [];
      try { await this.write(value); for (const waiter of batch) waiter.resolve(); }
      catch (error) { for (const waiter of batch) waiter.reject(error); }
    }
    this.running = false;
  }
  get idle() { return !this.running; }
}
