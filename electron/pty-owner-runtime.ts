import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { ownerArtifactPaths, PtyOwnerClient, ownerProcessStartIdentity, type OwnerPane } from "./pty-owner-client";
import {settleOwnerSurvivors} from "./pty-owner-survivors";
import { readProcInfo } from "./pty-host-registry";
import { OWNER_SOCKET, prepareOwnerDirectory, ownerBinaryHash, readOwnerRecord, ownerRecordIsLive,
  ownerReaderIsLive, writeOwnerRecord, removeOwnerRecord, type OwnerRecord } from "./pty-owner-registry";

// Main may retain the secret for a replacement JS host. Standalone host/test
// launches generate it here. It is never written to a registry or environment.
function inheritedSecret(): Buffer {
  if (process.env.AYA_PTY_OWNER_FD !== "3") return randomBytes(32);
  delete process.env.AYA_PTY_OWNER_FD;
  try { const bytes = fs.readFileSync(3); if (bytes.length !== 32) throw new Error("Invalid inherited PTY owner secret"); return bytes; }
  finally { fs.closeSync(3); }
}
const secret = inheritedSecret();
/** Only a consumed handover window or an authenticated main continuity request
 * may call this. Never
 * include it in checkpoint state, registries, argv, environment or logs. */
export function ownerHandoverCredential(): Buffer { return Buffer.from(secret); }
export interface RecoveryOwnerIdentity { pid:number; startTime:string; instanceId:string; binaryHash:string }
let recoveryOwner: RecoveryOwnerIdentity | null = null;
let exitAcknowledgements=false;
export function requireOwnerExitAcknowledgements():void {exitAcknowledgements=true;}
/** Must be set before open: recovery must never create a replacement owner. */
export function requireRecoveryOwner(identity: RecoveryOwnerIdentity): void {
  if(runtime)throw new Error("PTY owner runtime already opened before recovery preflight");
  recoveryOwner=identity;
}
let runtime: Promise<OwnerRuntime> | null = null;
let ready: OwnerRuntime | null = null;
let unavailableListener: ((owner: OwnerRuntime) => void) | null = null;
export function setOwnerUnavailableListener(listener: (owner: OwnerRuntime) => void): void { unavailableListener = listener; }
export function currentOwnerRuntime(): OwnerRuntime | null { return ready; }
/** An authenticated continuity request may describe an empty future owner
 * only when no runtime is opening/stopping and no retained owner exists. */
