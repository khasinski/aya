import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { PTY_HOST_SOCKET_PATH, SOCKET_FILE_PERMISSIONS } from "./paths";
import type { HostIdentity } from "./pty-host-staleness";
import {
  writeHostRecord,
  removeHostRecord,
  ownStartTime,
  ownPgid,
} from "./pty-host-registry";
import {
  type PtyHostEventMessage,
  type PtyHostRequest,
  type PtyHostResponse,
  isPtyHostRequest,
} from "./pty-host-protocol";
import { createPtyDataCoalescer } from "./pty-event-coalescer";
import {
  activePtyCount,
  getBufferedOutput,
  killPty,
  shutdownPtyChildren,
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
// Guards against overlapping shutdowns (a socket "shutdown" request racing a
// SIGTERM): the SECOND shutdownPtyChildren call would find the ptys map already
// drained by the first, take the empty-children fast path, and process.exit(0)
// BEFORE the first call's 750ms SIGKILL escalation could fire - orphaning the
// very stuck children the ladder exists to kill. First caller owns the exit.
let hostShutdownStarted = false;

/** Graceful host shutdown, idempotent: drop the socket synchronously (so a
 *  client spawning a fresh host can't reconnect to this exiting process), kill
 *  every child via the graceful->SIGKILL escalation ladder (event-driven, so a
 *  clean quit isn't delayed by a fixed timer, and - unlike a bare
 *  process.exit(0) - the host stays alive long enough to actually deliver the
 *  escalation), then remove the registry record (children confirmed dead; a
 *  crash exit skips this and leaves the record for next-launch GC) and exit. */
function beginShutdown(): void {
  if (hostShutdownStarted) return; // the in-flight shutdown owns the exit
  hostShutdownStarted = true;
  closeSocket();
  shutdownPtyChildren(() => {
    removeHostRecord(process.pid);
    process.exit(0);
  });
}

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
  // NOTE: the registry record is deliberately NOT removed here. closeSocket runs
  // on SIGTERM/SIGINT/exit, i.e. potentially while child PTYs are still alive; if
  // we dropped the record now and the host then died, surviving children would be
  // unreapable orphans (no record to find them by). The record is removed only
  // after a clean shutdown confirms the children are dead (see the shutdown
  // handler); otherwise the next launch GCs it once the pid is verified gone.
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

// Coalesce data chunks per tick before they become JSON socket lines: a busy
// TUI's many small node-pty reads collapse into one line per stream per tick,
// instead of one stringify+write per read (see pty-event-coalescer.ts).
const broadcastCoalesced = createPtyDataCoalescer(broadcast);

const sink: PtyEventSink = {
  isDestroyed: () => false,
  sendPtyEvent: (event) => broadcastCoalesced.push(event),
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
    beginShutdown();
    return null;
  }
  if (request.type === "search") {
    return searchPtyOutputs(request.query);
  }
  if (request.type === "buffer") {
    return getBufferedOutput(request.ptyId);
  }
  if (request.type === "version") {
    // pid lets a client correlate the socket-connected host with a registry
    // record (e.g. to spot a same-version host stranded off-socket).
    return { ...HOST_IDENTITY, ptyCount: activePtyCount(), pid: process.pid };
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
    // Publish our registry record so a future app version can reap THIS host by
    // pid if it turns out stale. Written after listen so the record only exists
    // once we're actually serving. Leadership is VERIFIED via the OS, not
    // assumed from detached spawn: the reaper's kill(-pgid) is only safe when
    // this process really leads its own group, so if it doesn't (alternate
    // launcher, future spawn change) we skip the record - degrading to
    // pre-registry behavior instead of recording an unkillable/foreign group.
    // writeHostRecord itself refuses an empty startTime (unverifiable record).
    const pgid = ownPgid();
    if (pgid === process.pid) {
      writeHostRecord({
        pid: process.pid,
        pgid,
        version: HOST_IDENTITY.version,
        scriptHash: HOST_IDENTITY.scriptHash,
        startTime: ownStartTime(),
        nonce: crypto.randomBytes(8).toString("hex"),
      });
    }
  });

  // SIGTERM/SIGINT: registering a handler SUPPRESSES node's default termination,
  // so closeSocket alone would leave a socketless zombie host running with live
  // children (and, being same-version, the registry would keep it forever). Do a
  // real graceful shutdown instead - beginShutdown is idempotent, so a signal
  // racing an in-flight socket "shutdown" joins it instead of double-draining.
  process.once("SIGTERM", beginShutdown);
  process.once("SIGINT", beginShutdown);
  process.once("exit", closeSocket);
}

start();
