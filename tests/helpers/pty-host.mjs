// Shared by the tests that drive a real PTY host. Import it dynamically AFTER
// setting AYA_HOME: pty-host-client reads the socket path at module load.

const { PTY_HOST_SOCKET_WAIT_TIMEOUT_MS } = await import(
  "../../dist-electron/pty-host-client.js"
);

/** A cold host may take the client's whole socket wait, then a `-l -i` shell
 *  starts (2-3 s alone, past 4 s under load); this asks "does it happen at all". */
export const HOST_EVENT_TIMEOUT_MS = 3 * PTY_HOST_SOCKET_WAIT_TIMEOUT_MS;

/** Wait until predicate() returns truthy or ms elapses. */
export async function waitFor(predicate, ms = HOST_EVENT_TIMEOUT_MS, step = 25) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = predicate();
    if (v) return v;
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error(`waitFor timed out after ${ms}ms`);
}

export function fakeWebContents() {
  const events = [];
  return {
    isDestroyed: () => false,
    send: (channel, payload) => events.push({ channel, payload }),
    _events: events,
  };
}

/** A PTY event sink that records every event it is sent. */
export function fakeSink() {
  const events = [];
  return { events, sendPtyEvent: (e) => events.push(e), isDestroyed: () => false };
}

export function ptyEventsFor(wc, ptyId) {
  return wc._events
    .filter((e) => e.channel === "pty:event")
    .map((e) => e.payload)
    .filter((p) => p.ptyId === ptyId);
}
