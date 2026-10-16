import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { listenOwnerOnly } from "./owner-socket";
import { PTY_HOST_SOCKET_PATH, PTY_HANDOVER_CORE_DIRECTORY, PTY_HANDOVER_DISPLAY_DIRECTORY } from "./pty-host-paths";
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
  acknowledgePtyExit,
  acknowledgePtyRestoration,
  activePtyCount,
  hasUnattachedRestoredPanes,
  restoredPtyLaunches,
  ptyOwnerContinuityPanes,
  restorePtyCorePane,
  recoverPtyCorePane,
  ptyRecoveryStates,
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
  ptyCoreHandoverInProgress,
} from "./pty-core";
import { getOwnerRuntime, currentOwnerRuntime, shutdownOwnerRuntime, requireRecoveryOwner, requireOwnerExitAcknowledgements, setOwnerUnavailableListener, ownerHandoverCredential } from "./pty-owner-runtime";
import { HandoverWindow, handoverPeer } from "./pty-handover-window";
import {readRecoveryBootstrap,MAX_RECOVERY_BOOTSTRAP_BYTES} from "./pty-recovery-bootstrap";
import {readHandoverBootstrap,preflightCoreHandover,readCoreHandover} from "./pty-handover-bootstrap";
import {acknowledgeCheckpoint} from "./pty-checkpoint-store";
import { HostHandover } from "./pty-host-handover";
import { ownerProcessStartIdentity } from "./pty-owner-client";
import { panes, vtSnapshot, markComposerSeen } from "./vt-mirror";
import type { PreparedSpawn } from "./pty-core";
const LAUNCH_STARTING = "starting";
import { PTY_HOST_UNKNOWN_REQUEST } from "./pty-core-constants";

import type { PtyEvent } from "./types";
import { ptyLog } from "./pty-log";
import { keepHostOnUncaught } from "./pty-host-guard";
import {HostSocketAuthenticator,HostAuthPrincipal} from "./pty-host-auth-transport";
import {readInheritedHostAuthKey} from "./pty-host-auth-bootstrap";

// Wait before shutting down the idle pty host with no clients or ptys (ms).
// The env override lets a test see the exit without waiting 30 s.
const PREPARE_TIMEOUT_MS = Number(process.env.AYA_PTY_PREPARE_TIMEOUT_MS) || 30_000;
const IDLE_SHUTDOWN_TIMEOUT_MS = Number(process.env.AYA_PTY_HOST_IDLE_MS) || 30_000;
// Random bytes in a registry record's nonce (hex-encoded, so twice as many chars).
const HOST_NONCE_BYTES = 8;
const LOG_HASH_PREFIX_CHARS = 8;

