// IPty contract over an SCM_RIGHTS master. No rule/session/VT dependencies.
import fs from "node:fs";
import os from "node:os";
import tty from "node:tty";
import { StringDecoder } from "node:string_decoder";
import type { IPty, IDisposable } from "node-pty";
import type { OwnerPane, OwnerSpawn } from "./pty-owner-client";
import { setOwnerMasterNonblocking, ownerMasterWriteReady, resizeOwnerMaster } from "./pty-owner-client";
import { getOwnerRuntime, type OwnerRuntime } from "./pty-owner-runtime";
const retiring = new Map<string, Promise<void>>();
export class OwnerPty implements IPty {
  readonly pid: number;
  cols: number;
  rows: number;
  readonly process: string;
  handleFlowControl = false;
  private reader: tty.ReadStream;
  private decoder = new StringDecoder("utf8");
  private dataListeners = new Set<(data: string) => void>();
  private exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();
  private operation: Promise<unknown> = Promise.resolve();
  private exited: OwnerPane | null = null;
  private readEnded = false;
  private finalized = false;
  private drainTimer: NodeJS.Timeout | undefined;
  private settleClosed!: () => void;
  readonly closed = new Promise<void>(resolve => { this.settleClosed = resolve; });
  private constructor(private owner: OwnerRuntime, private pane: OwnerPane & { fd: number }, command: string) {
    this.pid = pane.pid; this.cols = pane.cols; this.rows = pane.rows; this.process = command;
    this.reader = new tty.ReadStream(owner.client!.takeMaster(pane.fd));
    setOwnerMasterNonblocking(pane.fd);
    this.reader.pause();
    this.reader.on("data", (data: Buffer) => this.emitData(this.decoder.write(data)));
    this.reader.pause(); // onData starts reads only after core installs its sink
    this.reader.on("end", () => this.endRead());
    this.reader.on("error", () => this.endRead());
    this.reader.on("close", () => this.endRead());
    owner.track(pane, exit => {
      this.exited = exit;
      if (!this.readEnded) {
        this.reader.resume();
        // Match node-pty's 200ms post-exit drain ceiling: a descendant that
        // kept a slave open must not leave the pane's exit pending forever.
        this.drainTimer = setTimeout(() => { this.reader.destroy(); this.endRead(); }, 200);
      }
      void this.finish();
    });
  }
  static async spawn(spec: OwnerSpawn): Promise<OwnerPty> {
    const owner = await getOwnerRuntime();
    await retiring.get(`${owner.record.instanceId}:${spec.id}`);
    if (owner.incompatible || !owner.client) throw new Error("The PTY owner is disconnected or incompatible. Restart its terminals after confirming the work that will stop.");
    if (owner.disconnected.has(spec.id)) throw new Error("This terminal still runs in the native owner but its JS host is disconnected. Restart it explicitly; it was not respawned.");
    const intent = owner.beginSpawn(spec.id)!;
    try {
      const pane = await owner.client.spawn(spec);
      const adapter = new OwnerPty(owner, pane, spec.command);
      owner.resolveSpawn(spec.id, intent);
      return adapter;
    }
    catch (error) {
      if ((error as { code?: string }).code !== "OWNER_REJECTED") owner.uncertainSpawn(spec.id);
      else owner.resolveSpawn(spec.id, intent);
      throw error;
    }
    finally { owner.endSpawn(); }
  }
  private emitData(data: string): void { if (data) for (const listener of this.dataListeners) listener(data); }
  readonly onData = (listener: (data: string) => void): IDisposable => {
    this.dataListeners.add(listener); this.reader.resume();
    return { dispose: () => this.dataListeners.delete(listener) };
  };
  readonly onExit = (listener: (event: { exitCode: number; signal?: number }) => void): IDisposable => {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  };
  private endRead(): void {
    if (this.readEnded) return;
    this.readEnded = true; this.emitData(this.decoder.end()); void this.finish();
  }
  private async finish(): Promise<void> {
    // Exit metadata may arrive before PTY EOF. Drain output first; otherwise
    // a fast command's last chunk could arrive after its pane's exit event.
    if (!this.exited || !this.readEnded || this.finalized) return;
    this.finalized = true;
    clearTimeout(this.drainTimer);
    this.reader.destroy();
    try { await this.owner.retired(this.exited); }
    catch { /* Owner keeps an unacknowledged exit for explicit reconciliation. */ }
    finally {
      for (const listener of this.exitListeners) listener({ exitCode: this.exited.exitCode ?? 0, signal: this.exited.signal });
      this.settleClosed();
    }
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation); this.operation = result.catch(() => {}); return result;
  }
  writeAsync(data: string | Buffer): Promise<void> {
    if (this.handleFlowControl && data === "\x13") { this.pause(); return Promise.resolve(); }
    if (this.handleFlowControl && data === "\x11") { this.resume(); return Promise.resolve(); }
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    return this.enqueue(async () => {
      let offset = 0;
      while (offset < bytes.length) {
        if (this.exited || this.readEnded || !this.owner.client?.isConnected()) throw new Error("Terminal input could not finish. Check the pane before retrying; some bytes may have reached it.");
        try { offset += fs.writeSync(this.pane.fd, bytes, offset, bytes.length - offset); }
        catch (error) {
          if (!["EAGAIN", "EWOULDBLOCK", "EINTR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          // The master is nonblocking; waiting for writability yields to all
          // other panes rather than blocking the JS host on a large paste.
          do {
            await new Promise(resolve => setTimeout(resolve, 5));
            if (this.exited || this.readEnded || !this.owner.client?.isConnected()) break;
          } while (!ownerMasterWriteReady(this.pane.fd));
        }
      }
    });
  }
  write(data: string | Buffer): void { void this.writeAsync(data).catch(() => {}); }
  resize(cols: number, rows: number): void {
    if (this.exited || this.readEnded) return;
    resizeOwnerMaster(this.pane.fd, cols, rows);
    this.cols = cols; this.rows = rows;
    // Geometry must reach TIOCSWINSZ even while input is backpressured.
    if (!this.exited) void this.owner.client!.resize(this.pane, cols, rows).catch(() => {});
  }
  kill(signal = "SIGHUP"): void {
    const key = `${this.owner.record.instanceId}:${this.pane.id}`;
    retiring.set(key, this.closed);
    void this.closed.then(() => { if (retiring.get(key) === this.closed) retiring.delete(key); });
    // Cancellation must interrupt blocked input instead of queueing behind it.
    // The owner serializes kill against the known pane generation and reaps it.
    if (!this.exited) void this.owner.client!.kill(this.pane, os.constants.signals[signal as keyof typeof os.constants.signals]).catch(() => {});
    this.reader.resume();
  }
  clear(): void {}
  pause(): void { this.reader.pause(); }
  resume(): void { this.reader.resume(); }
}
