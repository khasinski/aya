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
export interface OwnerPtyCheckpoint {
  pane: OwnerPane;
  process: string;
  /** Bytes already delivered through the old adapter, including decoder carry. */
  readBytes: number;
  decoderCarry: string;
}
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
  private writeOutcomes = new Set<Promise<void>>();
  private mutationsGated = false;
  private handoverPaused = false;
  private handoverEpoch = 0;
  private handoverDetached = false;
  private deferredEnd = false;
  private consumerReady = false;
  private readBytes = 0;
  private savedRead: ((size: number) => void) | null = null;
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
    this.reader.on("data", (data: Buffer) => { this.readBytes += data.length; this.emitData(this.decoder.write(data)); });
    this.reader.pause(); // onData starts reads only after core installs its sink
    this.reader.on("end", () => this.endRead());
    this.reader.on("error", () => this.endRead());
    this.reader.on("close", () => this.endRead());
    owner.track(pane, exit => {
      this.exited = exit;
      if (!this.readEnded && this.consumerReady && !this.handoverPaused) this.drainExit();
      void this.finish();
    });
  }
  static async attach(checkpoint: OwnerPtyCheckpoint): Promise<OwnerPty> {
    const owner = await getOwnerRuntime();
    if (owner.incompatible || !owner.client) throw new Error("The checkpoint's PTY owner is unavailable");
    const pane = await owner.client.attach(checkpoint.pane);
    try {
      if (pane.pid !== checkpoint.pane.pid || pane.startIdentity !== checkpoint.pane.startIdentity) throw new Error("The checkpoint's pane process identity changed");
      const adapter = new OwnerPty(owner, pane, checkpoint.process);
      const carry = Buffer.from(checkpoint.decoderCarry, "base64");
      if (carry.length > 3 || carry.toString("base64") !== checkpoint.decoderCarry || adapter.decoder.write(carry) !== "") {
        adapter.handoverDetached = true; adapter.reader.destroy(); throw new Error("Invalid PTY decoder checkpoint");
      }
      adapter.readBytes = checkpoint.readBytes;
      owner.disconnected.delete(pane.id);
      return adapter;
    } catch (error) { owner.client.release(pane.fd); throw error; }
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
    this.dataListeners.add(listener); this.consumerReady = true;
    if (!this.handoverPaused) { this.reader.resume(); if (this.exited && !this.readEnded) this.drainExit(); }
    return { dispose: () => this.dataListeners.delete(listener) };
  };
  readonly onExit = (listener: (event: { exitCode: number; signal?: number }) => void): IDisposable => {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  };
  private endRead(): void {
    if (this.handoverDetached) return;
    if (this.handoverPaused) { this.deferredEnd = true; return; }
    if (this.readEnded) return;
    this.readEnded = true; this.emitData(this.decoder.end()); void this.finish();
  }
  private async finish(): Promise<void> {
    // Exit metadata may arrive before PTY EOF. Drain output first; otherwise
    // a fast command's last chunk could arrive after its pane's exit event.
    if (!this.exited || !this.readEnded || this.finalized || this.handoverPaused || this.handoverDetached) return;
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
  private drainExit(): void {
    this.reader.resume();
    // Match node-pty's post-exit drain ceiling; never begin this until the
    // core installed its data listener, including an exited-during-gap attach.
    if (!this.drainTimer) this.drainTimer = setTimeout(() => { this.reader.destroy(); this.endRead(); }, 200);
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation); this.operation = result.catch(() => {}); return result;
  }
  writeAsync(data: string | Buffer): Promise<void> {
    if (this.mutationsGated) return Promise.reject(new Error("Terminal handover is in progress. This input was not delivered."));
    if (this.handleFlowControl && data === "\x13") { this.pause(); return Promise.resolve(); }
    if (this.handleFlowControl && data === "\x11") { this.resume(); return Promise.resolve(); }
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const outcome = this.enqueue(async () => {
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
    this.writeOutcomes.add(outcome);
    void outcome.then(() => this.writeOutcomes.delete(outcome), () => this.writeOutcomes.delete(outcome));
    return outcome;
  }
  write(data: string | Buffer): void { void this.writeAsync(data).catch(() => {}); }
  resize(cols: number, rows: number): void {
    if (this.mutationsGated) throw new Error("Terminal handover is in progress. Resize was not applied.");
    if (this.exited || this.readEnded) return;
    resizeOwnerMaster(this.pane.fd, cols, rows);
    this.cols = cols; this.rows = rows;
    // Geometry must reach TIOCSWINSZ even while input is backpressured.
    if (!this.exited) void this.owner.client!.resize(this.pane, cols, rows).catch(() => {});
  }
  kill(signal = "SIGHUP"): void {
    if (this.mutationsGated) throw new Error("Terminal handover is in progress. This process was kept.");
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
  resume(): void { if (!this.handoverPaused) this.reader.resume(); }

  /** The core gates all producers first. Every outstanding input operation
   * must settle successfully or cutover aborts; no input is serialized/retried. */
  async freezeForHandover(timeoutMs = 1000): Promise<OwnerPtyCheckpoint> {
    if (this.mutationsGated || this.handoverDetached || this.exited || this.readEnded) throw new Error("This pane cannot freeze for handover now");
    this.mutationsGated = true;
    const epoch=++this.handoverEpoch;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([Promise.all([...this.writeOutcomes]), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Terminal input did not drain before handover; its process was kept.")), timeoutMs);
      })]);
      if (epoch!==this.handoverEpoch || !this.mutationsGated || this.exited || this.readEnded || !this.owner.client?.isConnected()) throw new Error("The pane changed during handover input drain");
      const stream = this.reader as tty.ReadStream & {_handle?: {reading: boolean; readStop(): number}; _read(size: number): void};
      if (!stream._handle || typeof stream._handle.readStop !== "function") throw new Error("This runtime cannot freeze PTY reads");
      this.handoverPaused = true;
      stream.pause();
      const status = stream._handle.readStop();
      if (status) throw new Error("PTY read-stop refused");
      stream._handle.reading = false;
      this.savedRead = stream._read;
      // read() may otherwise invoke _read and restart libuv. Drain only the
      // bytes already in Node's buffer, through the existing data listener.
      stream._read = () => {};
      clearTimeout(this.drainTimer); this.drainTimer = undefined;
      while (stream.read() !== null) { /* read emits the existing data event once */ }
      const decoder = this.decoder as StringDecoder & {lastNeed: number; lastTotal: number; lastChar: Buffer};
      if (!Number.isInteger(decoder.lastNeed) || decoder.lastNeed < 0 || decoder.lastNeed > 3 || !Number.isInteger(decoder.lastTotal) || decoder.lastTotal < decoder.lastNeed || decoder.lastTotal > 4 || !Buffer.isBuffer(decoder.lastChar)) throw new Error("This runtime cannot checkpoint its PTY decoder");
      const carry = decoder.lastNeed ? decoder.lastChar.subarray(0, decoder.lastTotal - decoder.lastNeed) : Buffer.alloc(0);
      const {fd: _fd, ...pane} = this.pane;
      return {pane: {...pane, cols: this.cols, rows: this.rows}, process: this.process, readBytes: this.readBytes, decoderCarry: carry.toString("base64")};
    } catch (error) { if(epoch===this.handoverEpoch)this.resumeAfterHandoverAbort(); throw error; }
    finally { clearTimeout(timer); }
  }
  resumeAfterHandoverAbort(): void {
    if (this.handoverDetached) return;
    this.handoverEpoch++;
    this.mutationsGated = false;
    if (!this.handoverPaused) return;
    this.handoverPaused = false;
    if (this.savedRead) { this.reader._read = this.savedRead; this.savedRead = null; this.reader._read(0); }
    if (this.consumerReady) this.reader.resume();
    if (this.deferredEnd) { this.deferredEnd = false; this.endRead(); }
    else if (this.exited && this.consumerReady && !this.readEnded) this.drainExit();
  }
  detachForHandover(): void {
    if (!this.handoverPaused || this.writeOutcomes.size) throw new Error("PTY handover barrier is incomplete");
    this.handoverDetached = true;
    clearTimeout(this.drainTimer);
    // Close only this JS client's duplicate. The stable owner keeps the master
    // and the parent/reaper role; no signal or exit ACK is sent here.
    this.reader.destroy(); this.dataListeners.clear(); this.exitListeners.clear();
  }
}
