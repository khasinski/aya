// The host drops a write for a pty it has not seen spawn, and a pane's first keystrokes can reach main
// while its spawn still sits in async preflight: a write waits for the spawn of its own pane.

interface Flight {
  cancelled: boolean;
  /** The request is with the host, which cancels it on its own from here. */
  sent: boolean;
}

export function createSpawnGate() {
  const flights = new Map<string, Promise<unknown>>();
  const live = new Map<string, Set<Flight>>();
  return {
    /** A `cancel` during `prepare` skips `send`. */
    spawn<P, T = P>(ptyId: string, prepare: () => Promise<P>, send: (prepared: P) => Promise<T> = async (p) => p as unknown as T): Promise<T | undefined> {
      const flight: Flight = { cancelled: false, sent: false };
      live.set(ptyId, (live.get(ptyId) ?? new Set()).add(flight));
      const run = async () => {
        try {
          const prepared = await prepare();
          if (flight.cancelled) return undefined;
          flight.sent = true;
          return await send(prepared);
        } finally {
          live.get(ptyId)?.delete(flight);
          if (live.get(ptyId)?.size === 0) live.delete(ptyId);
        }
      };
      const result = run();
      const tracked = result.then(
        () => undefined,
        () => undefined,
      );
      flights.set(ptyId, tracked);
      void tracked.then(() => {
        if (flights.get(ptyId) === tracked) flights.delete(ptyId);
      });
      return result;
    },
    /** A respawn that started meanwhile is waited for too. */
    async afterSpawn(ptyId: string): Promise<void> {
      for (let flight = flights.get(ptyId); flight; flight = flights.get(ptyId)) await flight;
    },
    inFlight: () => flights.size,
    spawning: (ptyId: string) => [...(live.get(ptyId) ?? [])].some((f) => !f.cancelled),
    /** True when it cancelled any and none of the spawns is with the host (a sent one is the host's to cancel). */
    cancel(ptyId: string): boolean {
      const flightsOf = [...(live.get(ptyId) ?? [])];
      const pending = flightsOf.filter((f) => !f.sent && !f.cancelled);
      for (const f of pending) f.cancelled = true;
      return pending.length > 0 && !flightsOf.some((f) => f.sent);
    },
  };
}

type SpawnGate = ReturnType<typeof createSpawnGate>;

/** With nothing sent to the host and nothing in it to kill, the host is not told:
 *  its kill marker would outlive the cancelled spawn and eat the next. */
export async function closePane(
  gate: Pick<SpawnGate, "cancel">,
  ptyId: string,
  host: { hasPane: (ptyId: string) => Promise<boolean>; kill: (ptyId: string) => Promise<void> },
): Promise<void> {
  const cancelled = gate.cancel(ptyId);
  if (cancelled && !(await host.hasPane(ptyId))) return;
  await host.kill(ptyId);
}
