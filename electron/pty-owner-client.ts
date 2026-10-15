// B1: explicit opt-in API for tests/package smoke. No Aya startup/spawn path calls it.
import path from "node:path";

export const OWNER_PROTOCOL = 1;
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
    return { id, generation, pid, cols, rows, exited: !!exited, exitCode: exitCode === 0xffffffff ? null : exitCode, signal, event, acknowledged: !!acknowledged };
  }
  done(): void { if (this.offset !== this.data.length) throw new Error("Trailing owner response data"); }
}
export class PtyOwnerClient {
  private serial = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private masters = new Set<number>();
  private exits: OwnerPane[] = [];
  private seenExits = new Set<string>();
  private constructor(private readonly native: Bridge, private readonly fd: number) {}
  static async connect(socketPath: string, token: Buffer, bridgePath = ownerArtifactPaths().bridge): Promise<PtyOwnerClient> {
    if (token.length !== 32) throw new Error("Owner token must contain 32 bytes");
    // Loaded only on explicit connect; importing this file cannot launch or contact an owner.
    const native = require(bridgePath) as Bridge;
    const client = new PtyOwnerClient(native, native.connect(socketPath));
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
    catch (error) {
      if ((error as { code?: string }).code !== "ETIMEDOUT") this.close();
      throw error;
    }
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
    if (!this.seenExits.has(key)) { this.seenExits.add(key); this.exits.push(pane); }
    return true;
  }
  private request(type: number, payload: Buffer = Buffer.alloc(0)): Promise<{ data: Buffer; fd: number }> {
    return this.exclusive(async () => {
      if (payload.length > OWNER_MAX_FRAME || this.serial === 0xffffffff) throw new Error("Owner request limit exceeded");
      const id = ++this.serial, frame = Buffer.alloc(HEADER + payload.length);
      frame.writeUInt32BE(MAGIC); frame.writeUInt16BE(OWNER_PROTOCOL, 4); frame.writeUInt16BE(type, 6);
      frame.writeUInt32BE(id, 8); frame.writeUInt32BE(payload.length, 12); payload.copy(frame, HEADER);
      try { this.native.send(this.fd, frame); } catch (error) { this.close(); throw error; }
      for (;;) {
        const reply = await this.receive();
        if (this.acceptExit(reply)) continue;
        if (reply.id !== id || (reply.type !== OK && reply.type !== ERROR)) {
          if (reply.fd >= 0) this.native.close(reply.fd);
          this.close(); throw new Error("Unexpected owner reply");
        }
        if (reply.type === ERROR) {
          if (reply.fd >= 0) this.native.close(reply.fd);
          const d = new Decoder(reply.data), message = d.string(); d.done(); throw new Error(message);
        }
        if (reply.fd >= 0) {
          if (type !== ownerMessages.spawn && type !== ownerMessages.attach) {
            this.native.close(reply.fd); this.close(); throw new Error("Unexpected owner descriptor");
          }
          this.masters.add(reply.fd);
        }
        return reply;
      }
    });
  }
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
    if (count > 25) throw new Error("Invalid pane count");
    const panes = Array.from({ length: count }, () => d.pane()); d.done(); return panes;
  }
  async resize(pane: OwnerPane, cols: number, rows: number): Promise<void> { await this.request(ownerMessages.resize, this.panePayload(pane).u32(cols).u32(rows).bytes()); }
  async kill(pane: OwnerPane, signal: number): Promise<void> { await this.request(ownerMessages.kill, this.panePayload(pane).u32(signal).bytes()); }
  async ackExit(pane: OwnerPane): Promise<void> { await this.request(ownerMessages.ackExit, this.panePayload(pane).u32(pane.event).bytes()); }
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
    return this.exclusive(async () => {
      while (!this.exits.length) {
        const reply = await this.receive(timeoutMs);
        if (!this.acceptExit(reply)) { if (reply.fd >= 0) this.native.close(reply.fd); this.close(); throw new Error("Expected exit event"); }
      }
      return this.exits.shift()!;
    });
  }
  readReady(fd: number): number { if (!this.masters.has(fd)) throw new Error("Unknown master"); return this.native.readReady(fd); }
  release(fd: number): void { if (this.masters.delete(fd)) this.native.close(fd); }
  /** Transfer FD ownership to a stream/adapter, which must close it exactly once. */
  takeMaster(fd: number): number { if (!this.masters.delete(fd)) throw new Error("Unknown master"); return fd; }
  close(): void {
    if (this.closed) return; this.closed = true;
    for (const fd of this.masters) this.native.close(fd);
    this.masters.clear(); this.native.close(this.fd, true);
  }
}