const clients = new Set<net.Socket>();
let crashBoot=false;
let socketAuthenticator:HostSocketAuthenticator;
const handoverWindow = new HandoverWindow();
const hostHandover = new HostHandover(PTY_HANDOVER_CORE_DIRECTORY, PTY_HANDOVER_DISPLAY_DIRECTORY);
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
  if (hostHandover.committed) {
    // A quit/signal racing the committed cutover must only end this JS host.
    // The owner is already reserved for the successor, never shut it down.
    hostShutdownStarted=true;clearIdleTimer();closeSocket();removeHostRecord(process.pid);process.exit(0);
  }
  hostShutdownStarted = true;
  // The reason is the single most valuable line in the lifecycle log: it
  // distinguishes "a client told this host to die" (staleness handoff) from
  // an OS signal when every console dies at once.
  ptyLog.append("host-shutdown", { reason, children: activePtyCount() });
  closeSocket();
  void hostHandover.abort().catch(error => {ptyLog.append("checkpoint-abort-failed", {error:String(error)});}).then(() => {
    shutdownPtyChildren(() => {
      void shutdownOwnerRuntime().then(() => { removeHostRecord(process.pid); process.exit(0); })
        .catch(error => { ptyLog.append("owner-shutdown-failed", { error: String(error) }); });
    });
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
  const owner=currentOwnerRuntime();
  const ownerIdentity=owner?{pid:owner.record.pid,startTime:owner.record.startTime,instanceId:owner.record.instanceId,binaryHash:owner.record.binaryHash,incompatible:owner.incompatible}:undefined;
  socket.write(`${JSON.stringify("id" in value ? { ...value, ownerBacked: true, hostPid: process.pid,ownerIdentity } : value.type==="spawned"?{...value,ownerIdentity}:value)}\n`);
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

function installSnapshotFanout(id:string):void {
  const pane=panes.get(id);
  if(pane)pane.onSnapshot=snapshot=>{for(const client of clients)sendLine(client,{type:"snapshot",ptyId:id,snapshot});};
}

function clearIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

interface Preparation {
  complete(data: PreparedSpawn): void;
}

async function handle(request: PtyHostRequest, socket: net.Socket, preparations: Map<number, Preparation>): Promise<unknown> {
  clearIdleTimer();
  if(request.type==="exit-observed"){
    if(typeof request.ptyId!=="string"||request.ptyId.length>128||!Number.isInteger(request.generation)||request.generation<1||request.generation>0xffffffff||!Number.isInteger(request.event)||request.event<1||request.event>0xffffffff)throw Error("Invalid terminal exit acknowledgement");
    return acknowledgePtyExit(request.ptyId,request.generation,request.event);
  }
  if(request.type === "handover-display-applied"){
    if(typeof request.ptyId!=="string"||request.ptyId.length>128||typeof request.generation!=="string"||request.generation.length>128||(request.token!==undefined&&(typeof request.token!=="string"||request.token.length>128)))throw Error("Invalid applied display acknowledgement");
    return acknowledgePtyRestoration(request.ptyId,request.generation,request.token);
  }
  if (request.type === "handover-prepare") {
    const owner = currentOwnerRuntime();
    if (!owner?.client?.isConnected() || owner.incompatible || owner.disconnected.size || owner.record.uncertain?.length) throw new Error("This host's processes cannot move seamlessly");
    const result = await hostHandover.prepare(handoverPeer(socket),request.deadline);
    // The response is an output fence for main and its renderer capture IPC.
    broadcastCoalesced.flush();
    return result;
  }
  if (request.type === "handover-publish") return hostHandover.publish(handoverPeer(socket),request.display,request.consented);
  if (request.type === "handover-announce") {
    const owner = currentOwnerRuntime(), identity = ownerProcessStartIdentity(process.pid);
    if (!identity || !owner?.client?.isConnected() || owner.incompatible || owner.disconnected.size || owner.record.uncertain?.length) throw new Error("This host cannot announce a seamless handover");
    const peer = handoverPeer(socket);
    if (hostHandover.active) hostHandover.assertAnnouncement(peer,request.deadline);
    handoverWindow.announce(request.nonce, request.deadline, peer);
    return {hostPid: process.pid, hostStartIdentity: identity};
  }
  if (request.type === "handover-cancel") {
    const peer = handoverPeer(socket);
    await hostHandover.abort(peer);
    try{handoverWindow.acknowledgeReuse(peer);}catch{handoverWindow.cancel(peer);}
    return null;
  }
  if (request.type === "handover-claim") {
    const peer = handoverPeer(socket);
    const alreadyTransferred = !!handoverWindow.transferredTo;
    let checkpoint;
    try {
      if (request.reuse !== undefined && typeof request.reuse !== "boolean") throw new Error("Invalid handover claim");
      handoverWindow.consume(request.nonce, peer, !request.reuse);
      checkpoint = hostHandover.active ? hostHandover.adopt(peer) : null;
    } catch (error) {
      // A failed first claim ends the attempt and resumes the old processes.
      // A later rejected claimant cannot cancel the chosen recipient's work.
      if (!alreadyTransferred) await hostHandover.abort().catch(() => {});
      throw error;
    }
    if (!currentOwnerRuntime()?.client?.isConnected()) throw new Error("The announced owner is unavailable");
    // A one-shot in-memory response on the private local socket. This value
    // never reaches broadcast, a checkpoint, process arguments or a log.
    return {...(!request.reuse ? {credential: ownerHandoverCredential().toString("base64")} : {}), ...(checkpoint ? {checkpoint} : {})};
  }
  if (request.type === "handover-reuse") {
    const peer=handoverPeer(socket);handoverWindow.assertReuse(peer);return hostHandover.reuse(peer);
  }
  if (request.type === "handover-ack-reuse") {
    const peer = handoverPeer(socket);
    handoverWindow.assertReuse(peer);
    await hostHandover.acknowledgeReuse(peer);handoverWindow.acknowledgeReuse(peer);return null;
  }
  if (request.type === "handover-detach") {
    if (!Array.isArray(request.consented) || request.consented.length > 25 || request.consented.some(id => typeof id !== "string" || id.length > 128)) throw new Error("Invalid consented pane identities");
    return hostHandover.detach(handoverPeer(socket),request.consented);
  }
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
        sendLine(socket, { type: "spawned", req, pid, cwd: getPtyLaunch(req.ptyId)?.cwd ?? req.cwd, launch:getPtyLaunch(req.ptyId)??undefined, spawnedAt });
        const snapshot = await vtSnapshot(req.ptyId);
        if (snapshot) sendLine(socket, { type: "snapshot", ptyId: req.ptyId, snapshot, replay: true });
      },
      opened: (req, pid, data) => {
        sendLine(socket, { type: "spawned", req, pid, cwd: data.launch.cwd, launch:data.launch, spawnedAt: data.spawnedAt });
        installSnapshotFanout(req.ptyId);
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
    if(request.target!==undefined){
      const t=request.target;
      if(!t||t.pid!==process.pid||typeof t.startTime!=="string"||t.startTime.length>128||ownerProcessStartIdentity(process.pid)!==t.startTime||
        !(t.ownerInstance===null||typeof t.ownerInstance==="string"&&/^[a-f0-9]{32}$/.test(t.ownerInstance))||
        t.ownerInstance!==(currentOwnerRuntime()?.record.instanceId??null))throw Error("The terminal host or native owner changed. Nothing was stopped; review the current inventory again.");
    }
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
  if (request.type === "composer-seen") {
    if (ptyCoreHandoverInProgress()) throw new Error("Terminal metadata is paused for handover");
    markComposerSeen(request.ptyId, request.generation); return null;
  }
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
  if(request.type==="owner-continuity"){
    const owner=currentOwnerRuntime();
    if(!owner||owner.incompatible||!owner.client?.isConnected()||ptyCoreHandoverInProgress()||preparations.size||owner.record.uncertain?.length||owner.record.spawnIntents?.length)throw Error("Terminal owner recovery continuity is unavailable");
    const client=owner.client,inventory=await client.list();
    if(client!==owner.client||!client.isConnected()||owner.incompatible||ptyCoreHandoverInProgress()||preparations.size||owner.record.uncertain?.length||owner.record.spawnIntents?.length)throw Error("Terminal owner changed during recovery continuity");
    const panes=ptyOwnerContinuityPanes(inventory),startIdentity=ownerProcessStartIdentity(process.pid);
    if(!startIdentity)throw Error("Terminal host identity is unavailable");
    const credential=ownerHandoverCredential();
    try{
      const result={format:1,host:{pid:process.pid,startIdentity},secret:credential.toString("hex"),bootstrap:{format:1,kind:"crash",owner:{pid:owner.record.pid,startTime:owner.record.startTime,instanceId:owner.record.instanceId,binaryHash:owner.record.binaryHash},panes}};
      if(Buffer.byteLength(JSON.stringify(result))>MAX_RECOVERY_BOOTSTRAP_BYTES)throw Error("Terminal owner continuity length limit");
      return result;
    }finally{credential.fill(0);}
  }
  if (request.type === "version") {
    // pid lets a client correlate the socket-connected host with a registry
    // record (e.g. to spot a same-version host stranded off-socket).
    const owner = currentOwnerRuntime();
    return { ...HOST_IDENTITY, ptyCount: activePtyCount(), pid: process.pid,...(crashBoot?{recovery:ptyRecoveryStates()}:{}),
      owner: owner ? { pid: owner.record.pid,startIdentity:owner.record.startIdentity,instanceId:owner.record.instanceId,startTime:owner.record.startTime, hash: owner.record.binaryHash, incompatible: owner.incompatible,
        disconnected: [...owner.disconnected.keys()], inventory: owner.record.panes, uncertain: owner.record.uncertain ?? [], recoveryFailures: owner.record.recoveryFailures ?? [] } : null };
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
  if (hostHandover.active || hasUnattachedRestoredPanes()) return;
  // An unknown/retained owner is not an empty host. Idle cleanup cannot
  // authorize the destructive fallback when a spawn acknowledgement was lost.
  if (currentOwnerRuntime()?.incompatible || currentOwnerRuntime()?.disconnected.size) return;
  if (clients.size > 0 || activePtyCount() > 0 || idleTimer) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (!hostHandover.active && !hasUnattachedRestoredPanes() && clients.size === 0 && activePtyCount() === 0 && !currentOwnerRuntime()?.incompatible && !currentOwnerRuntime()?.disconnected.size) {
      ptyLog.append("host-idle-exit");
      beginShutdown("idle");
    }
  }, IDLE_SHUTDOWN_TIMEOUT_MS);
}


function attachAuthenticatedClient(socket:net.Socket,initialBuffer:string):void {
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
    const onData = (chunk:string|Buffer) => {
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
            if (parsed.type === "handover-detach") {
              // The owner and pane processes stay alive. Exit after flushing
              // the commit response; never enter the destructive shutdown path.
              hostShutdownStarted = true;clearIdleTimer();closeSocket();
              removeHostRecord(process.pid);
              const timer=setTimeout(()=>process.exit(0),1000);timer.unref();
              socket.end(()=>process.exit(0));
            }
          } catch (err) {
            sendLine(socket, {
              id: requestId,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        })();
      }
    };
    socket.on("data",onData);
    // Main owns session watches even for a view that will mount much later.
    // These are bounded per-pane launch records, never aggregate VT payloads.
    for(const pane of restoredPtyLaunches()){
      sendLine(socket,{type:"spawned",...pane,launch:getPtyLaunch(pane.req.ptyId)??undefined,restored:true,ownerBacked:true,hostPid:process.pid});
      void vtSnapshot(pane.req.ptyId).then(snapshot=>{if(snapshot)sendLine(socket,{type:"snapshot",ptyId:pane.req.ptyId,snapshot});});
    }
    if(initialBuffer)onData(initialBuffer);
}

