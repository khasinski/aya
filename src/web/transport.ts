// Aya Web (experimental) — WebSocket transport for the window.aya bridge.

import {
  encodeInvokeFrame,
  parseServerFrame,
  type WebHelloFrame,
} from "./protocol";

const CONNECT_TIMEOUT_MS = 10_000;

export interface WebTransport {
  hello: WebHelloFrame;
  invoke(channel: string, args: unknown[]): Promise<unknown>;
  /** Subscribe to server-push events for one channel. */
  onEvent(channel: string, handler: (payload: unknown) => void): () => void;
  /** Fired once when the socket dies (any reason). */
  onClose(handler: () => void): () => void;
}

/** Open the bridge socket and resolve once the server's hello arrives (the
 *  hello doubles as the auth check — an unauthenticated upgrade never gets
 *  this far). */
export function connectWebTransport(url: string): Promise<WebTransport> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map<
      number,
      { resolve: (value: unknown) => void; reject: (err: Error) => void }
    >();
    const eventHandlers = new Map<string, Set<(payload: unknown) => void>>();
    const closeHandlers = new Set<() => void>();
    let nextId = 1;
    let settled = false;
    let closed = false;

    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.close();
      reject(new Error("Connection timed out"));
    }, CONNECT_TIMEOUT_MS);

    const fail = (message: string) => {
      if (!settled) {
        settled = true;
        window.clearTimeout(timeout);
        reject(new Error(message));
      }
    };

    socket.onerror = () => fail("Connection failed");
    socket.onclose = () => {
      fail("Connection closed");
      if (closed) return;
      closed = true;
      for (const [, p] of pending) {
        p.reject(new Error("Aya Web connection lost"));
      }
      pending.clear();
      for (const handler of closeHandlers) handler();
    };

    socket.onmessage = (message) => {
      const frame = parseServerFrame(message.data);
      if (!frame) return;
      if (frame.t === "hello") {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        resolve({
          hello: frame,
          invoke(channel, args) {
            if (socket.readyState !== WebSocket.OPEN) {
              return Promise.reject(new Error("Aya Web connection lost"));
            }
            const id = nextId++;
            return new Promise((resolveInvoke, rejectInvoke) => {
              pending.set(id, {
                resolve: resolveInvoke,
                reject: rejectInvoke,
              });
              socket.send(encodeInvokeFrame(id, channel, args));
            });
          },
          onEvent(channel, handler) {
            let handlers = eventHandlers.get(channel);
            if (!handlers) {
              handlers = new Set();
              eventHandlers.set(channel, handlers);
            }
            handlers.add(handler);
            return () => {
              handlers.delete(handler);
              if (handlers.size === 0) eventHandlers.delete(channel);
            };
          },
          onClose(handler) {
            closeHandlers.add(handler);
            return () => closeHandlers.delete(handler);
          },
        });
        return;
      }
      if (frame.t === "result") {
        const entry = pending.get(frame.id);
        if (!entry) return;
        pending.delete(frame.id);
        if (frame.ok) entry.resolve(frame.value);
        else entry.reject(new Error(frame.error ?? "Unknown error"));
        return;
      }
      const handlers = eventHandlers.get(frame.channel);
      if (handlers) {
        for (const handler of handlers) handler(frame.payload);
      }
    };
  });
}

export function webSocketUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws`;
}