export function ownerRuntimeIsAbsent():boolean{return runtime===null&&ready===null&&readOwnerRecord()===null;}
export function getOwnerRuntime(): Promise<OwnerRuntime> {
  if (ready?.isStopping) return ready.shutdown().then(() => getOwnerRuntime());
  return runtime ??= OwnerRuntime.open().then(value => { ready = value; return value; }).catch(error => { runtime = null; throw error; });
}
export async function shutdownOwnerRuntime(): Promise<void> {
  if (runtime) await (await runtime).shutdown();
}
export class OwnerRuntime {
  readonly deferredExitAcknowledgements=exitAcknowledgements;
  client: PtyOwnerClient | null = null;
  record!: OwnerRecord;
  incompatible = false;
  disconnected = new Map<string, OwnerPane>();
  private inventory = new Map<string, OwnerPane>();
  private exits = new Map<string, (pane: OwnerPane) => void>();
  private pendingExits = new Map<string, OwnerPane>();
  private ending = false;
  private shutdownTask: Promise<void> | null = null;
  private ownerExit: Promise<number | null> | null = null;
  get isStopping(): boolean { return !!this.shutdownTask; }
  pendingSpawns = 0;
  private retainedRestorations=0;
  private idleTimer: NodeJS.Timeout | null = null;
  onUnavailable: (() => void) | null = null;
  private persist(): void {
    this.record.panes = [...this.inventory.values()];
    try { writeOwnerRecord(this.record); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  uncertainSpawn(id: string): void {
    this.incompatible = true;
    this.record.uncertain = [...new Set([...(this.record.uncertain ?? []), id])].slice(0, 25);
    this.persist();
  }
  beginSpawn(id?: string): string | undefined {
    const generation = id ? randomBytes(16).toString("hex") : undefined;
    if (id) {
      if ((this.record.spawnIntents?.length ?? 0) >= 25) throw new Error("Too many pending PTY spawn intents");
      this.record.spawnIntents = [...(this.record.spawnIntents ?? []), { id, generation: generation! }];
      this.record.uncertain = [...new Set([...(this.record.uncertain ?? []), id])];
      this.persist(); // durable intent before SPAWN can fork, even if no reply arrives
    }
    this.pendingSpawns++; if (this.idleTimer) clearTimeout(this.idleTimer); this.idleTimer = null;
    return generation;
  }
  resolveSpawn(id: string, generation: string): void {
    this.record.spawnIntents = this.record.spawnIntents?.filter(intent => intent.id !== id || intent.generation !== generation);
    if (!this.record.spawnIntents?.some(intent => intent.id === id)) this.record.uncertain = this.record.uncertain?.filter(value => value !== id);
    this.persist();
  }
  endSpawn(): void { this.pendingSpawns--; this.scheduleIdle(); }
  /** Keep the stable owner available while JS holds an unapplied exit. This
   * is not a spawn flight and must not prevent a planned lease transfer. */
  holdRestoration():()=>void {
    this.retainedRestorations++;if(this.idleTimer)clearTimeout(this.idleTimer);this.idleTimer=null;
    let held=true;return()=>{if(!held)return;held=false;this.retainedRestorations--;this.scheduleIdle();};
  }
  private scheduleIdle(): void {
    if (this.inventory.size || this.pendingSpawns || this.retainedRestorations || this.incompatible || this.ending || this.idleTimer) return;
    this.idleTimer = setTimeout(() => { this.idleTimer = null; if (!this.inventory.size && !this.pendingSpawns && !this.retainedRestorations) void this.shutdown().catch(() => {}); }, 200);
  }
  static async open(): Promise<OwnerRuntime> {
    prepareOwnerDirectory();
    const result = new OwnerRuntime(), artifacts = ownerArtifactPaths();
    const hash = ownerBinaryHash(artifacts.executable), previous = readOwnerRecord();
    if(recoveryOwner && (!previous || previous.pid!==recoveryOwner.pid || previous.startTime!==recoveryOwner.startTime ||
      previous.instanceId!==recoveryOwner.instanceId || previous.binaryHash!==recoveryOwner.binaryHash || hash!==recoveryOwner.binaryHash || !ownerRecordIsLive(previous))) {
      throw new Error("The recorded PTY owner is dead, changed or incompatible; crash recovery kept its inventory");
    }
    if (previous && !ownerRecordIsLive(previous) && (previous.panes.some(p => !p.acknowledged) || previous.uncertain?.length)) {
      if(recoveryOwner)throw new Error("The recorded PTY owner disappeared during recovery; its inventory was kept");
      if (ownerReaderIsLive(previous) && previous.jsPid !== process.pid) throw new Error("Another JS host still owns these terminals");
      result.record = previous; result.incompatible = true;
      for (const pane of previous.panes) if (!pane.acknowledged) result.inventory.set(pane.id, pane);
      result.disconnected = new Map(result.inventory);
      const own = readProcInfo(process.pid);
      if (!own.startTime) throw new Error("Cannot establish disconnected JS host identity");
      previous.jsPid = process.pid; previous.jsStartTime = own.startTime; result.persist();
      return result;
    }
    if (previous && ownerRecordIsLive(previous)) {
      if (ownerReaderIsLive(previous) && previous.jsPid !== process.pid) throw new Error("Another JS host still owns these terminals");
      result.record = previous;
      for (const pane of previous.panes) if (!pane.acknowledged) result.inventory.set(pane.id, pane);
      if (previous.binaryHash !== hash) result.incompatible = true;
      else {
        try {
          result.client = await PtyOwnerClient.connect(OWNER_SOCKET, secret);
          if (result.client.ownerPid !== previous.pid || result.client.instanceId !== previous.instanceId) {
            result.client.close(); result.client = null;
          }
        }
        catch (error) {
          if (error instanceof Error && /owns the lease/.test(error.message)) throw error;
          // A previous app's secret is gone: explicit recovery must ask first.
        }
      }
      if (!result.client) {
        if(recoveryOwner)throw new Error("The recorded PTY owner could not authenticate recovery");
        result.incompatible = true;
        result.disconnected = new Map(result.inventory);
        const own = readProcInfo(process.pid);
        if (!own.startTime) throw new Error("Cannot establish disconnected JS host identity");
        result.record.jsPid = process.pid; result.record.jsStartTime = own.startTime; result.persist();
        return result;
      }
    } else {
      if(recoveryOwner)throw new Error("The recorded PTY owner disappeared during recovery; no new owner was started");
      const child = spawn(artifacts.executable, ["--socket", OWNER_SOCKET, "--token-fd", "3"], {
        detached: true, stdio: ["ignore", "pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: process.env.HOME },
      });
      const pipe = child.stdio[3] as NodeJS.WritableStream;
      result.ownerExit = new Promise(resolve => child.once("exit", code => resolve(code)));
      pipe.on("error", () => {}); pipe.end(secret);
      let errorText = ""; child.stderr!.on("data", b => { errorText += String(b); });
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([once(child.stdout!, "data"), once(child, "exit").then(() => { throw new Error(`PTY owner failed: ${errorText}`); }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("PTY owner startup timed out")), 5000); })]);
        result.client = await PtyOwnerClient.connect(OWNER_SOCKET, secret);
        const status = readProcInfo(result.client.ownerPid);
        if (!status.startTime || status.probeFailed) throw new Error("Cannot establish PTY owner identity");
        result.record = { pid: result.client.ownerPid, startTime: status.startTime, executable: artifacts.executable,
          binaryHash: hash, instanceId: result.client.instanceId, jsPid: process.pid, jsStartTime: "", panes: [] };
      } catch (error) { result.client?.close(); child.kill("SIGTERM"); throw error; }
      finally { clearTimeout(timer); child.stdout!.destroy(); child.stderr!.destroy(); child.unref(); }
    }
    const client = result.client!;
    if(client.ownerPid!==result.record.pid||client.instanceId!==result.record.instanceId){client.close();throw Error("The authenticated PTY owner instance changed; its inventory was kept");}
    let kernelStart:string|null=null;try{kernelStart=ownerProcessStartIdentity(result.record.pid);}catch{/* Missing kernel identity remains explicitly unknown. */}
    if(result.record.startIdentity&&kernelStart&&result.record.startIdentity!==kernelStart){client.close();throw Error("The PTY owner kernel identity changed; its inventory was kept");}
    if(!result.record.startIdentity&&kernelStart)result.record.startIdentity=kernelStart;
    const panes = await client.list();
    // The authenticated living owner's complete inventory resolves uncertain
    // SPAWN outcomes before any replacement is allowed; masters stay detached.
    result.record.uncertain = [];
    result.record.spawnIntents = [];
    result.record.recoveryFailures = [];
    for (const pane of panes) if (!pane.acknowledged) { result.inventory.set(pane.id, pane); result.disconnected.set(pane.id, pane); }
    const own = readProcInfo(process.pid);
    if (!own.startTime) { client.close(); throw new Error("Cannot establish JS reader identity"); }
    result.record.jsPid = process.pid; result.record.jsStartTime = own.startTime; result.persist();
    client.onExit(pane => result.deliverExit(pane));
    for (const pane of client.takeExits()) result.deliverExit(pane);
    client.onClose(() => { if (!result.ending) { for (const pane of result.inventory.values()) result.disconnected.set(pane.id, pane); result.onUnavailable?.(); unavailableListener?.(result); } });
    return result;
  }
  private deliverExit(pane: OwnerPane): void {
    this.client?.takeExits(); // this runtime is the event consumer, not a second unbounded queue
    this.inventory.set(pane.id, pane);
    if (this.disconnected.has(pane.id)) this.disconnected.set(pane.id, pane);
    this.persist();
    const key = `${pane.id}:${pane.generation}`, listener = this.exits.get(key);
    if (listener) listener(pane); else this.pendingExits.set(key, pane);
  }
  track(pane: OwnerPane, listener: (pane: OwnerPane) => void): void {
    const { id, generation, pid, cols, rows, exited, exitCode, signal, event, acknowledged, startIdentity } = pane;
    this.inventory.set(id, { id, generation, pid, cols, rows, exited, exitCode, signal, event, acknowledged, startIdentity }); this.persist();
    const key = `${pane.id}:${pane.generation}`; this.exits.set(key, listener);
    const pendingExit = this.pendingExits.get(key);
    if (pendingExit) { this.pendingExits.delete(key); queueMicrotask(() => listener(pendingExit)); }
  }
  async retired(pane: OwnerPane): Promise<void> {
    await this.client!.ackExit(pane);
    if (this.inventory.get(pane.id)?.generation === pane.generation) { this.inventory.delete(pane.id); this.disconnected.delete(pane.id); }
    this.exits.delete(`${pane.id}:${pane.generation}`); this.pendingExits.delete(`${pane.id}:${pane.generation}`); this.persist(); this.scheduleIdle();
  }
  async killDisconnected(id: string): Promise<void> {
    const pane = this.disconnected.get(id);
    if (!pane) return;
    if (!this.client) throw new Error("The native owner cannot authenticate this Aya. Restart the terminal host after confirming all work that will stop.");
    if (pane.exited) { await this.retired(pane); return; }
    let delivered: OwnerPane | undefined, timer: NodeJS.Timeout | undefined;
    const key = `${pane.id}:${pane.generation}`;
    const exited = new Promise<OwnerPane>((resolve, reject) => {
      timer = setTimeout(() => { this.exits.delete(key); reject(new Error("The disconnected terminal did not stop; its inventory was kept")); }, 5000);
      this.exits.set(key, exit => { delivered = exit; clearTimeout(timer); resolve(exit); });
    });
    try { await this.client.kill(pane, 1); }
    catch (error) { if (!delivered) { clearTimeout(timer); this.exits.delete(key); throw error; } }
    await this.retired(await exited);
  }
  async detachForHandover(beforeClose: () => void = () => {}): Promise<void> {
    if (!this.client?.isConnected() || this.pendingSpawns || this.incompatible) throw new Error("PTY owner handover barrier is incomplete");
    await this.client.list(); // all preceding owner operations have answered
    // All fallible disk work precedes the commit callback. A failed write or
    // rename still permits abort to resume the connected original reader.
    this.persist();
    beforeClose(); // Last cancellable boundary; no await before lease close.
    this.ending = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.client.close();
  }
  shutdown(): Promise<void> { return this.shutdownTask ??= this.stop(); }
  private async recoverRetainedGroups(orderlyExit: boolean): Promise<void> {
    await settleOwnerSurvivors({record:this.record,inventory:this.inventory,disconnected:this.disconnected,persist:()=>this.persist()},orderlyExit);
  }
  private async stop(): Promise<void> {
    this.ending = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.client?.isConnected()) {
      try { await this.client.shutdown(); }
      catch { if (ownerRecordIsLive(this.record)) process.kill(this.record.pid, "SIGTERM"); }
    } else if (ownerRecordIsLive(this.record)) process.kill(this.record.pid, "SIGTERM");
    const deadline = Date.now() + 5000;
    while (ownerRecordIsLive(this.record)) {
      if (Date.now() > deadline) throw new Error("PTY owner did not stop; its inventory was kept");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await this.recoverRetainedGroups(this.ownerExit !== null && await this.ownerExit === 0);
    removeOwnerRecord(this.record); this.inventory.clear(); this.disconnected.clear(); runtime = null; ready = null;
  }
}
