import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { PTY_HOST_SOCKET_PATH, SOCKET_FILE_PERMISSIONS } from "./paths";
import {
  type PtyHostEventMessage,
  type PtyHostRequest,
  type PtyHostResponse,
  isPtyHostRequest,
} from "./pty-host-protocol";
import {
  activePtyCount,
  killPty,
  killAll,
  resizePty,
  searchPtyOutputs,
  spawnPty,
  writePty,
  type PtyEventSink,
} from "./pty";
import type { PtyEvent } from "./types";

// Wait before shutting down the idle pty host with no clients or ptys (ms).
const IDLE_SHUTDOWN_TIMEOUT_MS = 30_000;

const clients = new Set<net.Socket>();
let idleTimer: NodeJS.Timeout | null = null;

function sendLine(socket: net.Socket, value: PtyHostResponse | PtyHostEventMessage): void {
  socket.write(`${JSON.stringify(value)}\n`);
}

function broadcast(event: PtyEvent): void {
  const message: PtyHostEventMessage = { type: "event", event };
  for (const client of clients) {
    if (!client.destroyed) sendLine(client, message);
  }
  scheduleIdleShutdown();
}

const sink: PtyEventSink = {
  isDestroyed: () => false,
  sendPtyEvent: broadcast,
};

async function handle(request: PtyHostRequest): Promise<unknown> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (request.type === "spawn") {
    await spawnPty(request.req, sink);
    return null;
  }
  if (request.type === "write") {
    writePty(request.ptyId, request.data);
    return null;
  }
  if (request.type === "resize") {
    resizePty(request.ptyId, request.cols, request.rows);
    return null;
  }
  if (request.type === "kill") {
    killPty(request.ptyId);
    return null;
  }
  if (request.type === "shutdown") {
    killAll();
    setTimeout(() => process.exit(0), 0);
    return null;
  }
  if (request.type === "search") {
    return searchPtyOutputs(request.query);
  }
  throw new Error("unknown request");
}

function scheduleIdleShutdown(): void {
  if (clients.size > 0 || activePtyCount() > 0 || idleTimer) return;
  idleTimer = setTimeout(() => {
    if (clients.size === 0 && activePtyCount() === 0) process.exit(0);
  }, IDLE_SHUTDOWN_TIMEOUT_MS);
}

function start(): void {
  fs.mkdirSync(path.dirname(PTY_HOST_SOCKET_PATH), { recursive: true });
  try {
    fs.rmSync(PTY_HOST_SOCKET_PATH, { force: true });
  } catch {
    // best effort
  }

  const server = net.createServer((socket) => {
    clients.add(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("close", () => {
      clients.delete(socket);
      scheduleIdleShutdown();
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const idx = buffer.indexOf("\n");
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        void (async () => {
          let requestId = -1;
          try {
            const parsed = JSON.parse(line) as unknown;
            if (parsed && typeof parsed === "object") {
              const maybeId = (parsed as { id?: unknown }).id;
              if (typeof maybeId === "number") requestId = maybeId;
            }
            if (!isPtyHostRequest(parsed)) throw new Error("invalid request");
            const result = await handle(parsed);
            sendLine(socket, { id: parsed.id, ok: true, result });
          } catch (err) {
            sendLine(socket, {
              id: requestId,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        })();
      }
    });
  });

  server.listen(PTY_HOST_SOCKET_PATH, () => {
    try {
      fs.chmodSync(PTY_HOST_SOCKET_PATH, SOCKET_FILE_PERMISSIONS);
    } catch {
      // best effort
    }
  });

  const cleanup = () => {
    try {
      server.close();
    } catch {
      // best effort
    }
    try {
      fs.rmSync(PTY_HOST_SOCKET_PATH, { force: true });
    } catch {
      // best effort
    }
  };
  process.once("SIGTERM", cleanup);
  process.once("SIGINT", cleanup);
  process.once("exit", cleanup);
}

start();