function start(): void {
  fs.mkdirSync(path.dirname(PTY_HOST_SOCKET_PATH), { recursive: true });
  try {
    fs.rmSync(PTY_HOST_SOCKET_PATH, { force: true });
  } catch {
    // best effort
  }

  server = net.createServer((socket) => {
    void socketAuthenticator.accept(socket).then(result=>{
      if("transferred" in result)return;
      const {buffered}=result;
      if(hostShutdownStarted||socket.destroyed){socket.destroy();return;}
      attachAuthenticatedClient(socket,buffered);socket.resume();
    }).catch(()=>{ptyLog.append("host-auth-refused",{});});
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
        authProtocol:1,
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

requireOwnerExitAcknowledgements();
keepHostOnUncaught(ptyLog);
setOwnerUnavailableListener(owner => {
  for (const id of owner.record.panes.map(p => p.id)) broadcast({ type: "disconnected", ptyId: id });
});
void (async()=>{
  const capability=await readInheritedHostAuthKey();
  const ownStart=ownerProcessStartIdentity(process.pid);
  if(!ownStart)throw new Error("Terminal host process identity is unavailable");
  const principal=new HostAuthPrincipal(peer=>{
    try{
      const start=ownerProcessStartIdentity(peer.pid);
      if(start)return start===peer.startIdentity?"same":"gone";
      try{process.kill(peer.pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==="ESRCH")return "gone";}
    }catch{/* Failed identity probes cannot release a live main. */}
    return "unknown";
  });
  socketAuthenticator=new HostSocketAuthenticator(capability,{pid:process.pid,startIdentity:ownStart},peer=>principal.authorize(peer));
  capability.fill(0);
  const recovery=process.env.AYA_PTY_RECOVERY_FD === "4" ? await readRecoveryBootstrap(4) : null;
  delete process.env.AYA_PTY_RECOVERY_FD;
  if(recovery)requireRecoveryOwner(recovery.owner);
  const bootstrap=!recovery&&process.env.AYA_PTY_CHECKPOINT_FD === "4" ? await readHandoverBootstrap(4) : null;
  delete process.env.AYA_PTY_CHECKPOINT_FD;
  if(bootstrap)await preflightCoreHandover(bootstrap.core);
  const bootstrapOwner=await getOwnerRuntime();
  const releaseBootstrap=bootstrap||recovery?bootstrapOwner.holdRestoration():()=>{};
  if(recovery){
    const observed=new Set<string>();
    for(const receipt of recovery.observed??[]){
      const pane=bootstrapOwner.disconnected.get(receipt.id);
      if(pane?.exited&&pane.generation===receipt.generation&&pane.event===receipt.event){if(await acknowledgePtyExit(pane.id,pane.generation,pane.event)!=="retired")throw Error("Observed recovery exit could not be retired");observed.add(pane.id);}
    }
    // Identity preflight for the whole requested set before the first master.
    for(const pane of recovery.panes){
      if(observed.has(pane.id))continue;
      const actual=bootstrapOwner.disconnected.get(pane.id);
      if(!actual||actual.pid!==pane.pid||actual.generation!==pane.generation||actual.startIdentity!==pane.startIdentity)throw Error("Recovery inventory changed before attach");
    }
    for(const pane of recovery.panes){if(observed.has(pane.id))continue;await recoverPtyCorePane(pane,sink);installSnapshotFanout(pane.id);}
    crashBoot=true;
  }
  if(bootstrap){
    for await(const pane of readCoreHandover(bootstrap.core)){
      await restorePtyCorePane(pane,sink);installSnapshotFanout(pane.id);
    }
    await acknowledgeCheckpoint(PTY_HANDOVER_CORE_DIRECTORY,bootstrap.core);
  }
  releaseBootstrap();
  start();
})().catch(error => {
  ptyLog.append("owner-start-failed", { error: String(error) });
  // A partial restore/failed ACK can already own live reader/control handles.
  // Exit JS promptly to release that lease; never shut down the stable owner.
  process.exit(1);
});
