import type { Terminal, ITerminalOptions, ITerminalInitOnlyOptions } from "@xterm/headless";
import { assertOwnership, capture, createOwnedTerminal, ground, ownershipEpoch, restore, validateCapturedSnapshot } from "./vt-checkpoint-binding";
import { MAX_VT_TAIL_BYTES, validateCheckpointJson, validateVtTail } from "./vt-checkpoint-schema";

export type VtOperation = { text: string } | { bytes: string } | { resize: [number, number] };
export interface VtCheckpoint {
  base: unknown;
  tail: VtOperation[];
  metadata: unknown;
}

/** Records applied operations, rather than producer call order: resize is
 * synchronous but xterm parses writes asynchronously. The caller must gate
 * producers before exporting. No custom registration is owned by this layer. */
export class VtCheckpointTerminal {
  readonly terminal: Terminal;
  private base: Buffer;
  private tail: VtOperation[] = [];
  private tailBytes = 0;
  private overflow = false;
  private tainted = false;
  private pending = 0;
  private disposed = false;
  private failure: Error | undefined;

  constructor(options: ITerminalOptions & ITerminalInitOnlyOptions, terminal?: Terminal) {
    this.terminal = terminal ?? createOwnedTerminal(options);
    this.base = capture(this.terminal);
  }

  private owned(): boolean {
    try { assertOwnership(this.terminal, false); return true; } catch { return false; }
  }
  private append(operation: VtOperation, ownedBefore: boolean, epoch: number): void {
    this.tainted ||= !ownedBefore || !this.owned() || epoch !== ownershipEpoch(this.terminal);
    this.tailBytes += Buffer.byteLength(JSON.stringify(operation)) + (this.tail.length ? 1 : 2);
    if (this.tailBytes > MAX_VT_TAIL_BYTES) { this.overflow = true; this.tail = []; }
    else if (!this.overflow) this.tail.push(operation);
    // A parse callback can run before xterm updates its pending-data counter.
    // Compact after the whole current parse batch, never once per queued call.
    queueMicrotask(() => this.compact());
  }
  private compact(): void {
    if (this.disposed || this.pending || !ground(this.terminal)) return;
    try {
      assertOwnership(this.terminal);
      this.base = capture(this.terminal);
      this.tail = []; this.tailBytes = 0; this.overflow = false; this.tainted = false;
      this.failure = undefined;
    } catch (error) { this.failure = error instanceof Error ? error : new Error("VT compaction refused"); }
  }
  write(data: string | Uint8Array, callback?: () => void): void {
    if (this.disposed) return;
    const ownedBefore = this.owned(), epoch = ownershipEpoch(this.terminal);
    const operation: VtOperation = typeof data === "string" ? {text: data} : {bytes: Buffer.from(data).toString("base64")};
    this.pending++;
    this.terminal.write(data, () => {
      this.pending--;
      if (!this.disposed) this.append(operation, ownedBefore, epoch);
      callback?.();
    });
  }
  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    const ownedBefore = this.owned(), epoch = ownershipEpoch(this.terminal);
    this.terminal.resize(cols, rows);
    this.append({resize: [cols, rows]}, ownedBefore, epoch);
  }
  async drain(timeoutMs = 1000): Promise<void> {
    if (this.disposed) throw new Error("VT pane closed during checkpoint");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("VT checkpoint parse drain timed out")), timeoutMs);
      this.terminal.write("", () => { clearTimeout(timer); resolve(); });
    });
    if (this.disposed || this.pending) throw new Error("VT checkpoint writes have not drained");
  }
  async checkpoint(metadata: unknown): Promise<VtCheckpoint> {
    if (this.disposed) throw new Error("VT pane closed during checkpoint");
    await this.drain();
    // The empty flush is not user data and does not enter the retained journal.
    if (this.disposed || this.pending) throw new Error("VT checkpoint writes have not drained");
    assertOwnership(this.terminal);
    this.compact();
    if (this.failure) throw this.failure;
    if (this.overflow) throw new Error("VT tail temporarily ineligible");
    if (this.tainted) throw new Error("VT tail ran under unsupported ownership");
    validateCapturedSnapshot(this.base);
    validateCheckpointJson(metadata, 1024 * 1024);
    validateVtTail(this.tail);
    return {base: JSON.parse(this.base.toString("utf8")), tail: structuredClone(this.tail), metadata: structuredClone(metadata)};
  }
  static async import(checkpoint: VtCheckpoint): Promise<VtCheckpointTerminal> {
    validateCheckpointJson(checkpoint);
    if (Object.keys(checkpoint).sort().join(",") !== "base,metadata,tail") throw new Error("Invalid VT checkpoint envelope");
    validateVtTail(checkpoint.tail);
    validateCheckpointJson(checkpoint.metadata, 1024 * 1024);
    const {term} = restore(Buffer.from(JSON.stringify(checkpoint.base)));
    let tracker: VtCheckpointTerminal | undefined;
    try {
      tracker = new VtCheckpointTerminal({}, term);
      for (const operation of checkpoint.tail) {
        if ("resize" in operation) tracker.resize(...operation.resize);
        else await new Promise<void>(resolve => tracker!.write("text" in operation ? operation.text : Buffer.from(operation.bytes, "base64"), resolve));
      }
      await tracker.checkpoint(checkpoint.metadata);
      return tracker;
    } catch (error) { term.dispose(); throw error; }
  }
  dispose(): void { this.disposed = true; this.terminal.dispose(); this.tail = []; }
}
