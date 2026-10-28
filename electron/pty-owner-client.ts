// Typed transport for the stable native PTY owner.
import path from "node:path";
import { execFileSync } from "node:child_process";
import { MAX_PTY_PANES } from "./pty-pane-limits";

export const OWNER_PROTOCOL = 2;
export const OWNER_MAX_FRAME = 256 * 1024;
const MAGIC = 0x41594150;
const HEADER = 16;
export const ownerMessages = { hello: 1, spawn: 2, attach: 3, resize: 4, kill: 5, list: 6, ackExit: 7, shutdown: 8, stats: 9 } as const;
const OK = 0x8000, ERROR = 0x8001, EXIT = 0x8002;
interface Bridge {
  connect(socketPath: string): number;
  send(fd: number, frame: Buffer): void;
  receive(fd: number, timeoutMs: number): Promise<{ data: Buffer; fd: number }>;
  close(fd: number, control?: boolean): void;
  readReady(fd: number): number;
}
export function ownerArtifactPaths(directory = __dirname): { executable: string; bridge: string } {
  const unpacked = directory.replace(/([/\\])app\.asar([/\\])/, "$1app.asar.unpacked$2");
  return { executable: path.join(unpacked, "aya-pty-owner"), bridge: path.join(unpacked, "pty-owner-bridge.node") };
}
interface RecoveryBridge {
  resizeMaster(fd: number, cols: number, rows: number): void;
  recoverySupported(): boolean;
  nonblockingMaster(fd: number): void;
  writeReady(fd: number): boolean;
  recoveryGroupExists(pid: number): boolean;
  recoveryIdentity(pid: number): string | null;
  recoverProcess(pid: number, startIdentity: string, group: number): "absent" | "mismatch" | "unknown" | "signalled";
  terminateProcess(pid: number, startIdentity: string, group: number): "absent" | "mismatch" | "unknown" | "signalled";
}
export interface RecoveryMember { pid: number; startIdentity: string | null }
const recoveryBridge = (): RecoveryBridge => require(ownerArtifactPaths().bridge) as RecoveryBridge;
export function setOwnerMasterNonblocking(fd: number): void { recoveryBridge().nonblockingMaster(fd); }
export function ownerMasterWriteReady(fd: number): boolean { return recoveryBridge().writeReady(fd); }
export function resizeOwnerMaster(fd: number, cols: number, rows: number): void { recoveryBridge().resizeMaster(fd, cols, rows); }
export function ownerRecoverySupported(): boolean { return recoveryBridge().recoverySupported(); }
export function ownerProcessStartIdentity(pid: number): string | null { return recoveryBridge().recoveryIdentity(pid); }
export function ownerProcessGroupExists(pid: number): boolean {
  return recoveryBridge().recoveryGroupExists(pid);
}
// Synchronous on purpose: snapshotOwnerRecoveryMembers brackets this listing between two leader identity checks in
// one turn, so the inventory it signals cannot belong to a reused group. Recovery and retirement paths only.
export function ownerGroupMemberPids(group: number): number[] {
  const listing = execFileSync("/bin/ps", ["-axo", "pid=,pgid="], { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  return listing.split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    return match && Number(match[2]) === group && Number(match[1]) > 1 ? [Number(match[1])] : [];
  });
}
export function snapshotOwnerRecoveryMembers(pid: number, startIdentity: string): RecoveryMember[] {
  const bridge = recoveryBridge();
  if (bridge.recoveryIdentity(pid) !== startIdentity) throw new Error("The recorded group leader's process identity no longer matches");
  const pids = ownerGroupMemberPids(pid);
  if (!pids.includes(pid) || pids.length > 32) throw new Error("Cannot establish a bounded recovery inventory through the recorded group leader");
  const members = pids.map(member => {
    let identity: string | null = null;
    try { identity = bridge.recoveryIdentity(member); } catch { /* an unverifiable member stays in the inventory */ }
    return { pid: member, startIdentity: identity };
  });
  if (bridge.recoveryIdentity(pid) !== startIdentity) throw new Error("The recorded group leader exited during recovery inventory");
  return members;
}
export function recoverOwnerProcess(member: RecoveryMember, group: number): ReturnType<RecoveryBridge["recoverProcess"]> {
  return member.startIdentity ? recoveryBridge().recoverProcess(member.pid, member.startIdentity, group) : "unknown";
}
/** Only after consent bound to this process instance. Never signals a group. */
export function terminateVerifiedProcess(member: RecoveryMember, group: number): ReturnType<RecoveryBridge["terminateProcess"]> {
  return member.startIdentity ? recoveryBridge().terminateProcess(member.pid, member.startIdentity, group) : "unknown";
}
// Disposable test cleanup also uses individual, instance-checked signals.
export function recoverOwnerProcessGroup(pid: number, startIdentity: string): "absent" | "signalled" | "mismatch" {
  if (!ownerProcessGroupExists(pid)) return "absent";
  const members = snapshotOwnerRecoveryMembers(pid, startIdentity);
  return members.every(member => ["absent", "signalled"].includes(recoverOwnerProcess(member, pid))) ? "signalled" : "mismatch";
}
export interface OwnerPane {
  id: string;
  generation: number;
  pid: number;
  cols: number;
  rows: number;
  exited: boolean;
  exitCode: number | null;
  signal: number;
  event: number;
  acknowledged: boolean;
  startIdentity: string | null;
  /** Private recovery ledger only; not part of the owner's wire record. */
  recoveryMembers?: RecoveryMember[];
}
export interface OwnerSpawn {
  id: string;
  cols: number;
  rows: number;
  cwd: string;
  command: string;
  argv: string[];
  env: Record<string, string>;
}
class Encoder {
  private chunks: Buffer[] = [];
  private size = 0;
  u32(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error("Invalid owner integer");
    if (this.size + 4 > OWNER_MAX_FRAME) throw new Error("Owner request limit exceeded");
    this.size += 4;
    const b = Buffer.alloc(4); b.writeUInt32BE(value); this.chunks.push(b); return this;
  }
  string(value: string): this {
    if (value.includes("\0")) throw new Error("NUL in owner string");
    const length = Buffer.byteLength(value);
    if (length > 65536 || this.size + 4 + length > OWNER_MAX_FRAME) throw new Error("Owner request limit exceeded");
    const bytes = Buffer.from(value); this.u32(bytes.length); this.size += length; this.chunks.push(bytes); return this;
  }
  strings(values: string[]): this { this.u32(values.length); for (const value of values) this.string(value); return this; }
  bytes(): Buffer { return Buffer.concat(this.chunks); }
}
class Decoder {
  private offset = 0;
  constructor(private readonly data: Buffer) {}
  u32(): number {
    if (this.offset + 4 > this.data.length) throw new Error("Truncated owner response");
    const value = this.data.readUInt32BE(this.offset); this.offset += 4; return value;
  }
  string(): string {
    const size = this.u32();
    if (this.offset + size > this.data.length) throw new Error("Truncated owner string");
    const value = this.data.toString("utf8", this.offset, this.offset + size); this.offset += size; return value;
  }
  pane(): OwnerPane {
    const id = this.string(), generation = this.u32(), pid = this.u32(), cols = this.u32(), rows = this.u32();
    const exited = this.u32(), exitCode = this.u32(), signal = this.u32(), event = this.u32(), acknowledged = this.u32();
    const startIdentity = this.string() || null;
    if (startIdentity !== null && !/^\d+:\d+$/.test(startIdentity)) throw new Error("Invalid owner process identity");
    return { id, generation, pid, cols, rows, exited: !!exited, exitCode: exitCode === 0xffffffff ? null : exitCode, signal, event, acknowledged: !!acknowledged, startIdentity };
  }
  done(): void { if (this.offset !== this.data.length) throw new Error("Trailing owner response data"); }
}
export class PtyOwnerClient {
  private serial = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private pending = new Map<number, { type: number; resolve(reply: { data: Buffer; fd: number }): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private exitListeners = new Set<(pane: OwnerPane) => void>();
  private closeListeners = new Set<() => void>();
  private exitWaiters = new Set<{ resolve(pane: OwnerPane): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private masters = new Set<number>();
  private exits: OwnerPane[] = [];
  private seenExits = new Set<string>();
  private constructor(private readonly native: Bridge, private readonly fd: number) {}
  static async connect(socketPath: string, token: Buffer, bridgePath = ownerArtifactPaths().bridge): Promise<PtyOwnerClient> {
    if (token.length !== 32) throw new Error("Owner token must contain 32 bytes");
    // Loaded only on explicit connect; importing this file cannot launch or contact an owner.
    const native = require(bridgePath) as Bridge;
    const client = new PtyOwnerClient(native, native.connect(socketPath));
    void client.pump();
    try {
      const reply = await client.request(ownerMessages.hello, token);
      const decoder = new Decoder(reply.data); client.buildId = decoder.string(); client.ownerPid = decoder.u32(); client.instanceId = decoder.string(); decoder.done();
      return client;
    } catch (error) { client.close(); throw error; }
  }
  buildId = "";
  ownerPid = 0;
  instanceId = "";
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => { if (this.closed) throw new Error("Owner connection closed"); return operation(); });
    this.queue = result.catch(() => {}); return result;
  }
  private async receive(timeoutMs = 5000): Promise<{ type: number; id: number; data: Buffer; fd: number }> {
    let received: { data: Buffer; fd: number };
    try { received = await this.native.receive(this.fd, timeoutMs); }
    catch (error) { throw error; }
    const b = received.data;
    if (b.length < HEADER || b.readUInt32BE(0) !== MAGIC || b.readUInt16BE(4) !== OWNER_PROTOCOL || b.readUInt32BE(12) !== b.length - HEADER) {
      if (received.fd >= 0) this.native.close(received.fd);
      this.close(); throw new Error("Invalid owner response header");
    }
    return { type: b.readUInt16BE(6), id: b.readUInt32BE(8), data: b.subarray(HEADER), fd: received.fd };
  }
  private acceptExit(reply: { type: number; data: Buffer; fd: number }): boolean {
    if (reply.type !== EXIT) return false;
    if (reply.fd >= 0) { this.native.close(reply.fd); throw new Error("Exit event carried a descriptor"); }
    const decoder = new Decoder(reply.data), pane = decoder.pane(); decoder.done();
    const key = `${pane.id}:${pane.generation}:${pane.event}`;
    if (!this.seenExits.has(key)) {
      this.seenExits.add(key);
      const waiter = this.exitWaiters.values().next().value;
      if (waiter) { this.exitWaiters.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(pane); }
      else this.exits.push(pane);
      for (const listener of this.exitListeners) listener(pane);
    }
    return true;
  }
  private async pump(): Promise<void> {
    while (!this.closed) {
      try {
        const reply = await this.receive(250);
        if (this.closed) { if (reply.fd >= 0) this.native.close(reply.fd); return; }
        if (this.acceptExit(reply)) continue;
        const pending = this.pending.get(reply.id);
        if (!pending || (reply.type !== OK && reply.type !== ERROR)) {
          if (reply.fd >= 0) this.native.close(reply.fd);
          throw new Error("Unexpected owner reply");
        }
        if (reply.type === ERROR) {
          if (reply.fd >= 0) this.native.close(reply.fd);
          const d = new Decoder(reply.data), message = d.string(); d.done();
          this.pending.delete(reply.id); clearTimeout(pending.timer);
          pending.reject(Object.assign(new Error(message), { code: "OWNER_REJECTED" })); continue;
        }
        if (reply.fd >= 0) {
          if (pending.type !== ownerMessages.spawn && pending.type !== ownerMessages.attach) {
            this.native.close(reply.fd); throw new Error("Unexpected owner descriptor");
          }
          this.masters.add(reply.fd);
        }
        this.pending.delete(reply.id); clearTimeout(pending.timer); pending.resolve(reply);
      } catch (error) {
        // An idle read timeout consumed no frame. Partial frames are fatal:
        // the native bridge reports those as protocol errors below.
        if ((error as { code?: string }).code === "ETIMEDOUT" && !this.closed) continue;
        this.close();
      }
    }
  }
  private request(type: number, payload: Buffer = Buffer.alloc(0)): Promise<{ data: Buffer; fd: number }> {
    return this.exclusive(() => {
      if (payload.length > OWNER_MAX_FRAME || this.serial === 0xffffffff) throw new Error("Owner request limit exceeded");
      const id = ++this.serial, frame = Buffer.alloc(HEADER + payload.length);
      frame.writeUInt32BE(MAGIC); frame.writeUInt16BE(OWNER_PROTOCOL, 4); frame.writeUInt16BE(type, 6);
      frame.writeUInt32BE(id, 8); frame.writeUInt32BE(payload.length, 12); payload.copy(frame, HEADER);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => this.close(), 5000);
        this.pending.set(id, { type, resolve, reject, timer });
        try { this.native.send(this.fd, frame); } catch { this.close(); }
      });
    });
  }
  onExit(listener: (pane: OwnerPane) => void): () => void { this.exitListeners.add(listener); return () => this.exitListeners.delete(listener); }
  onClose(listener: () => void): () => void { this.closeListeners.add(listener); return () => this.closeListeners.delete(listener); }
  private panePayload(pane: Pick<OwnerPane, "id" | "generation">): Encoder { return new Encoder().string(pane.id).u32(pane.generation); }
  async spawn(spawn: OwnerSpawn): Promise<OwnerPane & { fd: number }> {
    const p = new Encoder().string(spawn.id).u32(spawn.cols).u32(spawn.rows).string(spawn.cwd).string(spawn.command)
      .strings(spawn.argv).strings(Object.entries(spawn.env).map(([key, value]) => `${key}=${value}`));
    const reply = await this.request(ownerMessages.spawn, p.bytes());
    const d = new Decoder(reply.data), pane = d.pane(); d.done();
    if (reply.fd < 0) throw new Error("Spawn did not provide a master");
    return { ...pane, fd: reply.fd };
  }
  async attach(pane: Pick<OwnerPane, "id" | "generation">): Promise<OwnerPane & { fd: number }> {
    const reply = await this.request(ownerMessages.attach, this.panePayload(pane).bytes());
    const d = new Decoder(reply.data), record = d.pane(); d.done();
    if (reply.fd < 0) throw new Error("Attach did not provide a master");
    return { ...record, fd: reply.fd };
  }
  async list(): Promise<OwnerPane[]> {
    const reply = await this.request(ownerMessages.list), d = new Decoder(reply.data), count = d.u32();
    if (count > MAX_PTY_PANES) throw new Error("Invalid pane count");
    const panes = Array.from({ length: count }, () => d.pane()); d.done(); return panes;
  }
  async resize(pane: OwnerPane, cols: number, rows: number): Promise<void> { await this.request(ownerMessages.resize, this.panePayload(pane).u32(cols).u32(rows).bytes()); }
  async kill(pane: OwnerPane, signal: number): Promise<void> { await this.request(ownerMessages.kill, this.panePayload(pane).u32(signal).bytes()); }
  async ackExit(pane: OwnerPane): Promise<void> {
    await this.request(ownerMessages.ackExit, this.panePayload(pane).u32(pane.event).bytes());
    this.seenExits.delete(`${pane.id}:${pane.generation}:${pane.event}`);
  }
  async shutdown(): Promise<void> {
    for (const fd of [...this.masters]) this.release(fd);
    await this.request(ownerMessages.shutdown); this.close();
  }
  async stats(): Promise<{ userUs: bigint; systemUs: bigint }> {
    const reply = await this.request(ownerMessages.stats), d = new Decoder(reply.data);
    const userUs = (BigInt(d.u32()) << 32n) + BigInt(d.u32()), systemUs = (BigInt(d.u32()) << 32n) + BigInt(d.u32()); d.done();
    return { userUs, systemUs };
  }
  takeExits(): OwnerPane[] { return this.exits.splice(0); }
  nextExit(timeoutMs = 5000): Promise<OwnerPane> {
    const pane = this.exits.shift();
    if (pane) return Promise.resolve(pane);
    if (this.closed) return Promise.reject(new Error("Owner connection closed"));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: setTimeout(() => {
        this.exitWaiters.delete(waiter); reject(Object.assign(new Error("Owner exit timed out"), { code: "ETIMEDOUT" }));
      }, timeoutMs) };
      this.exitWaiters.add(waiter);
    });
  }
  isConnected(): boolean { return !this.closed; }
  readReady(fd: number): number { if (!this.masters.has(fd)) throw new Error("Unknown master"); return this.native.readReady(fd); }
  release(fd: number): void { if (this.masters.delete(fd)) this.native.close(fd); }
  /** Transfer FD ownership to a stream/adapter, which must close it exactly once. */
  takeMaster(fd: number): number { if (!this.masters.delete(fd)) throw new Error("Unknown master"); return fd; }
  close(): void {
    if (this.closed) return; this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("Owner connection closed")); }
    this.pending.clear();
    for (const waiter of this.exitWaiters) { clearTimeout(waiter.timer); waiter.reject(new Error("Owner connection closed")); }
    this.exitWaiters.clear();
    for (const listener of this.closeListeners) listener();
    for (const fd of this.masters) this.native.close(fd);
    this.masters.clear(); this.native.close(this.fd, true);
  }
}
