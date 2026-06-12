import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { PTY_HOST_SOCKET_PATH, SOCKET_FILE_PERMISSIONS } from "./paths";
import type { HostIdentity } from "./pty-host-staleness";
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
let server: net.Server | null = null;

/** Stop accepting connections and remove the socket file. Called on a clean
 *  shutdown BEFORE the process exits (so a client restarting the host can't
 *  reconnect to this dying process) and again on process-exit signals. */
function closeSocket(): void {
  try {
    server?.close();
  } catch {
    // best effort
  }
  try {
    fs.rmSync(PTY_HOST_SOCKET_PATH, { force: true });
  } catch {
    // best effort
  }
}

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
    // Drop the socket synchronously so a client spawning a fresh host can't
    // reconnect to this exiting process in the window before exit.
    closeSocket();
    setTimeout(() => process.exit(0), 0);
    return null;
  }
  if (request.type === "search") {
    return searchPtyOutputs(request.query);
  }
  if (request.type === "version") {
    return { ...HOST_IDENTITY, ptyCount: activePtyCount() };
  }
  throw new Error("unknown request");
}

/** Identity of the build THIS host process was LAUNCHED from, for the
 *  staleness handshake (#28). Snapshotted once at startup, NOT recomputed per
 *  request: a host that lingers across a reinstall must keep reporting its old
 *  identity even though the asar on disk has since been replaced - otherwise
 *  re-reading disk would make a stale host look current. The script hash makes
 *  two builds that share a version number still differ. */
function computeHostIdentity(): HostIdentity {
  let version = "unknown";
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"),
    ) as { version?: string };
    if (typeof pkg.version === "string") version = pkg.version;
  } catch {
    // fall back to "unknown"; the script hash still distinguishes builds
  }
  let scriptHash = "unknown";
  try {
    scriptHash = crypto
      .createHash("sha256")
      .update(fs.readFileSync(__filename))
      .digest("hex");
  } catch {
    // leave "unknown"
  }
  return { version, scriptHash };
}

const HOST_IDENTITY: HostIdentity = computeHostIdentity();

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

  server = net.createServer((socket) => {
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

  process.once("SIGTERM", closeSocket);
  process.once("SIGINT", closeSocket);
  process.once("exit", closeSocket);
}

start();
