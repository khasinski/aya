// Single-subscription fan-out for PTY events. Every mounted TerminalView used
// to register its own ipcRenderer listener and filter by ptyId, so one chunk
// woke (visible + warm-pool) listeners — thousands of no-op invocations per
// second under a busy agent. The bus subscribes to the preload bridge ONCE and
// routes each event to exactly the handlers registered for its ptyId (plus the
// App-level router, which needs every event).
//
// The factory is exported for unit tests; the app uses the singleton below.

import type { PtyEvent } from "./types";

type PtyEventHandler = (event: PtyEvent) => void;

export interface PtyEventBus {
  /** Route events for one ptyId (TerminalView). Returns an unsubscribe. */
  onFor(ptyId: string, handler: PtyEventHandler): () => void;
  /** Receive every event (the App-level reducer/timeline router). */
  onAny(handler: PtyEventHandler): () => void;
}

export function createPtyEventBus(
  subscribe: (handler: PtyEventHandler) => () => void,
): PtyEventBus {
  const byId = new Map<string, Set<PtyEventHandler>>();
  const any = new Set<PtyEventHandler>();
  let subscribed = false;

  // Lazy: the underlying (preload) subscription is created on first use and
  // kept for the window's lifetime — the App router is always registered, so
  // tearing it down on empty would just churn the IPC listener.
  const ensureSubscribed = () => {
    if (subscribed) return;
    subscribed = true;
    subscribe((event) => {
      for (const handler of any) handler(event);
      const handlers = byId.get(event.ptyId);
      if (handlers) for (const handler of handlers) handler(event);
    });
  };

  return {
    onFor(ptyId, handler) {
      ensureSubscribed();
      let handlers = byId.get(ptyId);
      if (!handlers) {
        handlers = new Set();
        byId.set(ptyId, handlers);
      }
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
        if (handlers.size === 0) byId.delete(ptyId);
      };
    },
    onAny(handler) {
      ensureSubscribed();
      any.add(handler);
      return () => {
        any.delete(handler);
      };
    },
  };
}

/** App-wide bus over the preload bridge. The closure reads window.aya lazily
 *  (on first onFor/onAny), so importing this module needs no bridge. */
export const ptyEventBus = createPtyEventBus((handler) =>
  window.aya.onPtyEvent(handler),
);
