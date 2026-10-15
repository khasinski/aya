import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { listenOwnerOnly } from "./owner-socket";
import { PTY_HOST_SOCKET_PATH } from "./pty-host-paths";
import { hostBuildHash, hostRuntimeIdentity, UNKNOWN_SCRIPT_HASH, type HostIdentity } from "./pty-host-staleness";
import {
  writeHostRecord,
  removeHostRecord,
  ownStartTime,
  ownPgid,
} from "./pty-host-registry";
import {
  type PtyHostEventMessage,
  type PtyHostRequest,
  type PtyHostMessage,
  isPtyHostRequest,
} from "./pty-host-protocol";
import { createPtyDataCoalescer } from "./pty-event-coalescer";
import {
  activePtyCount,
  getBufferedOutput,
  getPtyLaunch,
  getPtySize,
  getPtyPid,
  isPtyStarting,
  killPty,
  shutdownPtyChildren,
  resizePty,
  searchPtyOutputs,
  spawnPty,
  writePty,
  type PtyEventSink,
} from "./pty-core";
import { getOwnerRuntime, currentOwnerRuntime, shutdownOwnerRuntime, setOwnerUnavailableListener } from "./pty-owner-runtime";
import { panes, vtSnapshot, markComposerSeen } from "./vt-mirror";
import type { PreparedSpawn } from "./pty-core";
const LAUNCH_STARTING = "starting";
import { PTY_HOST_UNKNOWN_REQUEST } from "./pty-core-constants";

import type { PtyEvent } from "./types";
import { ptyLog } from "./pty-log";
import { keepHostOnUncaught } from "./pty-host-guard";

// Wait before shutting down the idle pty host with no clients or ptys (ms).
// The env override lets a test see the exit without waiting 30 s.
const PREPARE_TIMEOUT_MS = Number(process.env.AYA_PTY_PREPARE_TIMEOUT_MS) || 30_000;
const IDLE_SHUTDOWN_TIMEOUT_MS = Number(process.env.AYA_PTY_HOST_IDLE_MS) || 30_000;
// Random bytes in a registry record's nonce (hex-encoded, so twice as many chars).
const HOST_NONCE_BYTES = 8;
const LOG_HASH_PREFIX_CHARS = 8;

const clients = new Set<net.Socket>();
let idleTimer: NodeJS.Timeout | null = null;
let server: net.Server | null = null;
// The socket file this host bound, by device and inode. When this host exits after a restart, the path may already
// belong to its successor, and removing it then would leave that host serving with no socket.
let ownSocket: { dev: number; ino: number } | null = null;

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
    void shutdownOwnerRuntime().then(() => { removeHostRecord(process.pid); process.exit(0); })
      .catch(error => { ptyLog.append("owner-shutdown-failed", { error: String(error) }); });
  });
}

/** Stop accepting and remove the socket: on a clean shutdown BEFORE exit (a restarting client must not
 *  reach this dying process), and again on exit signals. Only while pty-host.sock is still the file this host
 *  bound: a restart starts the next host as soon as this one answers "shutdown", and this one exits only after its
 *  panes are gone, by when the path is the new host's socket (2026-10-13: removed here, it left the new host
 *  unreachable and the next Aya started a third). That covers server.close() too, which unlinks the bound path
 *  whatever file is there now; a host whose path another took over keeps its listener until it exits, and nobody
 *  can reach it by that path anyway. */
