/** One read in flight per source. Visibility/focus bursts do not start duplicate
 * work, failures allow the next tick, and retired consumers ignore late replies. */
export function createPollingTask<T>(read: (signal: AbortSignal) => Promise<T>, receive: (value: T) => void, onError: (error: unknown) => void = () => {}) {
  let stopped = false;
  const cancellation = new AbortController();
  let pending: Promise<void> | null = null;
  return {
    refresh(): void {
      if (stopped || pending) return;
      pending = Promise.resolve().then(async () => { if (stopped) return; const value = await read(cancellation.signal); if (!stopped) receive(value); })
        .catch(error => { if (!stopped) { try { onError(error); } catch { /* A reporting failure must not leak a rejection. */ } } })
        .finally(() => { pending = null; });
    },
    stop(): void { stopped = true; cancellation.abort(); },
  };
}
