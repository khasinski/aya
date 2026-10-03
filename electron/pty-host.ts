import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { PTY_HOST_SOCKET_PATH, SOCKET_FILE_PERMISSIONS } from "./paths";
import { hostBuildHash, UNKNOWN_SCRIPT_HASH, type HostIdentity } from "./pty-host-staleness";
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
  getPtyLaunch,
  getPtySize,
  getPtyCwd,
  getPtyPid,
  isPtyStarting,
  killPty,
  shutdownPtyChildren,
  resizePty,
  searchPtyOutputs,
  spawnPty,
  writePty,
  type PtyEventSink,
} from "./pty";
import { paneBusy, paneHold } from "./vt-state";
import { LAUNCH_STARTING } from "./launch-mode";
import { PTY_HOST_UNKNOWN_REQUEST } from "./constants";
import { HOLD_STARTING } from "./pane-holds";
import type { PtyEvent } from "./types";
import { ptyLog } from "./pty-log";

// Wait before shutting down the idle pty host with no clients or ptys (ms).
// The env override lets a test see the exit without waiting 30 s.
const IDLE_SHUTDOWN_TIMEOUT_MS = Number(process.env.AYA_PTY_HOST_IDLE_MS) || 30_000;
// Random bytes in a registry record's nonce (hex-encoded, so twice as many chars).
const HOST_NONCE_BYTES = 8;
const LOG_HASH_PREFIX_CHARS = 8;

const clients = new Set<net.Socket>();
let idleTimer: NodeJS.Timeout | null = null;
let server: net.Server | null = null;

// Guards against overlapping shutdowns (a socket "shutdown" request racing a
// SIGTERM): the SECOND shutdownPtyChildren call would find the ptys map already
// drained by the first, take the empty-children fast path, and process.exit(0)
// BEFORE the first call's 750ms SIGKILL escalation could fire - orphaning the
// very stuck children the ladder exists to kill. First caller owns the exit.
let hostShutdownStarted = false;

/** Idempotent: socket dropped at once, children through the SIGKILL ladder (the host lives to deliver it),
 *  then the registry record goes (a crash leaves it for next launch's GC) and the process exits. */
function beginShutdown(reason: string): void {
  if (hostShutdownStarted) return; // the in-flight shutdown owns the exit
  hostShutdownStarted = true;
  // The reason is the single most valuable line in the lifecycle log: it
  // distinguishes "a client told this host to die" (staleness handoff) from
  // an OS signal when every console dies at once.
  ptyLog.append("host-shutdown", { reason, children: activePtyCount() });
  closeSocket();
  shutdownPtyChildren(() => {
    removeHostRecord(process.pid);
    process.exit(0);
  });
}

/** Stop accepting and remove the socket: on a clean shutdown BEFORE exit (a restarting client must not
 *  reach this dying process), and again on exit signals. */
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

function clearIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

async function handle(request: PtyHostRequest): Promise<unknown> {
  clearIdleTimer();
  if (request.type === "spawn") {
    await spawnPty(request.req, sink);
    return null;
  }
  if (request.type === "write") {
    // The boolean IS the answer: false means the id had no live process, which
    // the control server turns into a failed `aya pane send` instead of a
    // silent no-op. An older host answers null here; the client reads any
    // non-false result as "delivered", so it degrades to the old behaviour.
    return writePty(request.ptyId, request.data);
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
    beginShutdown("client-request");
    return null;
  }
  if (request.type === "search") {
    return searchPtyOutputs(request.query);
  }
  if (request.type === "buffer") {
    return getBufferedOutput(request.ptyId);
  }
  if (request.type === "size") {
    return getPtySize(request.ptyId);
  }
  if (request.type === "cwd") {
    return getPtyCwd(request.ptyId);
  }
  if (request.type === "pid") {
    return getPtyPid(request.ptyId);
  }
  if (request.type === "hold") {
    // A pane still in its spawn preflight has no mirror yet; it is starting,
    // not gone.
    return isPtyStarting(request.ptyId) ? HOLD_STARTING : paneHold(request.ptyId, request.pasted);
  }
  if (request.type === "busy") return paneBusy(request.ptyId);
  if (request.type === "launch") {
    return getPtyLaunch(request.ptyId) ?? (isPtyStarting(request.ptyId) ? LAUNCH_STARTING : null);
  }
  if (request.type === "version") {
    // pid lets a client correlate the socket-connected host with a registry
    // record (e.g. to spot a same-version host stranded off-socket).
    return { ...HOST_IDENTITY, ptyCount: activePtyCount(), pid: process.pid };
  }
  throw new Error(PTY_HOST_UNKNOWN_REQUEST);
}

/** The build THIS host was launched from, snapshotted at startup: re-reading disk after a reinstall
 *  would make a stale host look current. The script hash tells apart builds sharing a version. */
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
  let scriptHash = UNKNOWN_SCRIPT_HASH;
  try {
    scriptHash = hostBuildHash(__dirname, path.basename(__filename));
  } catch {
    // leave UNKNOWN_SCRIPT_HASH
  }
  return { version, scriptHash };
}

const HOST_IDENTITY: HostIdentity = computeHostIdentity();

function scheduleIdleShutdown(): void {
  if (clients.size > 0 || activePtyCount() > 0 || idleTimer) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (clients.size === 0 && activePtyCount() === 0) {
      ptyLog.append("host-idle-exit");
      process.exit(0);
    }
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
    // The disconnect re-arms a full wait; a timer armed before this client came must not cut it short.
    clearIdleTimer();
    // Log the socket lifecycle (#83): a mass console reload with the host alive
    // is expected to show a client-disconnect (the old renderer dropping its
    // socket on reload) immediately followed by a client-connect and a burst of
    // fresh `spawn` lines - the signature of a renderer reload cold-respawning
    // every tab, as opposed to the children being killed (which would log
    // `exit` lines with a signal instead).
    ptyLog.append("client-connect", { clients: clients.size });
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("close", () => {
      clients.delete(socket);
      ptyLog.append("client-disconnect", { clients: clients.size });
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
    // A host whose app died before connecting gets no disconnect to arm this.
    scheduleIdleShutdown();
    ptyLog.append("host-start", {
      version: HOST_IDENTITY.version,
      scriptHash: HOST_IDENTITY.scriptHash.slice(0, LOG_HASH_PREFIX_CHARS),
    });
    // The registry record lets a later app reap this host if stale; only once serving, and only when the OS says this
    // process leads its group (the reaper kills -pgid): otherwise no record rather than a foreign group's.
    const pgid = ownPgid();
    if (pgid === process.pid) {
      writeHostRecord({
        pid: process.pid,
        pgid,
        version: HOST_IDENTITY.version,
        scriptHash: HOST_IDENTITY.scriptHash,
        startTime: ownStartTime(),
        nonce: crypto.randomBytes(HOST_NONCE_BYTES).toString("hex"),
      });
    }
  });

  // SIGTERM/SIGINT: registering a handler SUPPRESSES node's default termination,
  // so closeSocket alone would leave a socketless zombie host running with live
  // children (and, being same-version, the registry would keep it forever). Do a
  // real graceful shutdown instead - beginShutdown is idempotent, so a signal
  // racing an in-flight socket "shutdown" joins it instead of double-draining.
  process.once("SIGTERM", () => beginShutdown("SIGTERM"));
  process.once("SIGINT", () => beginShutdown("SIGINT"));
  process.once("exit", closeSocket);
}

start();