function closeSocket(): void {
  if (!socketPathIsOurs()) {
    ownSocket = null;
    return;
  }
  ownSocket = null;
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

/** True while pty-host.sock is the file this host bound (same device and inode). */
function socketPathIsOurs(): boolean {
  if (!ownSocket) return false;
  try {
    const st = fs.lstatSync(PTY_HOST_SOCKET_PATH);
    return st.dev === ownSocket.dev && st.ino === ownSocket.ino;
  } catch {
    return false;
  }
}

function sendLine(socket: net.Socket, value: PtyHostMessage): void {
  // A client that is gone gets nothing; writing would only raise EPIPE.
  if (socket.destroyed || !socket.writable) return;
  socket.write(`${JSON.stringify("id" in value ? { ...value, ownerBacked: true, hostPid: process.pid } : value)}\n`);
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

interface Preparation {
  complete(data: PreparedSpawn): void;
}

async function handle(request: PtyHostRequest, socket: net.Socket, preparations: Map<number, Preparation>): Promise<unknown> {
  clearIdleTimer();
  if (request.type === "spawn") {
    await spawnPty(request.req, sink, {
      prepare: (req, cwd, signal) => new Promise<PreparedSpawn>((resolve) => {
        const done = (data: PreparedSpawn) => {
          clearTimeout(timer);
          socket.off("close", disconnected);
          signal.removeEventListener("abort", cancelled);
          preparations.delete(request.id);
          if ("failure" in data) sendLine(socket, { type: "cancel-prepare", prepareId: request.id });
          resolve(data);
        };
        const cancelled = () => done({ failure: { reason: "spawn-prepare-failed", message: "Terminal preparation was cancelled." } });
        const disconnected = () => done({ failure: { reason: "spawn-prepare-failed", message: "Aya disconnected while preparing this terminal. Restart the terminal to try again." } });
        const timer = setTimeout(() => done({ failure: { reason: "spawn-prepare-failed", message: "Preparing this terminal timed out. Restart the terminal to try again." } }), PREPARE_TIMEOUT_MS);
        preparations.set(request.id, { complete: done });
        socket.once("close", disconnected);
        signal.addEventListener("abort", cancelled, { once: true });
        if (socket.destroyed) disconnected();
        else sendLine(socket, { type: "prepare", prepareId: request.id, req, cwd });
      }),
      replay: async (req, pid, spawnedAt) => {
        sendLine(socket, { type: "spawned", req, pid, cwd: getPtyLaunch(req.ptyId)?.cwd ?? req.cwd, spawnedAt });
        const snapshot = await vtSnapshot(req.ptyId);
        if (snapshot) sendLine(socket, { type: "snapshot", ptyId: req.ptyId, snapshot, replay: true });
      },
      opened: (req, pid, data) => {
        sendLine(socket, { type: "spawned", req, pid, cwd: data.launch.cwd, spawnedAt: data.spawnedAt });
        const pane = panes.get(req.ptyId);
        if (pane) pane.onSnapshot = (snapshot) => {
          for (const client of clients) sendLine(client, { type: "snapshot", ptyId: req.ptyId, snapshot });
        };
        return () => {};
      },
    });
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
    await killPty(request.ptyId);
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
  if (request.type === "pid") {
    return getPtyPid(request.ptyId);
  }
  if (request.type === "snapshot" && (currentOwnerRuntime()?.incompatible || currentOwnerRuntime()?.disconnected.has(request.ptyId))) return "disconnected";
  if (request.type === "snapshot") return isPtyStarting(request.ptyId) ? "starting" : vtSnapshot(request.ptyId);
  if (request.type === "composer-seen") { markComposerSeen(request.ptyId, request.generation); return null; }
  if (request.type === "prepared") {
    if (!Number.isSafeInteger(request.prepareId) || request.prepareId <= 0) throw new Error("invalid preparation id");
    const pending = preparations.get(request.prepareId);
    // Only a host-created entry's known own method can complete this flight. A late reply is a no-op.
    if (pending && Object.hasOwn(pending, "complete")) pending.complete(request.data);
    return null;
  }
  if (request.type === "launch") {
    return getPtyLaunch(request.ptyId) ?? (isPtyStarting(request.ptyId) ? LAUNCH_STARTING : null);
  }
  if (request.type === "version") {
    // pid lets a client correlate the socket-connected host with a registry
    // record (e.g. to spot a same-version host stranded off-socket).
    const owner = currentOwnerRuntime();
    return { ...HOST_IDENTITY, ptyCount: activePtyCount(), pid: process.pid,
      owner: owner ? { pid: owner.record.pid, hash: owner.record.binaryHash, incompatible: owner.incompatible,
        disconnected: [...owner.disconnected.keys()], inventory: owner.record.panes } : null };
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
  return { version, scriptHash, runtime: hostRuntimeIdentity() };
}

const HOST_IDENTITY: HostIdentity = computeHostIdentity();

function scheduleIdleShutdown(): void {
  // An unknown/retained owner is not an empty host. Idle cleanup cannot
  // authorize the destructive fallback when a spawn acknowledgement was lost.
  if (currentOwnerRuntime()?.incompatible || currentOwnerRuntime()?.disconnected.size) return;
  if (clients.size > 0 || activePtyCount() > 0 || idleTimer) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (clients.size === 0 && activePtyCount() === 0 && !currentOwnerRuntime()?.incompatible && !currentOwnerRuntime()?.disconnected.size) {
      ptyLog.append("host-idle-exit");
      beginShutdown("idle");
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
    const preparations = new Map<number, Preparation>();
    socket.setEncoding("utf8");
    // A client that drops while the host writes to it (EPIPE, ECONNRESET) raises an error on its socket. Without
    // a listener that error is uncaught and ends the host with every pane of every window; the client is simply
    // gone, and "close" below forgets it.
    socket.on("error", (err: NodeJS.ErrnoException) => {
      ptyLog.append("client-error", { code: err.code ?? err.name });
    });
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
            const result = await handle(parsed, socket, preparations);
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

  listenOwnerOnly(server, PTY_HOST_SOCKET_PATH, () => {
    try {
      const st = fs.lstatSync(PTY_HOST_SOCKET_PATH);
      ownSocket = { dev: st.dev, ino: st.ino };
    } catch {
      // no file to own; nothing is removed on exit
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

keepHostOnUncaught(ptyLog);
setOwnerUnavailableListener(owner => {
  for (const id of owner.record.panes.map(p => p.id)) broadcast({ type: "disconnected", ptyId: id });
});
void getOwnerRuntime().then(() => {
  start();
}).catch(error => { ptyLog.append("owner-start-failed", { error: String(error) }); process.exitCode = 1; });
