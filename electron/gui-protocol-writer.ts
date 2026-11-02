import type { Writable } from 'node:stream';

interface Frame { text: string; bytes: number; timer: ReturnType<typeof setTimeout> }
/** Bounds both our queue and Node's writable buffer. A queued frame must leave
 * within the transport deadline; otherwise retire the entire connection rather
 * than delivering stale commands after their RPC has timed out. */
export class GuiProtocolWriter {
  private queue: Frame[] = [];
  private bytes = 0;
  private active = false;
  private closed = false;
  private clearDrain: (() => void) | null = null;
  constructor(private stream: Writable, private label: string, private failed: (message: string) => void,
    private limits = { frameBytes: 16 * 1024 * 1024, queueBytes: 32 * 1024 * 1024, frames: 128, timeoutMs: 10_000 }) {
    stream.on('error', this.onError);
    stream.on('close', this.onClose);
  }
  private onError = (error: Error) => this.fail(`connection lost: ${error.message}`);
  private onClose = () => this.fail('connection closed while writing');
  write(value: unknown): void {
    if (this.closed || this.stream.destroyed || !this.stream.writable) throw Error(`${this.label} is disconnected`);
    const text = JSON.stringify(value) + '\n', bytes = Buffer.byteLength(text);
    if (bytes > this.limits.frameBytes) throw Error(`${this.label}: message exceeds the 16 MiB protocol limit; send fewer attachments or less text`);
    if (this.queue.length >= this.limits.frames || this.bytes + bytes > this.limits.queueBytes) throw Error(`${this.label}: outgoing message queue is full; wait for the agent before trying again`);
    const timer = setTimeout(() => this.fail('communication stalled: the agent did not accept queued data'), this.limits.timeoutMs);
    timer.unref();
    this.queue.push({ text, bytes, timer }); this.bytes += bytes;
    this.pump();
  }
  private pump(): void {
    if (this.closed || this.active || !this.queue.length) return;
    const frame = this.queue[0];
    this.active = true;
    let returned = false, completed = false, drained = false, blocked = false;
    const finish = () => {
      if (this.closed || !returned || !completed || (blocked && !drained)) return;
      this.clearDrain?.(); this.clearDrain = null;
      clearTimeout(frame.timer); this.queue.shift(); this.bytes -= frame.bytes; this.active = false;
      this.pump();
    };
    const onDrain = () => { drained = true; finish(); };
    this.stream.once('drain', onDrain);
    this.clearDrain = () => this.stream.off('drain', onDrain);
    try {
      blocked = !this.stream.write(frame.text, error => {
        if (error) { this.fail(`connection lost: ${error.message}`); return; }
        completed = true; finish();
      });
      returned = true; finish();
    } catch (error) { this.fail(`connection lost: ${error instanceof Error ? error.message : String(error)}`); }
  }
  private fail(reason: string) {
    if (this.closed) return;
    this.close(); this.failed(`${this.label}: ${reason}`);
  }
  close(): void {
    this.closed = true;
    this.clearDrain?.(); this.clearDrain = null;
    this.stream.off('error', this.onError); this.stream.off('close', this.onClose);
    for (const frame of this.queue) clearTimeout(frame.timer);
    this.queue = []; this.bytes = 0; this.active = false;
  }
  get pendingBytes() { return this.bytes; }
}
