// Old-host side of a planned replacement. Browser state remains opaque here;
// only core/process state and bounded private escrow belong to the PTY host.
import { mkdir, lstat, readdir } from "node:fs/promises";
import { freezePtyCore, abortPtyCoreHandover, frozenPtyCoreParts, excludeFrozenPtyPane, stopIneligiblePtyPanes, detachPtyCoreForHandover, type CoreHandoverPreflight } from "./pty-core";
import { writeCheckpoint, readCheckpoint, discardCheckpoint, type CheckpointReceipt, type CheckpointPart } from "./pty-checkpoint-store";
import { encodeCheckpointPayload, checkpointPayloadSize } from "./pty-checkpoint-payload";
import { MAX_CHECKPOINT_BYTES } from "./vt-checkpoint-schema";
import type { HandoverPeer } from "./pty-handover-window";

export interface HostHandoverState extends CoreHandoverPreflight {
  core: CheckpointReceipt;
  display: CheckpointReceipt | null;
  coreRawBytes: number;
  displayRawBytes: number;
  coreEncodedBytes: number;
  displayEncodedBytes: number;
  deadline: number;
}
interface Pending {
  peer: HandoverPeer;
  recipient?: HandoverPeer;
  deadline: number;
  phase: "preparing" | "frozen" | "publishing" | "published" | "reused" | "committing" | "detached" | "blocked";
  work?: Promise<HostHandoverState>;
  cleanupWork?: Promise<void>;
  aborted: boolean;
  timer?: NodeJS.Timeout;
  core?: CheckpointReceipt;
  display: CheckpointReceipt | null;
  coreRawBytes: number;
  displayRawBytes: number;
  coreEncodedBytes: number;
  displayEncodedBytes: number;
  eligible: HostHandoverState["eligible"];
  ineligible: HostHandoverState["ineligible"];
}
const same = (a: HandoverPeer | undefined, b: HandoverPeer): boolean => !!a && a.pid === b.pid && a.startIdentity === b.startIdentity;
async function emptyPrivateRoot(root: string): Promise<void> {
  await mkdir(root, {mode:0o700}).catch(error => {if(error.code !== "EEXIST") throw error;});
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) throw new Error("Unsafe terminal checkpoint directory");
  if ((await readdir(root)).length) throw new Error("An earlier terminal checkpoint is still present; its data was kept");
}
export class HostHandover {
  private pending: Pending | null = null;
  constructor(private readonly coreRoot: string, private readonly displayRoot: string) {}
  get active(): boolean {return !!this.pending && this.pending.phase !== "blocked";}
  private own(peer: HandoverPeer): Pending {
    const p = this.pending;
    if (!p || !same(p.recipient ?? p.peer, peer)) throw new Error("Terminal handover peer refused");
    if (p.aborted || p.phase === "blocked" || Date.now() >= p.deadline) throw new Error("Terminal handover is no longer ready");
    return p;
  }
  private summary(p: Pending): HostHandoverState {
    if (!p.core) throw new Error("Terminal checkpoint is not ready");
    return {core:p.core,display:p.display,coreRawBytes:p.coreRawBytes,displayRawBytes:p.displayRawBytes,coreEncodedBytes:p.coreEncodedBytes,displayEncodedBytes:p.displayEncodedBytes,deadline:p.deadline,eligible:p.eligible,ineligible:p.ineligible};
  }
  async prepare(peer: HandoverPeer, deadline: number): Promise<HostHandoverState> {
    if (this.pending || !Number.isSafeInteger(deadline) || deadline <= Date.now() || deadline - Date.now() > 120000) throw new Error("Terminal handover preparation refused");
    const p: Pending = {peer:{...peer},deadline,phase:"preparing",aborted:false,display:null,coreRawBytes:0,displayRawBytes:0,coreEncodedBytes:0,displayEncodedBytes:0,eligible:[],ineligible:[]};
    this.pending = p;
    p.timer = setTimeout(() => {void this.abort().catch(() => {});}, Math.max(1,deadline-Date.now()));
    p.work = this.prepareRecord(p);
    return p.work;
  }
  private async prepareRecord(p: Pending): Promise<HostHandoverState> {
    try {
      await emptyPrivateRoot(this.coreRoot); await emptyPrivateRoot(this.displayRoot);
      if (p.aborted) throw new Error("Terminal handover was cancelled");
      const result = await freezePtyCore();
      p.ineligible = result.ineligible;
      const selected = new Set<string>();
      async function* records(): AsyncGenerator<CheckpointPart> {
        for (const pane of frozenPtyCoreParts()) {
          if (p.aborted) throw new Error("Terminal handover was cancelled");
          const raw = Buffer.from(JSON.stringify(pane));
          if (raw.length > MAX_CHECKPOINT_BYTES - p.coreRawBytes) {
            const reason = "The pane exceeds the aggregate terminal checkpoint budget";
            excludeFrozenPtyPane(pane.id,reason); p.ineligible.push({id:pane.id,reason}); continue;
          }
          const data = encodeCheckpointPayload(raw);
          if (data.length > MAX_CHECKPOINT_BYTES-p.coreEncodedBytes) {
            const reason = "The pane exceeds the aggregate encoded checkpoint budget";
            excludeFrozenPtyPane(pane.id,reason);p.ineligible.push({id:pane.id,reason});continue;
          }
          p.coreRawBytes += raw.length;p.coreEncodedBytes += data.length;selected.add(pane.id);
          yield {id:pane.id,generation:(pane.vt.metadata as {generation:string}).generation,data};
        }
      }
      p.core = await writeCheckpoint(this.coreRoot, records());
      p.eligible = result.eligible.filter(pane => selected.has(pane.id));
      if (p.aborted || Date.now() >= p.deadline) throw new Error("Terminal handover was cancelled or expired");
      p.phase = "frozen";
      return this.summary(p);
    } catch (error) {
      p.aborted = true; abortPtyCoreHandover();
      await this.cleanup(p);
      throw error;
    }
  }
  async publish(peer: HandoverPeer, display: CheckpointReceipt | null): Promise<HostHandoverState> {
    const p = this.own(peer);
    if (p.phase !== "frozen") throw new Error("Terminal handover publication refused");
    // Claim the only publication slot before any receipt I/O. A rejected
    // duplicate never transfers receipt ownership from its caller.
    p.phase = "publishing";
    // Store ownership before validation so abort retains unsafe data and blocks
    // further attempts rather than accumulating unknown checkpoint directories.
    p.display = display;
    let bytes = 0, encoded = 0;
    if (display) for await (const part of readCheckpoint(this.displayRoot,display)) {
      if (!p.eligible.some(pane => pane.id === part.id && pane.generation === part.generation)) throw new Error("Display checkpoint pane identity refused");
      bytes += checkpointPayloadSize(part.data);
      encoded += part.data.length;
      if (bytes > 96*1024*1024 || bytes > MAX_CHECKPOINT_BYTES-p.coreRawBytes) throw new Error("Display checkpoint aggregate decoded-byte limit");
      if (encoded > 96*1024*1024 || encoded > MAX_CHECKPOINT_BYTES-p.coreEncodedBytes) throw new Error("Display checkpoint aggregate encoded-byte limit");
    }
    if (p.aborted || Date.now() >= p.deadline) throw new Error("Terminal handover expired");
    p.displayRawBytes = bytes;p.displayEncodedBytes=encoded;p.phase = "published";
    return this.summary(p);
  }
  adopt(peer: HandoverPeer): HostHandoverState {
    const p = this.pending;
    if (!p || p.phase !== "published" || p.aborted || Date.now() >= p.deadline || p.recipient) throw new Error("Terminal handover recipient refused");
    p.recipient = {...peer}; return this.summary(p);
  }
  assertAnnouncement(peer: HandoverPeer, deadline: number): void {
    const p = this.own(peer);
    if (p.phase !== "published" || p.deadline !== deadline) throw new Error("Terminal checkpoint was not published for this announcement");
  }
  async detach(peer: HandoverPeer, consented: string[]): Promise<void> {
    const p = this.own(peer);
    if (!same(p.recipient,peer) || p.phase !== "published") throw new Error("Terminal handover detach refused");
    await stopIneligiblePtyPanes(consented);
    if (p.aborted || Date.now() >= p.deadline) throw new Error("Terminal handover expired before detach");
    await detachPtyCoreForHandover(() => {
      // LIST was still cancellable. Lease close is synchronous after this
      // callback, so expiry/abort must now leave readers and escrow alone.
      this.own(peer);
      if (p.phase !== "published") throw new Error("Terminal handover commit refused");
      clearTimeout(p.timer); p.phase = "committing";
    });
    clearTimeout(p.timer); p.phase = "detached";
    // Files remain for the successor's validation/restore acknowledgement.
  }
  reuse(peer: HandoverPeer): HostHandoverState {
    const p = this.own(peer);
    if (!same(p.recipient,peer) || p.phase !== "published") throw new Error("Terminal host reuse refused");
    abortPtyCoreHandover(); p.phase = "reused";
    return this.summary(p);
  }
  async acknowledgeReuse(peer: HandoverPeer): Promise<void> {
    const p = this.own(peer);
    if (p.phase !== "reused") throw new Error("Terminal reuse acknowledgement refused");
    await this.cleanup(p);
  }
  async abort(peer?: HandoverPeer): Promise<void> {
    const p = this.pending;
    if (!p) return;
    if (peer && !same(p.recipient ?? p.peer,peer)) throw new Error("Terminal handover abort peer refused");
    if (p.phase === "detached" || p.phase === "committing") throw new Error("Terminal handover already committed");
    p.aborted = true; abortPtyCoreHandover();
    await p.work?.catch(() => {});
    if (this.pending === p) await this.cleanup(p);
  }
  private cleanup(p: Pending): Promise<void> {
    if (!p.cleanupWork) p.cleanupWork = this.removeFiles(p).finally(() => {p.cleanupWork=undefined;});
    return p.cleanupWork;
  }
  private async removeFiles(p: Pending): Promise<void> {
    clearTimeout(p.timer);
    try {
      if (p.core) {await discardCheckpoint(this.coreRoot,p.core);p.core=undefined;}
      if (p.display) {await discardCheckpoint(this.displayRoot,p.display);p.display=null;}
      if (this.pending === p) this.pending = null;
    } catch (error) {p.phase="blocked";throw error;}
  }
}
