import {validatePlannedContinuity} from "./pty-handover-continuity";
import { explainPaneSnapshot, unavailablePaneState, type PaneStateResult } from "./pane-state";
import { prepareSpawn, watchAgentSession } from "./pty-prepare";
import { snapshotBusy, snapshotHold, snapshotStatus } from "./vt-state";
import { HOLD_NOT_RUNNING, HOLD_STARTING } from "./pane-holds";
import { getProcessCwd } from "./process-cwd";
import {validVtSnapshotFence, type VtSnapshot, type VtSnapshotFence} from "./vt-mirror";
import { spawn,type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import type { WebContents } from "electron";
import { PTY_HOST_SOCKET_PATH, PTY_HOST_STDERR_FILE, AYA_HOME } from "./paths";
import { PTY_HOST_NOT_CONNECTED, PTY_HOST_UNKNOWN_REQUEST } from "./constants";
import { LAUNCH_STARTING, LAUNCH_UNREACHABLE, LAUNCH_UNSUPPORTED, type LaunchAnswer, type PaneLaunch } from "./launch-mode";
import type { PaneSize } from "./pane-render";
import {
  asPaneSize,
  asVtSnapshot,
  asSearchResult,
  type PtyHostMessage,
  type PtyHostRequest,
  type PtyHostResponse,
  type PtyOwnerStatus,
} from "./pty-host-protocol";
import {
  hostBuildHash,
  hostRuntimeIdentity,
  RUN_AS_NODE_VALUE,
  RUN_AS_NODE_VAR,
  UNKNOWN_SCRIPT_HASH,
  type HostIdentity,
} from "./pty-host-staleness";
import type {HostHandoverState} from "./pty-host-handover";
import type {CheckpointReceipt} from "./pty-checkpoint-store";
import type {HandoverTicket} from "./pty-handover-ticket";
import {preflightCoreHandover,readCoreHandover,type HandoverBootstrap} from "./pty-handover-bootstrap";
import {handoverState,handoverCommitResult} from "./pty-handover-state";
import {ownerArtifactPaths,ownerProcessStartIdentity} from "./pty-owner-client";
import {PtyCrashRecovery,CRASH_RECOVERY_POLICY,type CrashRecoveryPolicy,type RecoveryAttemptResult} from "./pty-crash-recovery";
import {parseRecoveryBootstrap,type RecoveryBootstrap,type RecoveryPane} from "./pty-recovery-bootstrap";
import {readProcInfo} from "./pty-host-registry";
import {ownerRecordIsLive,ownerReaderIsLive,readOwnerRecord} from "./pty-owner-registry";
import type {RecoveryOwnerIdentity} from "./pty-owner-runtime";
import {ownerBinaryHash} from "./pty-owner-registry";
import {classifyIdentity} from "./pty-host-staleness";
import { coalesceAdjacentData } from "./pty-event-coalescer";
import type { BufferSearchHit } from "./pty";
import type { PtyEvent, SpawnRequest } from "./types";
import {authenticateHostSocket} from "./pty-host-auth-transport";
import {newHostAuthCapability} from "./pty-host-auth-transfer";
import {HostAuthError,HostPrincipalBusyError,HOST_PRINCIPAL_BUSY_REASON,type HostAuthPeer} from "./pty-host-auth";
import {handoverPeer} from "./pty-handover-window";
import {refusedHostStatus,HOST_AUTH_REFUSAL_REASON,HOST_UNANNOUNCED_REASON,type HostAuthenticationProblem} from "./pty-host-auth-status";
import {validateOwnerContinuity,validateTransferredOwnerContinuity} from "./pty-host-owner-continuity";
import {probeLegacyInventory} from "./pty-host-legacy-status";
import {retireUnavailableOwner,ownerRetirementDeps} from "./pty-host-owner-retirement";
import {restartRefusedHost,refusedRestartDeps} from "./pty-host-auth-restart";
import {OrdinaryAuthAnnouncement} from "./pty-host-auth-announcement";
import type {AuthTransferTicket} from "./pty-host-auth-ticket";
import {redeemHostCapability} from "./pty-host-auth-redemption";
import {assertHostCreationSafe,waitForHostShutdown} from "./pty-host-start-guard";

// Deadline waiting for a started pty host to create its socket and accept on it (ms).
export const PTY_HOST_SOCKET_WAIT_TIMEOUT_MS = 5_000;
/** How long restart() waits for the old host to exit after "shutdown". The host's own SIGKILL step for panes that
 *  ignore the hang-up comes at 750 ms; a host still running past this is left, and Diagnostics lists it. */
export const PTY_HOST_EXIT_WAIT_MS = 5_000;
/** How long restart() waits for each answer from the host it replaces: a hung host must not hold up every pane. */
export const PTY_HOST_RESTART_REQUEST_TIMEOUT_MS = 2_000;
/** After SIGKILL to a host that outlived PTY_HOST_EXIT_WAIT_MS, how long restart() waits for it to be gone. */
export const PTY_HOST_KILL_WAIT_MS = 1_000;
/** pty-host.stderr.log moves to .1 at host start once it is this big, so it never grows without end. */
export const PTY_HOST_STDERR_MAX_BYTES = 1_000_000;

/** An append-only descriptor for the host's stderr, or "ignore" when the file cannot be opened. Never a link: the
 *  file sits in the user's Aya home, and a planted link must not point the host's output elsewhere. */
export function openHostStderr(file: string = PTY_HOST_STDERR_FILE, maxBytes = PTY_HOST_STDERR_MAX_BYTES): number | "ignore" {
  try {
    try {
      const st = fs.lstatSync(file);
      if (st.isFile() && st.size > maxBytes) fs.renameSync(file, `${file}.1`);
    } catch {
      // no file yet
    }
    const fd = fs.openSync(
      file,
      fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      0o600,
    );
    try {
      // The creation mode covers a new file only: an older one with wider permissions is narrowed, and anything but
      // a regular file (a FIFO would stall the host's writes) is not used.
      if (!fs.fstatSync(fd).isFile()) throw new Error("not a regular file");
      fs.fchmodSync(fd, 0o600);
      return fd;
    } catch (err) {
      fs.closeSync(fd);
      throw err;
    }
  } catch {
    return "ignore";
  }
}
// Interval between connect attempts while waiting (ms).
const PTY_HOST_SOCKET_POLL_INTERVAL_MS = 50;
const DISPOSED_MESSAGE = "PTY host client is disposed";
// holdReason when the terminal host cannot say; the message waits in the inbox.
// A host kept from before an update does not know the request: say the fix.
export const PANE_HOLD_UNKNOWN =
  "cannot be checked: the terminal host did not answer (after an update, use Settings > Diagnostics > PTY host > Restart)";

const PANE_ENDED_EVENTS: ReadonlySet<string> = new Set(["exit", "no-session"]);

interface PendingRequest {
  type?:PtyHostRequest["type"];
  ptyId?:string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/** Anything PTY events can be forwarded to: a window's WebContents, or Aya Web's virtual sink for its
 *  WebSocket clients. */
export interface PtyEventSink {
  isDestroyed(): boolean;
  send(channel: "pty:event", event: PtyEvent): void;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** True once `pid` no longer exists, false if it still runs after `ms`. */
export async function waitForExit(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      // EPERM: the pid now belongs to another user's process, so ours is gone.
      if ((err as NodeJS.ErrnoException).code === "ESRCH" || (err as NodeJS.ErrnoException).code === "EPERM") {
        return true;
      }
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, PTY_HOST_SOCKET_POLL_INTERVAL_MS));
  }
}

export interface HostRestartTarget {
  pid:number|null;startTime:string|null;identity:HostIdentity|null;ptyCount:number;owner?:PtyOwnerStatus;authentication?:HostAuthenticationProblem;ownerUnavailable?:boolean;recoveryReason?:string;
}
export interface HostRestartConsent {
  target:Pick<HostRestartTarget,"pid"|"startTime"|"owner">;
  confirmChanged:(target:HostRestartTarget)=>Promise<boolean>;
  confirmSurvivors?:(target:HostRestartTarget)=>Promise<boolean>;
}
const sameRestartTarget=(a:HostRestartConsent["target"],b:HostRestartConsent["target"]):boolean=>
  a.pid===b.pid&&a.startTime===b.startTime&&JSON.stringify(a.owner?[a.owner.pid,a.owner.startTime,a.owner.startIdentity??null,a.owner.instanceId,a.owner.hash]:null)===JSON.stringify(b.owner?[b.owner.pid,b.owner.startTime,b.owner.startIdentity??null,b.owner.instanceId,b.owner.hash]:null);

export class PtyHostClient {
  private socket: net.Socket | null = null;
  private observationOnly = false;
  private readonly ownerSecret = randomBytes(32);
  private hostAuthKey:Buffer|null=null;
  private ordinaryAnnouncement:OrdinaryAuthAnnouncement|null=null;
  private receivedAuthTransfer:{ticket:AuthTransferTicket;receipt?:string;retirementOwner?:RecoveryOwnerIdentity}|null=null;
  private authRefusalPeer:HostAuthPeer|null|undefined;
  private unannouncedRefusal=false;
  private principalBusyPeer:HostAuthPeer|null|undefined;
  private readonly principalBusyPanes=new Set<string>();
  private readonly principalAttaches=new Map<string,Set<AbortController>>();
  private principalRetry:Promise<void>|null=null;
  private principalRetryExhausted=false;
  private readonly startupCancelled=new AbortController();
  private principalRetryCancel:AbortController|null=null;
  private readonly authRefusedPanes=new Map<string,string>();
  private ownerBacked = false;
  private metadataRequired = false;
  private metadataSocket: net.Socket | null = null;
  private lastHostPid: number | undefined;
  private lostOwned = new Set<string>();
  private connectPromise: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = "";
  // Whether the CURRENT host connection is to a host that was already running
  // (found via its socket) rather than one this client spawned. Drives the
  // attachIfReused resolution in spawn(): a reused host may still hold
  // sessions from before this app session; a fresh host cannot. Updated on
  // every (re)connect; false until the first connect completes (spawn()
  // awaits connect first, so it always reads a settled value).
  private reusedHost = false;
  private plannedReusedBoot = false;
  private pendingPlannedHost:ChildProcess|null=null;
  private readonly consentedBootSpawns = new Set<string>();
  // All live Aya windows' webContents (plus any virtual sink). PTY events are
  // broadcast to every sink; each renderer's event bus routes by ptyId, so a
  // window that doesn't host the terminal does a single cheap no-op per event.
  private readonly sinks = new Set<PtyEventSink>();
  private disposed = false;
  private issuedShutdown=false;
  private ownsOwnerKey=false;
  private ownerContinuityUnavailable=false;
  private continuityNotice="";
  private ownerRetired=false;
  private legacyPaneIds:string[]=[];
  private markContinuityUnavailable():void {
    this.ownerContinuityUnavailable=true;
    this.continuityNotice="Automatic terminal host recovery is off because its recovery data is unavailable. This host still serves the panes; if it stops, the panes stay disconnected while their processes may keep running. Aya does not respawn them.";
    for(const ptyId of this.live)this.sendToSinks([{type:"recovery-unavailable",ptyId,reason:this.continuityNotice}]);
  }
  private blockUnavailableOwner():Error {
    this.crashBlocked=true;
    const prefix="Aya could not verify recovery data from the surviving terminal host. Input remains disabled. ";
    let identified=false;
    try{const record=readOwnerRecord(),expected=this.recoveryOwner??this.crashContext?.owner;
      identified=!!record&&!!expected&&record.pid===expected.pid&&record.startTime===expected.startTime&&record.instanceId===expected.instanceId&&record.binaryHash===expected.binaryHash&&!!record.startIdentity;
    }catch{/* Unreadable private metadata never promises a safe stop. */}
    this.recoveryReason=this.ownerRetired
      ? "The terminal owner has stopped. Retained processes still need separate confirmation; input remains disabled. Use Settings > Diagnostics > PTY host > Restart to review them."
      : prefix+(identified?"Use Settings > Diagnostics > PTY host > Restart to review stopping the terminal owner. Stopping it ends its panes; surviving processes need a separate confirmation."
        : "The owner's kernel start identity was not recorded or cannot be verified. Aya cannot stop it safely; its processes and inventory were kept.");
    return Object.assign(new Error("The terminal host is disconnected or recovering. This request was not sent."),{code:"PTY_HOST_OWNER_UNAVAILABLE"});
  }
  private uncertainInput=new Set<string>();
  private recoveryScreens=new Map<string,Extract<PtyEvent,{type:"recovery-screen"}>>();
  private recoveryOwner:RecoveryOwnerIdentity|null=null;
  private lastHostStart:string|null=null;
  private crashSupervisor:PtyCrashRecovery|null=null;
  private crashTask:Promise<boolean>|null=null;
  private crashAttempt:Promise<RecoveryAttemptResult>|null=null;
  private crashAgain=false;
  private crashBlocked=false;
  private closeEpoch=0;
  private recoveryReason:string|undefined;
  private recoveryRetryable=false;
  private recoveryFailure="";
  private recoveredStates=new Map<string,Extract<PtyEvent,{type:"recovery-state"}>>();
  private crashContext:{pid:number;start:string;owner:RecoveryOwnerIdentity}|null=null;
  private recoveryLaunches=new Map<string,{request:SpawnRequest;launch:PaneLaunch;spawnedAt:number;pid:number}>();
  private recoveryHooks:{restored?:(panes:Array<{id:string;generation:string;notice:string}>)=>void;log?:(event:string,fields:Record<string,unknown>)=>void}={};
  enableCrashRecovery(hooks:typeof this.recoveryHooks={},policy?:CrashRecoveryPolicy,initialUsed=0):void {
    if(this.crashSupervisor)return;this.recoveryHooks=hooks;
    this.crashSupervisor=new PtyCrashRecovery({policy,initialUsed,attempt:signal=>{
      const attempt=this.recoverCrashedHost(signal).finally(()=>{if(this.crashAttempt===attempt)this.crashAttempt=null;});this.crashAttempt=attempt;return attempt;
    },state:state=>{
      this.recoveryHooks.log?.("pty-crash-recovery",{state});
      if(state==="exhausted"){
        this.recoveryRetryable=this.ownsOwnerKey&&!!this.crashContext&&!this.disposed;
        this.recoveryReason="Aya could not restart the terminal host within its recovery budget. The processes may still be running in the native owner; Aya did not respawn them."+(this.recoveryFailure?" "+this.recoveryFailure:"")+(this.recoveryRetryable?" Try again makes one more recovery attempt without restarting the processes.":"");
        for(const ptyId of new Set([...this.lostOwned,...this.live]))this.sendToSinks([{type:"disconnected",ptyId,reason:this.recoveryReason,recoveryBlocked:true,retryable:this.recoveryRetryable}]);
      }
    }});
  }
  async retryCrashRecovery():Promise<boolean> {
    if(this.disposed||!this.recoveryRetryable||!this.ownsOwnerKey||!this.crashContext||this.crashTask)return false;
    this.recoveryRetryable=false;this.recoveryFailure="";this.crashSupervisor?.dispose();this.crashSupervisor=null;
    this.recoveryReason="Trying to recover the terminal host. The processes were kept; input remains disabled until replay is applied.";
    for(const ptyId of this.lostOwned)this.sendToSinks([{type:"disconnected",ptyId,reason:this.recoveryReason,recoveryBlocked:true,retryable:false}]);
    if(this.crashAttempt){
      try{await withTimeout(this.crashAttempt,4000);}catch{
        this.recoveryRetryable=true;this.recoveryReason="The previous recovery cleanup has not finished. No new terminal host was started; the processes were kept. Try again after cleanup finishes.";
        for(const ptyId of this.lostOwned)this.sendToSinks([{type:"disconnected",ptyId,reason:this.recoveryReason,recoveryBlocked:true,retryable:true}]);return false;
      }
    }
    if(this.disposed)return false;
    this.enableCrashRecovery(this.recoveryHooks,CRASH_RECOVERY_POLICY,CRASH_RECOVERY_POLICY.delays.length-1);
    this.beginCrashRecovery();return await this.crashTask??false;
  }
  private readonly preparations = new Map<number, AbortController>();
  private readonly sessionWatches = new Map<string, () => void>();
  private readonly screenStates = new Map<string, { generation: string; waiting: boolean; dialog?: string }>();
  private userRuleStatusObserver:((ptyId:string,snapshot:VtSnapshot)=>Promise<{generation:string;revision:string;waiting:boolean;dialog?:string;sourceRevision?:string;appliedSnapshot?:VtSnapshot}|null>)|null=null;
  private readonly latestRuleSnapshots=new Map<string,VtSnapshot>();
  private readonly ruleStatusStates=new Map<string,{generation:string;revision:string;waiting:boolean;dialog?:string}>();
  private readonly ruleStatusPending=new Map<string,VtSnapshot>();
  private readonly ruleStatusTimers=new Map<string,ReturnType<typeof setTimeout>>();
  // Panes this client spawned and has not seen end: the ones a lost host takes
  // down without a word.
  private readonly live = new Set<string>();
  // The app asked this host to go (restart, shutdown): the renderer already
  // knows, so the close that follows is not a loss. Cleared on the next connect.
  private hostAsked = false;
  // Set while restart() replaces the host: every other request waits for it, so no request starts the next host
  // (or reaches the old one) before the old host has exited.
  private replacing: Promise<boolean> | null = null;

  constructor(private readonly hostScript: string, private readonly prepare: typeof prepareSpawn = prepareSpawn) {}

  attachWebContents(webContents: WebContents | PtyEventSink): void {
    this.sinks.add(webContents);
    if(!webContents.isDestroyed()&&this.ownerContinuityUnavailable&&!this.crashBlocked)for(const ptyId of this.live)webContents.send("pty:event",{type:"recovery-unavailable",ptyId,reason:this.continuityNotice});
    if(!webContents.isDestroyed())for(const [ptyId,reason] of this.authRefusedPanes)webContents.send("pty:event",this.principalBusyPanes.has(ptyId)?{type:"host-connection",ptyId,reason,connected:false}:{type:"disconnected",ptyId,reason});
    if(!webContents.isDestroyed()&&this.userRuleStatusObserver)for(const [ptyId,snapshot] of this.latestRuleSnapshots){
      const observer=this.userRuleStatusObserver;
      void observer(ptyId,snapshot).then(status=>{
        const latest=this.latestRuleSnapshots.get(ptyId);
        if(!status||webContents.isDestroyed()||this.userRuleStatusObserver!==observer||latest?.generation!==status.generation)return;
        const alreadyPublished=this.ruleStatusStates.get(ptyId);
        const sameRevision=latest.revision===status.revision;
        const ackAdvancedRevision=status.sourceRevision===latest.revision&&status.appliedSnapshot?.generation===status.generation&&status.appliedSnapshot.revision===status.revision;
        if(!sameRevision&&!ackAdvancedRevision)return;
        const cached=alreadyPublished?.generation===status.generation&&alreadyPublished.waiting===status.waiting&&alreadyPublished.dialog===status.dialog&&
          (alreadyPublished.revision===status.revision||ackAdvancedRevision&&alreadyPublished.revision===status.sourceRevision);
        this.publishRuleStatus(ptyId,status);
        // Existing rule status may already be cached for another window. A new
        // sink still needs its own initial waiting state.
        if(cached&&status.waiting)webContents.send("pty:event",{type:"vt-status",ptyId,waiting:true,...(status.dialog?{dialog:status.dialog}:{})});
      }).catch(()=>{});
    }
  }

  /** User-rule status replaces the builtin-only renderer verdict while active.
   * The no-files path leaves the existing host status path untouched. */
  setUserRuleStatusObserver(observer:((ptyId:string,snapshot:VtSnapshot)=>Promise<{generation:string;revision:string;waiting:boolean;dialog?:string;sourceRevision?:string;appliedSnapshot?:VtSnapshot}|null>)|null):void{
    this.userRuleStatusObserver=observer;
    for(const timer of this.ruleStatusTimers.values())clearTimeout(timer);this.ruleStatusTimers.clear();this.ruleStatusPending.clear();
    if(observer){for(const [id,snapshot] of this.latestRuleSnapshots)this.evaluateRuleStatus(id,snapshot);return;}
    for(const [id,snapshot] of this.latestRuleSnapshots){
      const prior=this.ruleStatusStates.get(id);this.ruleStatusStates.delete(id);
      const builtin=snapshotStatus(snapshot);
      if(prior?.waiting&&!builtin.waiting)this.sendToSinks([{type:"vt-status",ptyId:id,waiting:false}]);
      // This is cached evidence, not a new host observation. In particular it
      // must never reach the legacy generation-only composer ACK path.
      this.acceptSnapshot(id,snapshot,false,false);
    }
  }
  private evaluateRuleStatus(ptyId:string,snapshot:VtSnapshot):void{
    const observer=this.userRuleStatusObserver;if(!observer)return;
    this.ruleStatusPending.set(ptyId,snapshot);
    if(this.ruleStatusTimers.has(ptyId))return;
    const timer=setTimeout(()=>{
      this.ruleStatusTimers.delete(ptyId);const latest=this.ruleStatusPending.get(ptyId);this.ruleStatusPending.delete(ptyId);
      if(!latest||this.userRuleStatusObserver!==observer)return;
      void observer(ptyId,latest).then(status=>{if(!status||this.userRuleStatusObserver!==observer)return;this.publishRuleStatus(ptyId,status);}).catch(()=>{});
    },50);
    timer.unref?.();this.ruleStatusTimers.set(ptyId,timer);
  }
  private publishRuleStatus(ptyId:string,status:{generation:string;revision:string;waiting:boolean;dialog?:string;sourceRevision?:string;appliedSnapshot?:VtSnapshot}):void{
    let latest=this.latestRuleSnapshots.get(ptyId);if(!latest||latest.generation!==status.generation)return;
    // A checked composer ACK advances the authoritative host revision without
    // emitting a snapshot event. Accept its fresh snapshot only if no newer
    // received snapshot has displaced the revision that the observer checked.
    if(status.appliedSnapshot&&status.sourceRevision===latest.revision&&status.appliedSnapshot.generation===status.generation&&status.appliedSnapshot.revision===status.revision){
      latest=status.appliedSnapshot;this.latestRuleSnapshots.set(ptyId,latest);
    }
    if(latest.revision!==status.revision)return;
    const old=this.ruleStatusStates.get(ptyId);if(old?.generation===status.generation&&old.revision===status.revision&&old.waiting===status.waiting&&old.dialog===status.dialog)return;
    const priorWaiting=old?.generation===status.generation?old.waiting:false;
    const edge=(!priorWaiting&&status.waiting)||(priorWaiting&&!status.waiting)||(priorWaiting&&status.waiting&&old?.dialog!==status.dialog);
    this.ruleStatusStates.set(ptyId,status);
    // A first non-waiting status must not invent an edge for a new sink.
    if(!edge)return;
    this.sendToSinks([{type:"vt-status",ptyId,waiting:status.waiting,...(status.waiting&&status.dialog?{dialog:status.dialog}:{})}]);
  }

  detachWebContents(webContents: WebContents | PtyEventSink): void {
    this.sinks.delete(webContents);
  }

  private endedBootPanes=new Map<string,number>();
  private observedExits=new Map<string,{generation:number;event:number;acknowledged?:boolean}>();
  private exitAcks=new Map<string,Promise<void>>();
  private exitReplayFlights=new Map<string,number>();
  private exitAckRetries=new Map<string,number>();
  private exitAckTimers=new Map<string,ReturnType<typeof setTimeout>>();
  private observeExit(id:string,receipt:{generation:number;event:number;acknowledged?:boolean}):void {
    if(this.observedExits.get(id)!==receipt||receipt.acknowledged||(this.exitAckRetries.get(id)??0)>=3||this.disposed||this.exitAcks.has(id)||!this.socket||this.socket.destroyed)return;
    const socket=this.socket,tries=(this.exitAckRetries.get(id)??0)+1;this.exitAckRetries.set(id,tries);
    let retry=false;
    const work=this.sendRequest(socket,{id:0,type:"exit-observed",ptyId:id,generation:receipt.generation,event:receipt.event}).then(result=>{
      if(result==="retired"){if(this.observedExits.get(id)===receipt)receipt.acknowledged=true;}
      else if(result==="stale"){
        if(this.observedExits.get(id)===receipt)this.observedExits.delete(id);
        this.recoveryHooks.log?.("pty-exit-ack-stale",{ptyId:id,generation:receipt.generation,exitEvent:receipt.event});
      }else this.recoveryHooks.log?.("pty-exit-ack-unavailable",{ptyId:id,generation:receipt.generation,exitEvent:receipt.event});
    },()=>{retry=true;}).finally(()=>{
      if(this.exitAcks.get(id)===work)this.exitAcks.delete(id);
      const current=this.observedExits.get(id);
      if(current&&current!==receipt)this.observeExit(id,current);
      if(retry&&tries<3&&!this.disposed&&this.socket===socket&&!socket.destroyed&&this.observedExits.get(id)===receipt){
        const timer=setTimeout(()=>{this.exitAckTimers.delete(id);this.observeExit(id,receipt);},100);timer.unref?.();this.exitAckTimers.set(id,timer);
      }
    });
    this.exitAcks.set(id,work);
  }
  async acknowledgeHandoverDisplay(ptyId:string,generation:string,token?:string):Promise<boolean>{
    const request:PtyHostRequest={id:0,type:"handover-display-applied",ptyId,generation,token};
    // Earlier panes can apply replay while later panes are still being fenced.
    // Only ACK may bypass the recovery gate, on the validated successor socket.
    const socket=this.socket;
    const applied=await (this.crashTask&&socket&&!socket.destroyed&&!this.disposed&&this.metadataSocket===socket?this.sendRequest(socket,request):this.request(request))===true;
    if(applied)this.uncertainInput.delete(ptyId);return applied;
  }

  async spawn(req: SpawnRequest): Promise<void> {
    if(this.crashBlocked){
      if(this.ownerContinuityUnavailable)this.authRefusedPanes.set(req.ptyId,this.recoveryReason??"The terminal host recovery data is unavailable; input remains disabled.");
      this.sendToSinks([{type:"disconnected",ptyId:req.ptyId,reason:this.recoveryReason??"The terminal host is recovering. The process was kept; input is disabled.",recoveryBlocked:this.ownsOwnerKey&&!!this.crashSupervisor,retryable:this.recoveryRetryable}]);
      throw Error("The terminal host is disconnected or recovering. This request was not sent.");
    }
    if(!req.attachIfReused&&!req.attachOnly){this.recoveredStates.delete(req.ptyId);this.endedBootPanes.delete(req.ptyId);this.observedExits.delete(req.ptyId);this.uncertainInput.delete(req.ptyId);}
    if(this.endedBootPanes.has(req.ptyId)&&(req.attachIfReused||req.attachOnly)&&!req.replayAfter){
      const exitCode=this.endedBootPanes.get(req.ptyId)!;
      this.authRefusedPanes.delete(req.ptyId);this.principalBusyPanes.delete(req.ptyId);
      const receipt=this.observedExits.get(req.ptyId);if(receipt){this.observeExit(req.ptyId,receipt);await this.exitAcks.get(req.ptyId);}
      const recovery=this.recoveredStates.get(req.ptyId);if(recovery)this.sendToSinks([{...recovery}]);
      this.sendToSinks([{type:"exit",ptyId:req.ptyId,exitCode}]);return;
    }
    this.metadataRequired = true;
    // Resolve attachIfReused in request()'s post-connect hook - only this
    // client knows whether the host was reused or freshly spawned, and that
    // is settled once connect() resolves. The host itself only understands
    // attachOnly; the intent flag never crosses the socket.
    //
    // ORDERING: the resolution must NOT add its own `await this.connect()`
    // before request(). Every request chain has exactly ONE connect await;
    // adding a second one to spawn re-queues its socket write one microtask
    // BEHIND any write/resize that was queued while the cold-start connect
    // was in flight - so the renderer's first typed bytes hit the host
    // before the spawn line, found no PTY, and were silently dropped (typed
    // input during app boot vanished; caught by e2e as dead terminals).
    const { attachIfReused, ...rest } = req;
    // Before the request: a no-session or exit event for it arrives ahead of the reply.
    this.live.add(req.ptyId);
    const replayExit=!!(req.attachOnly||req.attachIfReused||req.replayAfter);
    if(replayExit)this.exitReplayFlights.set(req.ptyId,(this.exitReplayFlights.get(req.ptyId)??0)+1);
    try {
      await this.request({ id: 0, type: "spawn", req: rest }, (request) => {
        const restored=this.recoveredStates.get(req.ptyId);if(restored)this.sendToSinks([{...restored}]);
        const consented=this.consentedBootSpawns.delete(req.ptyId);
        if (!resolveSpawnAttach(rest.attachOnly, consented ? false : attachIfReused, this.reusedHost)) {
          return request;
        }
        return { ...request, req: { ...rest, attachOnly: true } };
      });
      if(this.ownerContinuityUnavailable&&!this.crashBlocked&&this.live.has(req.ptyId))this.sendToSinks([{type:"recovery-unavailable",ptyId:req.ptyId,reason:this.continuityNotice}]);
      // Replay may deliver an ended native record before its spawn reply. Do
      // not report attachment complete while its observed exit ACK is in flight.
      await this.exitAcks.get(req.ptyId);
      this.authRefusedPanes.delete(req.ptyId);this.principalBusyPanes.delete(req.ptyId);
    } catch (err) {
      this.live.delete(req.ptyId);
      const code=(err as {code?:string})?.code;
      if(["PTY_HOST_PRINCIPAL_BUSY","PTY_HOST_AUTH_REQUIRED","PTY_HOST_AUTH_UNAVAILABLE","PTY_HOST_START_BLOCKED","PTY_HOST_OWNER_UNAVAILABLE"].includes(code??"")){
        const reason=code==="PTY_HOST_PRINCIPAL_BUSY"?HOST_PRINCIPAL_BUSY_REASON:code==="PTY_HOST_OWNER_UNAVAILABLE"?this.recoveryReason??"The terminal host recovery data is unavailable; input remains disabled.":code==="PTY_HOST_START_BLOCKED"?"The terminal host inventory could not be verified. Its processes may still be running; input remains disabled. Use Settings > Diagnostics > PTY host > Restart to review them.":this.unannouncedRefusal?HOST_UNANNOUNCED_REASON:HOST_AUTH_REFUSAL_REASON;
        this.authRefusedPanes.set(req.ptyId,reason);this.sendToSinks([code==="PTY_HOST_PRINCIPAL_BUSY"?{type:"host-connection",ptyId:req.ptyId,connected:false,reason}:{type:"disconnected",ptyId:req.ptyId,reason}]);
        throw Object.assign(new Error("The terminal host is disconnected or recovering. This request was not sent."),{code});
      }
      throw err;
    }finally{if(replayExit){const left=(this.exitReplayFlights.get(req.ptyId)??1)-1;if(left)this.exitReplayFlights.set(req.ptyId,left);else this.exitReplayFlights.delete(req.ptyId);}}
  }

  /** Whether spawning `req` now would start a process, not replay or attach to one. */
  async willStart(req: SpawnRequest): Promise<boolean> {
    if(this.endedBootPanes.has(req.ptyId))return false;
    if (req.attachOnly || (await this.getSize(req.ptyId)) !== null) return false;
    return !resolveSpawnAttach(false, this.consentedBootSpawns.has(req.ptyId) ? false : req.attachIfReused, this.reusedHost);
  }

  /** Resolves false only when the host positively reports the data went
   *  nowhere. A host from an older build answers null, which reads as
   *  delivered - an unknown answer must not be turned into a failure. */
  async write(ptyId: string, data: string, stillAllowed?:()=>boolean): Promise<boolean> {
    const result = await this.request({ id: 0, type: "write", ptyId, data },stillAllowed?request=>{
      if(!stillAllowed())throw Object.assign(new Error("User screen rules changed while the terminal connection was opening. This input was not sent."),{code:"PTY_HOST_RULES_UNAVAILABLE"});
      return request;
    }:undefined);
    return result !== false;
  }

  async resize(ptyId: string, cols: number, rows: number): Promise<void> {
    await this.request({ id: 0, type: "resize", ptyId, cols, rows });
  }

  async kill(ptyId: string): Promise<void> {
    for(const pending of this.principalAttaches.get(ptyId)??[])pending.abort();
    this.endedBootPanes.delete(ptyId);
    this.observedExits.delete(ptyId);
    await this.request({ id: 0, type: "kill", ptyId });
    this.authRefusedPanes.delete(ptyId);this.principalBusyPanes.delete(ptyId);
    this.live.delete(ptyId);this.recoveredStates.delete(ptyId);
    this.sessionWatches.get(ptyId)?.();
    this.sessionWatches.delete(ptyId);
    this.screenStates.delete(ptyId);
  }

  /** Whether this client holds a connection to a host now (a question that never starts one). */
  isConnected(): boolean {
    return !!this.socket && !this.socket.destroyed;
  }

  /** Quit path: every later request rejects instead of starting a host, which
   *  would have no app to serve and never exit. Requests already sent still land. */
  dispose(): void {
    this.disposed = true;
    this.principalRetryCancel?.abort();
    this.startupCancelled.abort();
    this.crashSupervisor?.dispose();
    for(const timer of this.exitAckTimers.values())clearTimeout(timer);this.exitAckTimers.clear();
    for(const timer of this.ruleStatusTimers.values())clearTimeout(timer);this.ruleStatusTimers.clear();this.ruleStatusPending.clear();
    this.stopSessionWatches();
  }

  async shutdown(): Promise<void> {
    if(this.disposed)throw new Error(DISPOSED_MESSAGE);
    this.hostAsked = true;
    // Issue the authorized shutdown before the first await. dispose() may run
    // immediately afterwards; it must not suppress this already-issued request.
    this.issuedShutdown=true;
    try{await this.request({ id: 0, type: "shutdown" });}
    finally{this.issuedShutdown=false;}
    const pid = this.lastHostPid;
    this.dropSocket();
    if (pid && !(await waitForExit(pid, PTY_HOST_EXIT_WAIT_MS))) throw new Error("The terminal host did not finish shutting down");
  }

  /** Running host's identity + live PTY count + its pid (hosts from the
   *  registry era report it; older hosts don't -> undefined). identity is null
   *  if the handshake fails (an old host that predates the `version` request
   *  errors out - itself a stale signal); ptyCount is 0 when unknown. */
  async hostStatus(legacyPaneIds?:string[]): Promise<{
    identity: HostIdentity | null;
    ptyCount: number;
    pid?: number;
    owner?: PtyOwnerStatus;
    recoveryReason?:string;
    authentication?:HostAuthenticationProblem;
    principalBusy?:boolean;
    ownerUnavailable?:boolean;
    continuityUnavailable?:boolean;
    ownerStopped?:boolean;
    startTime?:string|null;
  }> {
    if(legacyPaneIds)this.legacyPaneIds=legacyPaneIds.slice(0,25);
    try {
      const result = await this.request({ id: 0, type: "version" });
      const obj =
        result && typeof result === "object" ? (result as Record<string, unknown>) : {};
      return {
        identity: asHostIdentity(result),
        ...(this.ownerContinuityUnavailable?{continuityUnavailable:true,recoveryReason:this.continuityNotice}:{}),
        ptyCount: typeof obj.ptyCount === "number" ? obj.ptyCount : 0,
        pid: typeof obj.pid === "number" ? obj.pid : undefined,
        startTime:typeof obj.pid === "number"&&obj.pid===this.lastHostPid?this.lastHostStart:null,
        ...(obj.owner && typeof obj.owner === "object" ? { owner: obj.owner as PtyOwnerStatus } : {}),
      };
    } catch(error) {
      if((error as {code?:string})?.code==="PTY_HOST_PRINCIPAL_BUSY"){
        const {authentication:_authentication,...status}=refusedHostStatus(this.principalBusyPeer??null);
        return {...status,principalBusy:true,recoveryReason:HOST_PRINCIPAL_BUSY_REASON};
      }
      if(!this.ownerContinuityUnavailable&&(this.authRefusalPeer!==undefined||(error as {code?:string})?.code==="PTY_HOST_START_BLOCKED")){
        const peer=this.authRefusalPeer??null,status=refusedHostStatus(peer);
        if(peer&&status.authentication.targetVerified&&!status.owner){
          const legacy=await probeLegacyInventory(peer,this.legacyPaneIds);
          if(legacy){status.authentication.legacy=legacy;status.ptyCount=legacy.total;this.unannouncedRefusal=false;}
        }
        if(this.unannouncedRefusal)status.authentication={...status.authentication,unannounced:true,reason:HOST_UNANNOUNCED_REASON};
        return status;
      }
      // A blocked transport must not erase B2's explicit dead-owner recovery
      // inventory. Read only the bounded private record for this main's known
      // owner; no process/socket probes or new host are needed to name its PIDs.
      let owner:PtyOwnerStatus|undefined;
      if(this.crashBlocked&&(this.ownsOwnerKey||this.ownerContinuityUnavailable)&&(this.recoveryOwner||this.crashContext?.owner)){
        try{
          const record=readOwnerRecord(),expected=this.recoveryOwner??this.crashContext!.owner;
          if(record&&record.pid===expected.pid&&record.startTime===expected.startTime&&record.instanceId===expected.instanceId&&record.binaryHash===expected.binaryHash){
            const uncertain=[...new Set([...(record.uncertain??[]),...(record.spawnIntents??[]).map(p=>p.id)])];
            owner={pid:record.pid,startTime:record.startTime,startIdentity:record.startIdentity,instanceId:record.instanceId,hash:record.binaryHash,incompatible:true,
              disconnected:[...new Set([...record.panes.map(p=>p.id),...uncertain])],
              inventory:record.panes.map(p=>({id:p.id,pid:p.pid,startIdentity:p.startIdentity})),uncertain,recoveryFailures:record.recoveryFailures};
          }
        }catch{/* Unreadable/changed records stay unknown and are never signalled here. */}
      }
      return { identity: null, ptyCount: owner?.inventory?.length??0,...(owner?{owner}:{}),...(this.recoveryReason?{recoveryReason:this.recoveryReason}:{}),...(this.ownerContinuityUnavailable?{ownerUnavailable:true}:{}),...(this.ownerRetired&&owner?{ownerStopped:true}:{}) };
    }
  }

  /** Identity the freshly-spawned host WOULD report: app version + a hash of
   *  the host script this client launches. Compared against the running host's
   *  reported identity to detect a stale host (#28). */
  expectedHostIdentity(appVersion: string): HostIdentity {
    let scriptHash = UNKNOWN_SCRIPT_HASH;
    try {
      scriptHash = hostBuildHash(path.dirname(this.hostScript), path.basename(this.hostScript));
    } catch {
      // Unreadable expected content is indeterminate; it never permits stopping the host.
    }
    return { version: appVersion, scriptHash, runtime: hostRuntimeIdentity() };
  }

  authorizePlannedFallback(ids:readonly string[]):void {
    this.plannedReusedBoot=true;
    for(const id of ids)this.consentedBootSpawns.add(id);
  }
  announceOrdinaryQuit():Promise<boolean>{
    if(!this.ordinaryAnnouncement){
      const socket=this.socket;
      this.ordinaryAnnouncement=new OrdinaryAuthAnnouncement({home:AYA_HOME,
        connected:()=>!!socket&&socket===this.socket&&!socket.destroyed&&!this.disposed&&!this.replacing&&!this.receivedAuthTransfer&&!!this.hostAuthKey&&!this.crashBlocked,
        peer:()=>{if(!socket)throw new HostAuthError();return handoverPeer(socket);},
        control:request=>{if(!socket||socket!==this.socket||socket.destroyed||this.disposed)throw new HostAuthError();return this.sendRequest(socket,request);},
        log:(event,fields)=>this.recoveryHooks.log?.(event,fields),
      });
    }
    return this.ordinaryAnnouncement.prepare();
  }
  cancelOrdinaryQuit():Promise<void>{return this.ordinaryAnnouncement?.abort()??Promise.resolve();}
  /** Explicit startup-only nonce redemption. This never starts, unlinks,
   * probes or signals a host/owner, and does not wait for the old principal. */
  async redeemAnnouncedCapability(ticket:AuthTransferTicket):Promise<void>{
    if(this.disposed||this.isConnected()||this.hostAuthKey||this.receivedAuthTransfer)throw new HostAuthError();
    const socket=net.createConnection(PTY_HOST_SOCKET_PATH);
    socket.on("error",()=>{});
    const cancel=()=>socket.destroy();
    this.startupCancelled.signal.addEventListener("abort",cancel,{once:true});
    let key:Buffer|undefined;
    try{
      const connected=new Promise<void>((resolve,reject)=>{socket.once("connect",resolve);socket.once("error",reject);socket.once("close",()=>reject(new HostAuthError()));});
      await withTimeout(connected,5000);
      if(this.disposed||this.startupCancelled.signal.aborted)throw new Error(DISPOSED_MESSAGE);
      const startIdentity=ownerProcessStartIdentity(process.pid);
      if(!startIdentity)throw new HostAuthError();
      key=await redeemHostCapability(socket,ticket,{pid:process.pid,startIdentity});
      if(this.disposed||this.startupCancelled.signal.aborted)throw new Error(DISPOSED_MESSAGE);
      this.hostAuthKey=Buffer.from(key);
      this.receivedAuthTransfer={ticket:{...ticket}};
    }finally{key?.fill(0);socket.destroy();this.startupCancelled.signal.removeEventListener("abort",cancel);}
  }
  private async completeAnnouncedContinuity(socket:net.Socket,version:unknown):Promise<void>{
    const transfer=this.receivedAuthTransfer;
    if(!transfer)return;
    if(!transfer.receipt){
      const offered=(version as {owner?:PtyOwnerStatus}|null)?.owner;
      if(offered&&Number.isSafeInteger(offered.pid)&&offered.pid>1&&typeof offered.startTime==="string"&&offered.startTime.length<=128&&typeof offered.instanceId==="string"&&/^[a-f0-9]{32}$/.test(offered.instanceId)&&typeof offered.hash==="string"&&/^[a-f0-9]{64}$/.test(offered.hash))transfer.retirementOwner={pid:offered.pid,startTime:offered.startTime,instanceId:offered.instanceId,binaryHash:offered.hash};
      const response=await withTimeout(this.sendRequest(socket,{id:0,type:"owner-continuity",transferAttempt:transfer.ticket.attempt}),PTY_HOST_RESTART_REQUEST_TIMEOUT_MS);
      const continuity=validateTransferredOwnerContinuity(response,handoverPeer(socket),version);
      try{
        if(this.disposed||this.socket!==socket||socket.destroyed||this.receivedAuthTransfer!==transfer)throw new Error(PTY_HOST_NOT_CONNECTED);
        if(continuity.bootstrap){
          for(const pane of continuity.bootstrap.panes){
            this.recoveryLaunches.set(pane.id,{request:pane.request,launch:pane.launch,spawnedAt:pane.spawnedAt,pid:pane.pid});
            if(!this.endedBootPanes.has(pane.id))this.live.add(pane.id);
          }
          this.recoveryOwner={...continuity.bootstrap.owner};
        }else this.recoveryOwner=null;
        this.ownerSecret.set(continuity.credential);this.ownsOwnerKey=true;this.ownerContinuityUnavailable=false;
        transfer.receipt=continuity.receipt;
      }finally{continuity.credential.fill(0);}
    }
    const completed=await withTimeout(this.sendRequest(socket,{id:0,type:"auth-transfer-complete",attempt:transfer.ticket.attempt,receipt:transfer.receipt}),PTY_HOST_RESTART_REQUEST_TIMEOUT_MS);
    if(completed!==true||this.disposed||this.socket!==socket||socket.destroyed||this.receivedAuthTransfer!==transfer)throw new HostAuthError();
    this.receivedAuthTransfer=null;
  }
  private refuseMissingAnnouncedHost():Error{
    const transfer=this.receivedAuthTransfer;
    if(transfer?.retirementOwner){
      const reader=readProcInfo(transfer.ticket.hostPid,200);
      if(!reader.alive&&!reader.probeFailed){
        this.recoveryOwner={...transfer.retirementOwner};this.ownerContinuityUnavailable=true;
        return this.blockUnavailableOwner();
      }
    }
    return new HostAuthError();
  }
  private retireReceivedTransfer(expected:typeof this.receivedAuthTransfer,peer?:HostAuthPeer,owner?:RecoveryOwnerIdentity):void{
    if(!expected||this.receivedAuthTransfer!==expected)return;
    const known=expected.retirementOwner;
    if((peer&&expected.ticket.hostPid===peer.pid&&expected.ticket.hostStartIdentity===peer.startIdentity)||(owner&&known&&known.pid===owner.pid&&known.startTime===owner.startTime&&known.instanceId===owner.instanceId&&known.binaryHash===owner.binaryHash))this.receivedAuthTransfer=null;
  }
  async reservePlannedHandover(deadline:number):Promise<AuthTransferTicket & {deadline:number}>{
    const nonce=randomBytes(32).toString("hex");
    if(!this.isConnected())await this.openSocket();
    const socket=this.socket;if(!socket||this.disposed)throw new HostAuthError();
    const peer=handoverPeer(socket);
    const result=await this.sendRequest(socket,{id:0,type:"auth-transfer-reserve",purpose:"planned-update",nonce,deadline}) as Record<string,unknown>;
    if(socket!==this.socket||socket.destroyed)throw new HostAuthError();
    if(this.disposed||!result||Object.keys(result).sort().join(",")!=="attempt,deadline,hostPid,hostStartIdentity,purpose"||typeof result.attempt!=="string"||!/^[a-f0-9]{64}$/.test(result.attempt)||result.purpose!=="planned-update"||result.deadline!==deadline||result.hostPid!==peer.pid||result.hostStartIdentity!==peer.startIdentity)throw new HostAuthError();
    return {format:2,attempt:result.attempt,purpose:"planned-update",deadline,nonce,hostPid:peer.pid,hostStartIdentity:peer.startIdentity};
  }
  async activatePlannedHandover(attempt:string):Promise<void>{
    if(!this.socket||this.socket.destroyed||this.disposed)throw new HostAuthError();
    if(await this.sendRequest(this.socket,{id:0,type:"auth-transfer-activate",attempt})!==true)throw new HostAuthError();
  }
  async cancelPlannedAuth(attempt:string):Promise<"cancelled"|"committed">{
    if(!this.socket||this.socket.destroyed||this.disposed)throw new HostAuthError();
    const result=await withTimeout(this.sendRequest(this.socket,{id:0,type:"auth-transfer-cancel",attempt}),2000);
    if(result!=="cancelled"&&result!=="committed")throw new HostAuthError();return result;
  }
  async preparePlannedHandover(deadline:number,transferAttempt?:string):Promise<HostHandoverState> {
    return handoverState(await this.existingPlannedRequest({id:0,type:"handover-prepare",deadline,...(transferAttempt?{transferAttempt}:{})},5000),deadline);
  }
  async announcePlannedHandover(state:HostHandoverState,display:CheckpointReceipt|null,consented:string[],nonce:string,transferAttempt?:string):Promise<HandoverTicket> {
    await this.existingPlannedRequest({id:0,type:"handover-publish",display,consented,...(transferAttempt?{transferAttempt}:{})},10000);
    const result=await this.existingPlannedRequest({id:0,type:"handover-announce",nonce,deadline:state.deadline,...(transferAttempt?{transferAttempt}:{})},2000) as Pick<HandoverTicket,"hostPid"|"hostStartIdentity">;
    return {...result,nonce,deadline:state.deadline};
  }
  async cancelPlannedHandover(transferAttempt?:string):Promise<void> {
    await this.existingPlannedRequest({id:0,type:"handover-cancel",...(transferAttempt?{transferAttempt}:{})},3000);
  }
  private async existingPlannedRequest(request:PtyHostRequest,timeout:number):Promise<unknown>{
    if(!this.isConnected())await this.openSocket();
    const socket=this.socket;if(!socket||socket.destroyed||this.disposed)throw new HostAuthError();
    // Issuer cleanup/preparation must never borrow ordinary cold-start or
    // crash recovery authority when the old socket disappears.
    return withTimeout(this.sendRequest(socket,request),timeout);
  }
  /** New main alone owns this operation. Other requests wait until either the
   * old host is usable again or its successor has restored every eligible pane. */
  adoptPlannedHandover(ticket:HandoverTicket,expected:HostIdentity,inspect:(state:HostHandoverState)=>Promise<void>):Promise<HostHandoverState> {
    if(this.replacing)return Promise.reject(new Error("A terminal replacement is already in progress"));
    const run=this.completePlannedHandover(ticket,expected,inspect).finally(()=>{if(this.replacing===barrier)this.replacing=null;});
    const barrier=run.then(()=>true,()=>false);this.replacing=barrier;
    return run;
  }
  private async completePlannedHandover(ticket:HandoverTicket,expected:HostIdentity,inspect:(state:HostHandoverState)=>Promise<void>):Promise<HostHandoverState> {
    let detached=false;
    const transfer=this.receivedAuthTransfer;
    const call=(request:PtyHostRequest)=>withTimeout(this.request(request,undefined,true),10000);
    try{
      if(Date.now()>=ticket.deadline||ownerProcessStartIdentity(ticket.hostPid)!==ticket.hostStartIdentity)throw new Error("The announced terminal host is unavailable");
      this.plannedReusedBoot=true;
      // Never let a missing announced socket start a fresh host implicitly.
      if(!this.isConnected())await this.openSocket();
      const status=await call({id:0,type:"version"}) as HostIdentity&{pid:number;owner?:PtyOwnerStatus};
      if(status.pid!==ticket.hostPid)throw new Error("The announced terminal host identity changed");
      const comparison=classifyIdentity(expected,status),reuse=comparison!=='stale';
      // Claim the announced recipient before a refusal, so a new main can
      // cancel/resume the old host using its recorded kernel identity too.
      const claim=await call({id:0,type:"handover-claim",nonce:ticket.nonce,reuse,...(transfer?{transferAttempt:transfer.ticket.attempt}:{})}) as {credential?:string;checkpoint:unknown};
      if(comparison==='indeterminate')throw new Error("The updated terminal host identity could not be read; its processes were kept");
      if(!status.owner||status.owner.incompatible||status.owner.disconnected.length||status.owner.hash!==ownerBinaryHash(ownerArtifactPaths().executable))throw new Error("The native PTY owner cannot move these processes seamlessly");
      const planned=transfer?validatePlannedContinuity(claim,transfer.ticket.attempt,handoverPeer(this.socket!),status,ticket.deadline):null;
      const state=planned?.state??handoverState(claim.checkpoint,ticket.deadline);
      if(planned&&transfer)transfer.retirementOwner={...planned.owner};
      if(state.consented.length!==state.ineligible.length)throw new Error("The terminal handover lacks process-stop consent");
      const sizes=await preflightCoreHandover(state.core,state.eligible);
      if(sizes.rawBytes!==state.coreRawBytes||sizes.encodedBytes!==state.coreEncodedBytes)throw new Error("Terminal core receipt accounting differs");
      const recoveredLaunches=new Map<string,{request:SpawnRequest;launch:PaneLaunch;spawnedAt:number;pid:number}>();
      if(planned)for await(const pane of readCoreHandover(state.core)){
        if("kind" in pane)continue;
        recoveredLaunches.set(pane.id,{request:pane.request,launch:pane.launch,spawnedAt:pane.spawnedAt,pid:pane.adapter.pane.pid});
      }
      await inspect(state); // Browser validation/caching also precedes commit.
      if(planned&&transfer){
        if(typeof claim.credential!=="string"||!/^[A-Za-z0-9+/]{43}=$/.test(claim.credential))throw new Error("Invalid planned owner credential");
        const key=Buffer.from(claim.credential,"base64");
        try{
          if(key.length!==32||key.toString("base64")!==claim.credential||this.receivedAuthTransfer!==transfer)throw new Error("Invalid planned owner credential");
          // Validation above includes ended checkpoint records. This ACK owns
          // credentials only: it does not detach, resume or ACK pane displays.
          // Install only fully validated authority BEFORE recording its receipt.
          // A committed ACK may be lost; the exact receipt retry must not skip
          // the key/launch installation or fall back to a live-only manifest.
          this.ownerSecret.set(key);this.ownsOwnerKey=true;this.recoveryOwner={...planned.owner};this.ownerContinuityUnavailable=false;
          for(const [id,launch]of recoveredLaunches){this.recoveryLaunches.set(id,launch);if(!this.endedBootPanes.has(id))this.live.add(id);}
          transfer.retirementOwner={...planned.owner};transfer.receipt=planned.receipt;
          if(await call({id:0,type:"auth-transfer-complete",attempt:transfer.ticket.attempt,receipt:planned.receipt})!==true||this.disposed||this.receivedAuthTransfer!==transfer)throw new HostAuthError();
          this.receivedAuthTransfer=null;
        }finally{key.fill(0);}
      }
      if(ticket.deadline-Date.now()<5000)throw new Error("The terminal handover window is too short to commit safely");
      let committed:unknown;
      if(reuse){
        committed=await call({id:0,type:"handover-reuse"});
        await call({id:0,type:"handover-ack-reuse"});this.reusedHost=true;
      }else{
        if(typeof claim.credential!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(claim.credential))throw new Error("Invalid terminal handover credential");
        const key=Buffer.from(claim.credential,'base64');
        if(key.length!==32||key.toString('base64')!==claim.credential)throw new Error("Invalid terminal handover credential");
        try{
          this.hostAsked=true;
          let commitError:unknown;
          try{committed=await call({id:0,type:"handover-detach",consented:state.consented});}catch(error){commitError=error;}
          // No successor while the recorded old process instance still lives.
          if(!await waitForExit(ticket.hostPid,8000)){if(commitError)throw commitError;throw new Error("The old terminal host has not exited; no successor was started");}
          detached=true;this.retireReceivedTransfer(transfer,{pid:ticket.hostPid,startIdentity:ticket.hostStartIdentity});this.dropSocket();key.copy(this.ownerSecret);
          const child=this.startHost({format:1,core:state.core});
          try{await this.openStartedHostSocket();}catch(error){
            // A socketless partial successor must not keep a lease or compete
            // with a later host. This is our unreaped JS child, never the owner.
            if(child.exitCode===null&&child.signalCode===null){
              const exited=new Promise<void>(resolve=>child.once("exit",()=>resolve()));
              child.kill("SIGKILL");await withTimeout(exited,3000);
            }
            throw error;
          }
          this.reusedHost=true;
        }finally{key.fill(0);}
      }
      // Only the commit result proves a process was stopped. A published
      // consent list is not evidence that an intervening natural exit needs
      // a replacement. Lost commit responses conservatively grant no spawn.
      if(committed!==undefined){
        const result=handoverCommitResult(committed,state.consented);
        for(const id of result.stopped)this.consentedBootSpawns.add(id);
        if(!reuse)for(const pane of result.ended){
          this.endedBootPanes.set(pane.id,pane.exitCode);
          if(pane.ownerExit){this.observedExits.set(pane.id,pane.ownerExit);this.observeExit(pane.id,pane.ownerExit);}
        }
      }
      return state;
    }catch(error){
      if(!detached)await this.cancelPlannedHandover().catch(()=>{});
      throw error;
    }
  }

  /** The one way Aya replaces its host (Restart Aya, Diagnostics, a stale host at launch): ask it to shut down,
   *  drop the socket, and wait until that process has exited before any request may start the next host. The old
   *  host exits only after its panes are gone; a new host started earlier lost its socket to the old host's exit
   *  handler on 2026-10-13. Resolves true when the old host exited (or none answered), false when it still runs
   *  after PTY_HOST_EXIT_WAIT_MS. Best-effort: a dead or old host that cannot shut down cleanly is still dropped. */
  restart(consent?:HostRestartConsent): Promise<boolean> {
    if (this.replacing) return this.replacing;
    if(this.ownerContinuityUnavailable&&!consent)return Promise.reject(this.blockUnavailableOwner());
    const asked=this.hostAsked,blocked=this.crashBlocked,supervisor=this.crashSupervisor,closeEpoch=this.closeEpoch,wasRecovering=!!this.crashTask;
    if(!consent)this.hostAsked=true;
    let resumeRecovery=false;
    const run = (async()=>{
      supervisor?.suspend();let completed=false;
      try{
        if(this.crashAttempt){try{await withTimeout(this.crashAttempt,4000);}catch{return false;}}
        if(this.crashTask){try{await withTimeout(this.crashTask,4000);}catch{return false;}}
        this.crashBlocked=false;
        const result=await this.replaceHost(consent);
        if(result){
          completed=true;this.crashBlocked=false;this.ownerContinuityUnavailable=false;this.ownerRetired=false;this.authRefusedPanes.clear();this.principalBusyPanes.clear();this.recoveryReason=undefined;supervisor?.dispose();
          if(supervisor&&!this.disposed){this.crashSupervisor=null;this.enableCrashRecovery(this.recoveryHooks);}
        }
        return result;
      }finally{
        if(!completed&&!this.disposed){
          this.hostAsked=asked;
          this.crashBlocked=this.closeEpoch===closeEpoch?blocked:this.crashBlocked||this.lostOwned.size>0;
          supervisor?.resume();
          resumeRecovery=!this.socket&&this.lostOwned.size>0&&!!this.crashContext&&(wasRecovering||this.closeEpoch!==closeEpoch);
        }
      }
    })().finally(() => {
      if (this.replacing === run) this.replacing = null;
      if(resumeRecovery){
        void Promise.allSettled([this.crashTask,this.crashAttempt]).then(()=>{
          if(!this.disposed&&!this.replacing&&this.crashSupervisor===supervisor)this.beginCrashRecovery();
        });
      }
    });
    this.replacing = run;
    return run;
  }

  private async confirmedRestartSocket(consent:HostRestartConsent):Promise<{socket:net.Socket;target:HostRestartTarget}> {
    let approved=consent.target;
    for(let check=0;check<4;check++){
      if(this.disposed)throw Error(DISPOSED_MESSAGE);
      const result=await withTimeout(this.request({id:0,type:"version"},undefined,true),PTY_HOST_RESTART_REQUEST_TIMEOUT_MS) as {pid?:number;ptyCount?:number;owner?:PtyOwnerStatus};
      const socket=this.socket,pid=typeof result?.pid==="number"&&Number.isSafeInteger(result.pid)&&result.pid>1?result.pid:null;
      let startTime:string|null=null;try{if(pid)startTime=ownerProcessStartIdentity(pid);}catch{/* unknown identity cannot authorize shutdown */}
      const target:HostRestartTarget={pid,startTime,identity:asHostIdentity(result),ptyCount:typeof result?.ptyCount==="number"?result.ptyCount:0,...(result?.owner?{owner:result.owner}:{})};
      if(!pid||!startTime||(target.owner&&!/^[a-f0-9]{32}$/.test(target.owner.instanceId??""))){
        await consent.confirmChanged(target);throw Error("The current terminal host identity could not be verified. Nothing was stopped.");
      }
      if(!sameRestartTarget(approved,target)){
        if(!await consent.confirmChanged(target))throw Error("restart cancelled");
        approved=target;continue; // re-read after the asynchronous question
      }
      if(socket&&socket===this.socket&&!socket.destroyed&&ownerProcessStartIdentity(pid)===startTime)return{socket,target};
    }
    throw Error("The terminal host kept changing. Nothing was stopped; review its current inventory and try again.");
  }

  private async replaceHost(consent?:HostRestartConsent): Promise<boolean> {
    const transfer=this.receivedAuthTransfer;
    let oldStart:string|null=null;
    let oldPid: number | undefined;
    let bound:{socket:net.Socket;target:HostRestartTarget}|undefined;
    if(consent){
      try{bound=await this.confirmedRestartSocket(consent);oldPid=bound.target.pid!;}
      catch(error){
        if((error as {code?:string})?.code==="PTY_HOST_OWNER_UNAVAILABLE"&&this.ownerContinuityUnavailable){
          return retireUnavailableOwner(consent,ownerRetirementDeps({cancelled:()=>this.disposed,log:(event,fields)=>this.recoveryHooks.log?.(event,fields),
            ownerGone:()=>{
              this.ownerRetired=true;this.blockUnavailableOwner();
              for(const ptyId of new Set([...this.authRefusedPanes.keys(),...this.live,...this.lostOwned]))this.authRefusedPanes.set(ptyId,this.recoveryReason!);
              try{this.sendToSinks([...this.authRefusedPanes].map(([ptyId,reason])=>({type:"disconnected",ptyId,reason})));}catch{/* The owner is already gone; a closing view cannot roll it back. */}
            },
            complete:(ids,record)=>{
              this.retireReceivedTransfer(transfer,undefined,{pid:record.pid,startTime:record.startTime,instanceId:record.instanceId,binaryHash:record.binaryHash});
              this.hostAsked=true;this.dropSocket();this.authRefusalPeer=undefined;this.hostAuthKey=null;this.recoveryOwner=null;this.crashContext=null;this.ownsOwnerKey=false;
              this.recoveryLaunches.clear();this.lostOwned.clear();this.live.clear();
              for(const id of ids){this.endedBootPanes.delete(id);this.observedExits.delete(id);this.recoveredStates.delete(id);this.recoveryScreens.delete(id);this.uncertainInput.delete(id);}
              try{this.sendToSinks(ids.map(ptyId=>({type:"no-session",ptyId})));}catch{/* A closing view does not invalidate confirmed process retirement. */}
            },
          }));
        }
        if(!["PTY_HOST_AUTH_REQUIRED","PTY_HOST_AUTH_UNAVAILABLE","PTY_HOST_START_BLOCKED"].includes((error as {code?:string})?.code??""))throw error;
        const deps=refusedRestartDeps(()=>this.disposed,(event,fields)=>this.recoveryHooks.log?.(event,fields),this.legacyPaneIds),waitGone=deps.waitGone;
        deps.waitGone=async(pid,startIdentity)=>{const gone=await waitGone(pid,startIdentity);if(gone)this.retireReceivedTransfer(transfer,{pid,startIdentity});return gone;};
        const exited=await restartRefusedHost(consent,deps);
        if(exited){this.hostAsked=true;this.dropSocket();this.authRefusalPeer=undefined;this.hostAuthKey=null;}
        return exited;
      }
    }
    else try {
      const status = await withTimeout(
        this.request({ id: 0, type: "version" }, undefined, true),
        PTY_HOST_RESTART_REQUEST_TIMEOUT_MS,
      );
      const pid = status && typeof status === "object" ? (status as Record<string, unknown>).pid : undefined;
      if (typeof pid === "number" && Number.isInteger(pid) && pid > 1) oldPid = pid;
    } catch(error) {
      if(this.authRefusalPeer!==undefined||["PTY_HOST_AUTH_REQUIRED","PTY_HOST_AUTH_UNAVAILABLE","PTY_HOST_START_BLOCKED"].includes((error as {code?:string})?.code??""))throw error;
      // Metadata discovery may time out and close our local socket. That is
      // not proof that the authenticated host itself exited.
      if(error instanceof Error&&error.message==="timed out")return false;
      // a host that predates the pid answer, or none: nothing to wait for
    }
    oldStart=bound?.target.startTime??(oldPid===this.lastHostPid?this.lastHostStart:null);
    // The host closes this connection only when its process exits: the exit signal for a host that gave no pid.
    const socket = bound?.socket??this.socket;
    const closed = socket && !socket.destroyed ? new Promise<boolean>((resolve) => socket.once("close", () => resolve(true))) : null;
    try {
      if(bound){
        if(!socket||this.disposed||socket!==this.socket||socket.destroyed||ownerProcessStartIdentity(oldPid!)!==bound.target.startTime)throw Error("The terminal host changed. Nothing was stopped.");
        await withTimeout(this.sendRequest(socket,{id:0,type:"shutdown",target:{pid:oldPid!,startTime:bound.target.startTime!,ownerInstance:bound.target.owner?.instanceId??null}}),PTY_HOST_RESTART_REQUEST_TIMEOUT_MS);
        this.hostAsked=true;
      }else await withTimeout(this.request({ id: 0, type: "shutdown" }, undefined, true), PTY_HOST_RESTART_REQUEST_TIMEOUT_MS);
    } catch(error) {
      if(consent)throw error; // never force-kill an unverified/refused target
      // old host may not honor shutdown; we still drop the socket below
    }
    if (oldPid !== undefined) {
      this.dropSocket();
      if (await waitForExit(oldPid, PTY_HOST_EXIT_WAIT_MS)){if(oldStart)this.retireReceivedTransfer(transfer,{pid:oldPid,startIdentity:oldStart});return true;}
      // Still running: the user already agreed to stop these terminals, and a request let through now would start
      // the next host beside it. The pid is still that host's: a process that never exited cannot have handed it on.
      try {
        if(bound&&ownerProcessStartIdentity(oldPid)!==bound.target.startTime)return false;
        process.kill(oldPid, "SIGKILL");
      } catch {
        // gone in between
      }
      const gone=await waitForExit(oldPid, PTY_HOST_KILL_WAIT_MS);if(gone&&oldStart)this.retireReceivedTransfer(transfer,{pid:oldPid,startIdentity:oldStart});return gone;
    }
    if (!closed) return true;
    const exited = await withTimeout(closed, PTY_HOST_EXIT_WAIT_MS).catch(() => false);
    this.dropSocket();
    return exited;
  }

  /** Close now, not on the socket's later "close": by then a new connection may hold panes and requests. */
  private dropSocket(): void {
    const socket = this.socket;
    if (!socket) return;
    socket.destroy();
    this.onClose();
  }

  async search(query: string): Promise<BufferSearchHit[]> {
    return asSearchResult(await this.request({ id: 0, type: "search", query }));
  }

  async getBuffer(ptyId: string): Promise<string> {
    const result = await this.request({ id: 0, type: "buffer", ptyId });
    return typeof result === "string" ? result : "";
  }

  /** Why a message must not be typed into the pane now, or null. Fails closed:
   *  a host that does not answer (or predates the request) cannot vouch that Enter will not answer a prompt. */
  async holdReason(ptyId: string, pasted?: string): Promise<string | null> {
    try {
      const result = await this.request({ id: 0, type: "snapshot", ptyId });
      if (result === "starting") return HOLD_STARTING;
      if (result === null) return HOLD_NOT_RUNNING;
      const snapshot = asVtSnapshot(result);
      if (!snapshot) return PANE_HOLD_UNKNOWN;
      const verdict = snapshotHold(snapshot, pasted);
      if (verdict.composerSeen && !snapshot.composerSeen) await this.markComposer(ptyId, snapshot);
      return verdict.hold;
    } catch { return PANE_HOLD_UNKNOWN; }
  }

  /** A fresh applied mirror, evaluated by main; unknown still fails open. */
  async paneDisconnected(ptyId: string): Promise<boolean> {
    try { return (await this.request({ id: 0, type: "snapshot", ptyId })) === "disconnected"; }
    catch { return this.lostOwned.has(ptyId); }
  }
  /** Read-only: no composerSeen acknowledgement or separate racing hold/busy reads. */
  async paneState(ptyId: string): Promise<PaneStateResult> {
    if (this.crashBlocked) return unavailablePaneState("the terminal host is disconnected or recovering; its processes may still be running");
    try {
      const value = await this.readExistingSnapshot(ptyId);
      if (value === null) return unavailablePaneState("is not running", "stopped");
      if (value === "starting") return unavailablePaneState("is still starting up", "starting");
      if (value === "disconnected") return unavailablePaneState("the terminal host is disconnected; its processes may still be running");
      const snapshot = asVtSnapshot(value);
      return snapshot ? explainPaneSnapshot(snapshot) : unavailablePaneState(PANE_HOLD_UNKNOWN);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return unavailablePaneState(code === "ENOENT" || code === "ECONNREFUSED" ? "terminal host not running" : PANE_HOLD_UNKNOWN);
    }
  }

  /** User-rule policy observes only an existing connection, without metadata ACKs or startup. */
  async appliedSnapshotForRules(ptyId: string): Promise<VtSnapshot | null> {
    return asVtSnapshot(await this.readExistingSnapshot(ptyId));
  }

  private async readExistingSnapshot(ptyId: string): Promise<unknown> {
    return this.readExistingRequest({ id: 0, type: "snapshot", ptyId });
  }
  private async readExistingRequest(request: PtyHostRequest): Promise<unknown> {
    if (this.disposed) throw new Error(DISPOSED_MESSAGE);
    if (this.socket && !this.socket.destroyed) return withTimeout(this.sendRequest(this.socket, request), 5000);
    // Reuse the normal socket-opening/authentication implementation, but never
    // connectWithHostStart or connect's metadata/continuity/exit-ACK path.
    const observer = new PtyHostClient(this.hostScript);
    observer.observationOnly = true;
    observer.hostAuthKey=this.hostAuthKey?Buffer.from(this.hostAuthKey):null;
    if(this.receivedAuthTransfer)observer.receivedAuthTransfer={ticket:{...this.receivedAuthTransfer.ticket}};
    const deadline = Date.now() + 5000;
    try {
      await withTimeout(observer.openSocket(), Math.max(1, deadline - Date.now()));
      if (this.disposed || Date.now() >= deadline || !observer.socket || observer.socket.destroyed) throw new Error(DISPOSED_MESSAGE);
      return await withTimeout(observer.sendRequest(observer.socket, request), Math.max(1, deadline - Date.now()));
    } finally { observer.dispose(); observer.dropSocket(); }
  }

  async paneBusy(ptyId: string): Promise<boolean> {
    try {
      const snapshot = asVtSnapshot(await this.request({ id: 0, type: "snapshot", ptyId }));
      return snapshot ? snapshotBusy(snapshot) : false;
    } catch { return false; }
  }
  private async markComposer(ptyId: string, snapshot: VtSnapshot): Promise<void> {
    await this.request({ id: 0, type: "composer-seen", ptyId, generation: snapshot.generation });
  }

  /** User-rule decisions never degrade to an unfenced write on an old host. */
  async setUserRulePolicyEpoch(epoch:string):Promise<boolean>{
    if(!/^[a-f0-9]{32}:[0-9]{1,16}$/.test(epoch))return false;
    const socket=this.socket;
    if(this.disposed||this.crashBlocked||!socket||socket.destroyed)return false;
    try{return await this.sendRequest(socket,{id:0,type:"rule-policy-epoch",epoch})===true;}catch{return false;}
  }
  async writeAtSnapshot(ptyId: string, data: string, fence: VtSnapshotFence, policyEpoch:string): Promise<boolean> {
    if (!validVtSnapshotFence(fence)) throw Object.assign(new Error("Terminal screen identity is unavailable. This input was not sent."), {code:"PTY_HOST_STALE_REVISION"});
    if(!/^[a-f0-9]{32}:[0-9]{1,16}$/.test(policyEpoch))throw Object.assign(new Error("Screen rules are unavailable. This input was not sent."),{code:"PTY_HOST_RULES_UNAVAILABLE"});
    const socket = this.socket;
    if (this.disposed || this.crashBlocked || !socket || socket.destroyed) throw new Error("The terminal host is not connected. This input was not sent.");
    // Establish the current policy at the host before dispatch. The epoch is
    // also carried on the write so a later reload can invalidate it in queue.
    if(await this.sendRequest(socket,{id:0,type:"rule-policy-epoch",epoch:policyEpoch}).catch(()=>false)!==true)throw new Error("Screen rules could not be checked. This input was not sent.");
    const result = await this.sendRequest(socket,{id:0,type:"write-fenced",ptyId,data,fence,policyEpoch});
    if (result === true || result === false) return result;
    throw new Error("Terminal input outcome is unknown. Check the pane before retrying; Aya did not resend it.");
  }
  async checkSnapshot(ptyId: string, fence: VtSnapshotFence): Promise<boolean> {
    if (!validVtSnapshotFence(fence)) return false;
    try { return (await this.readExistingRequest({id:0,type:"snapshot-check",ptyId,fence})) === true; }
    catch { return false; }
  }
  async markComposerAtSnapshot(ptyId: string, fence: VtSnapshotFence): Promise<boolean> {
    if (!validVtSnapshotFence(fence)) return false;
    try { return (await this.readExistingRequest({id:0,type:"composer-seen-checked",ptyId,fence})) === true; }
    catch { return false; }
  }
  private acceptSnapshot(ptyId: string, snapshot: VtSnapshot, replay = false, allowComposerAck = true): void {
    if (this.lostOwned.has(ptyId)) return;
    this.latestRuleSnapshots.set(ptyId,snapshot);
    if(this.userRuleStatusObserver){this.evaluateRuleStatus(ptyId,snapshot);return;}
    const verdict = snapshotStatus(snapshot);
    if (allowComposerAck&&verdict.composerSeen && !snapshot.composerSeen) void this.markComposer(ptyId, snapshot).catch(() => {});
    if (verdict.waiting === null) return;
    const old = this.screenStates.get(ptyId);
    if (!replay && old?.generation === snapshot.generation && old.waiting === verdict.waiting && old.dialog === verdict.dialog) return;
    this.screenStates.set(ptyId, { generation: snapshot.generation, waiting: verdict.waiting, dialog: verdict.dialog });
    // A fresh sink already starts without a waiting bell. A live non-waiting
    // snapshot can precede its explicit replay; that must not invent an edge.
    if (!old?.waiting && !verdict.waiting) return;
    this.sendToSinks([{ type: "vt-status", ptyId, waiting: verdict.waiting, ...(verdict.dialog ? { dialog: verdict.dialog } : {}) }]);
  }

  /** How a live pane was launched; null when it is gone or not at the host yet. */
  launch(ptyId: string): Promise<LaunchAnswer> {
    return this.ask<LaunchAnswer>(
      { id: 0, type: "launch", ptyId },
      (r) => {
        const result = r as PaneLaunch | typeof LAUNCH_STARTING | null;
        if (result === LAUNCH_STARTING) return result;
        return typeof result?.command === "string" && typeof result.cwd === "string" ? result : null;
      },
      (err) => (err instanceof Error && err.message === PTY_HOST_UNKNOWN_REQUEST ? LAUNCH_UNSUPPORTED : LAUNCH_UNREACHABLE),
    );
  }

  /** A live pane's size, or null when the pane is gone or the host predates
   *  the request (it answers "unknown request"). */
  getSize(ptyId: string): Promise<PaneSize | null> {
    return this.ask({ id: 0, type: "size", ptyId }, asPaneSize, () => null);
  }

  /** Live cwd of a PTY's child, or null when it can't be determined (an older host answers "unknown request"; the
   *  status bar then keeps the spawn cwd). */
  async getCwd(ptyId: string): Promise<string | null> {
    const pid = await this.getPid(ptyId);
    return typeof pid === "number" ? getProcessCwd(pid) : null;
  }

  /** The pid of the process a pane runs, null when it has none, undefined when the host cannot say. */
  getPid(ptyId: string): Promise<number | null | undefined> {
    return this.ask(
      { id: 0, type: "pid", ptyId },
      (r) => (r === null ? null : typeof r === "number" && r > 0 ? r : undefined),
      () => undefined,
    );
  }

  /** A request whose failure is an answer too: `failed` says what it means. */
  private async ask<T>(request: PtyHostRequest, parse: (result: unknown) => T, failed: (err: unknown) => T): Promise<T> {
    try {
      return parse(await this.request(request));
    } catch (err) {
      return failed(err);
    }
  }

  private async request(
    request: PtyHostRequest,
    // Applied AFTER connect() resolves, right before the socket write - for
    // request fields that depend on connection state (spawn's attachOnly
    // resolution reads reusedHost). Runs synchronously in the same microtask
    // as the write so it cannot perturb request ordering.
    finalize?: (request: PtyHostRequest) => PtyHostRequest,
    // restart()'s own requests to the host it replaces; every other request waits for the replacement.
    duringReplace = false,
  ): Promise<unknown> {
    if (this.disposed) throw new Error(DISPOSED_MESSAGE);
    if(this.principalRetryExhausted&&this.principalBusyPeer!==undefined&&request.type!=="spawn")throw new HostPrincipalBusyError();
    if(this.crashBlocked&&!duringReplace)throw new Error("The terminal host is disconnected or recovering. This request was not sent.");
    if (!duringReplace && this.replacing) await this.replacing;
    if (this.disposed) throw new Error(DISPOSED_MESSAGE);
    let pending:AbortController|undefined;
    const paneId=request.type==="spawn"?request.req.ptyId:undefined;
    if(paneId){pending=new AbortController();this.principalAttaches.set(paneId,(this.principalAttaches.get(paneId)??new Set()).add(pending));}
    try{
      try{if(duringReplace&&this.receivedAuthTransfer){if(!this.isConnected())try{await this.openSocket();}catch(error){if(["ENOENT","ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code??""))throw this.refuseMissingAnnouncedHost();throw error;}}else await this.connect();}catch(error){
        if((error as {code?:string})?.code!=="PTY_HOST_PRINCIPAL_BUSY"||!paneId)throw error;
        if(pending?.signal.aborted)throw new HostPrincipalBusyError();
        this.principalBusyPanes.add(paneId);this.authRefusedPanes.set(paneId,HOST_PRINCIPAL_BUSY_REASON);
        this.sendToSinks([{type:"host-connection",ptyId:paneId,connected:false,reason:HOST_PRINCIPAL_BUSY_REASON}]);
        await this.waitForPrincipal();
      }
      if(this.disposed&&request.type!=="shutdown")throw new Error(DISPOSED_MESSAGE);
      if(pending?.signal.aborted)throw new HostPrincipalBusyError();
      const socket = this.socket;
      if (!socket || socket.destroyed) throw new Error(PTY_HOST_NOT_CONNECTED);
      const ready=finalize?finalize(request):request;
      if(paneId&&this.principalBusyPanes.delete(paneId)){
        this.authRefusedPanes.delete(paneId);
        this.sendToSinks([{type:"host-connection",ptyId:paneId,connected:true,reason:HOST_PRINCIPAL_BUSY_REASON}]);
      }
      return await this.sendRequest(socket,ready);
    }finally{
      if(pending&&paneId){this.principalAttaches.get(paneId)?.delete(pending);if(!this.principalAttaches.get(paneId)?.size)this.principalAttaches.delete(paneId);}
    }
  }

  private sendRequest(socket: net.Socket, request: PtyHostRequest): Promise<unknown> {
    const id = this.nextId++;
    const withId = { ...request, id } as PtyHostRequest;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject,type:request.type,...("ptyId" in request?{ptyId:request.ptyId}:{}) });
      socket.write(`${JSON.stringify(withId)}\n`, (err) => {
        if (!err) return;
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  /** A shared, bounded acquisition wait; it never creates a host. A later
   * explicit attach can open a new budget after this one ends. */
  private waitForPrincipal():Promise<void>{
    if(this.principalRetry)return this.principalRetry;
    const controller=new AbortController();this.principalRetryCancel=controller;this.principalRetryExhausted=false;
    const timer=setTimeout(()=>controller.abort(),10000);
    const run=async()=>{
      let attempt=0;
      while(!controller.signal.aborted){
        await new Promise<void>(resolve=>{
          const finish=()=>{clearTimeout(delay);controller.signal.removeEventListener("abort",finish);resolve();};
          const delay=setTimeout(finish,[100,250,500,1000][Math.min(attempt++,3)]);
          controller.signal.addEventListener("abort",finish,{once:true});if(controller.signal.aborted)finish();
        });
        if(this.disposed)throw new Error(DISPOSED_MESSAGE);
        if(controller.signal.aborted)break;
        let abort:()=>void=()=>{};
        const cancelled=new Promise<never>((_resolve,reject)=>{
          abort=()=>{reject(this.disposed?new Error(DISPOSED_MESSAGE):new HostPrincipalBusyError());};
          controller.signal.addEventListener("abort",abort,{once:true});if(controller.signal.aborted)abort();
        });
        try{await Promise.race([this.connect(),cancelled]);if(controller.signal.aborted)break;return;}catch(error){
          if((error as {code?:string})?.code!=="PTY_HOST_PRINCIPAL_BUSY")throw error;
        }finally{controller.signal.removeEventListener("abort",abort);}
      }
      throw new HostPrincipalBusyError();
    };
    const task=run().catch(error=>{this.principalRetryExhausted=true;throw error;}).finally(()=>{clearTimeout(timer);if(this.principalRetry===task){this.principalRetry=null;this.principalRetryCancel=null;}});
    this.principalRetry=task;return task;
  }

  private async connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    const connected = this.socket && !this.socket.destroyed;
    if (connected && (!this.metadataRequired || this.metadataSocket === this.socket) && !this.receivedAuthTransfer?.receipt) return;
    this.connectPromise = (connected ? Promise.resolve() : this.connectWithHostStart()).then(async () => {
      // A quit already requested shutdown before dispose. Authentication may
      // finish on an existing host, but no discovery/continuity RPC is needed.
      if(this.issuedShutdown)return;
      if (!this.metadataRequired&&!this.receivedAuthTransfer&&!(this.reusedHost&&!this.ownsOwnerKey)) return;
      const socket = this.socket;
      if (!socket || socket.destroyed) throw new Error(PTY_HOST_NOT_CONNECTED);
      // Discover ownership before releasing queued spawn/write requests: a
      // child can outlive a host that dies before its first spawn response.
      const version=await withTimeout(this.sendRequest(socket, { id: 0, type: "version" }).catch(error => {
        if ((error as { code?: string }).code !== "PTY_HOST_REMOTE_ERROR") throw error;
        // A legacy host can explicitly reject version; it has no native owner.
      }), PTY_HOST_SOCKET_WAIT_TIMEOUT_MS);
      if (this.socket !== socket || socket.destroyed) throw new Error(PTY_HOST_NOT_CONNECTED);
      if(this.receivedAuthTransfer)try{
        await this.completeAnnouncedContinuity(socket,version);
      }catch{
        // Transport authentication succeeded. Recovery metadata failure is not
        // an authentication refusal and must not take down a serving socket.
        if(this.socket!==socket||socket.destroyed||this.disposed)throw Error(PTY_HOST_NOT_CONNECTED);
        if(!this.ownsOwnerKey){
          if(this.receivedAuthTransfer?.retirementOwner)this.recoveryOwner={...this.receivedAuthTransfer.retirementOwner};
          this.markContinuityUnavailable();
          this.recoveryHooks.log?.("pty-owner-continuity-unavailable",{reason:"authenticated recovery manifest unavailable"});
        }else this.recoveryHooks.log?.("host-transfer-completion-pending",{reason:"completion acknowledgement unavailable"});
      }
      if(!this.receivedAuthTransfer&&this.reusedHost&&!this.ownsOwnerKey&&(this.ownerBacked||!!(version as {owner?:unknown}|undefined)?.owner)){
        try{
          const response=await withTimeout(this.sendRequest(socket,{id:0,type:"owner-continuity"}),PTY_HOST_RESTART_REQUEST_TIMEOUT_MS);
          const continuity=validateOwnerContinuity(response,handoverPeer(socket),version);
          try{
            if(this.socket!==socket||socket.destroyed||this.disposed)throw Error("Terminal host changed during owner continuity");
            for(const pane of continuity.bootstrap.panes){
              this.recoveryLaunches.set(pane.id,{request:pane.request,launch:pane.launch,spawnedAt:pane.spawnedAt,pid:pane.pid});
              if(!this.endedBootPanes.has(pane.id))this.live.add(pane.id);
            }
            this.ownerSecret.set(continuity.credential);this.recoveryOwner={...continuity.bootstrap.owner};
            this.ownsOwnerKey=true;this.ownerContinuityUnavailable=false;
            this.recoveryHooks.log?.("pty-owner-continuity",{panes:continuity.bootstrap.panes.length,hostPid:this.lastHostPid,ownerPid:continuity.bootstrap.owner.pid});
          }finally{continuity.credential.fill(0);}
        }catch{
          this.markContinuityUnavailable();
          this.recoveryHooks.log?.("pty-owner-continuity-unavailable",{reason:"authenticated recovery manifest unavailable"});
        }
      }
      if(this.socket!==socket||socket.destroyed||this.disposed)throw Error(PTY_HOST_NOT_CONNECTED);
      this.metadataSocket = socket;
      for(const [id,receipt] of this.observedExits)this.observeExit(id,receipt);
    }).then(()=>{this.principalBusyPeer=undefined;this.principalRetryExhausted=false;}).catch(error => {
      this.dropSocket();throw error;
    }).finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async connectWithHostStart(): Promise<void> {
    try {
      await this.openSocket();
      // The socket already existed: this host predates the connection, so it
      // may hold PTY sessions from a previous app session.
      this.reusedHost = true;
      return;
    } catch(error) {
      if (this.disposed) throw new Error(DISPOSED_MESSAGE);
      if(!["ENOENT","ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code??""))throw error;
      if(this.principalBusyPeer!==undefined)throw new HostPrincipalBusyError();
      if(this.receivedAuthTransfer)throw this.refuseMissingAnnouncedHost();
      const prior=this.pendingPlannedHost;
      if(prior&&prior.exitCode===null&&prior.signalCode===null){
        await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);prior.removeListener("exit",done);resolve();};const timer=setTimeout(done,1000);prior.once("exit",done);});
      }
      if (this.disposed) throw new Error(DISPOSED_MESSAGE);
      if(this.ownerContinuityUnavailable)throw this.blockUnavailableOwner();
      try{await waitForHostShutdown(PTY_HOST_SOCKET_PATH,this.startupCancelled.signal);}catch(error){if(this.disposed)throw new Error(DISPOSED_MESSAGE);throw error;}
      if(this.disposed)throw new Error(DISPOSED_MESSAGE);
      this.hostAuthKey??=newHostAuthCapability();
      this.startHost();
      await this.openStartedHostSocket();
      this.reusedHost = this.plannedReusedBoot;
    }
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(PTY_HOST_SOCKET_PATH);
      const retrySignal=this.principalRetryCancel?.signal;
      const cancel=()=>{socket.destroy();reject(this.disposed?new Error(DISPOSED_MESSAGE):new HostPrincipalBusyError());};
      retrySignal?.addEventListener("abort",cancel,{once:true});
      socket.once("close",()=>retrySignal?.removeEventListener("abort",cancel));
      if(retrySignal?.aborted){cancel();return;}
      socket.setEncoding("utf8");
      if (this.observationOnly) this.socket = socket; // dispose also closes a pending connect
      let peer:HostAuthPeer|null=null;
      socket.once("connect", () => {void (async()=>{
        if (this.observationOnly && this.disposed) throw new Error(DISPOSED_MESSAGE);
        this.unannouncedRefusal=!this.hostAuthKey&&!this.receivedAuthTransfer;
        peer=handoverPeer(socket);
        const announced=this.receivedAuthTransfer?.ticket;
        if(announced&&(peer.pid!==announced.hostPid||peer.startIdentity!==announced.hostStartIdentity))throw new HostAuthError();
        if(!this.hostAuthKey)throw new HostAuthError();
        const startIdentity=ownerProcessStartIdentity(process.pid);
        if(!startIdentity)throw new HostAuthError();
        const authenticated=await authenticateHostSocket(socket,this.hostAuthKey,{pid:process.pid,startIdentity});
        if(this.disposed&&!this.issuedShutdown){socket.destroy();throw new Error(DISPOSED_MESSAGE);}
        retrySignal?.removeEventListener("abort",cancel);
        this.authRefusalPeer=undefined;this.unannouncedRefusal=false;
        this.socket = socket;
        this.hostAsked = false;
        this.ownerBacked = false;
        this.metadataSocket = null;
        this.lastHostPid = undefined;
        this.buffer = "";
        socket.on("data", (chunk) => this.onData(String(chunk)));
        socket.on("close", () => {
          if (this.socket === socket) this.onClose();
        });
        socket.on("error", () => {
          // close handles pending rejection
        });
        if(authenticated.buffered)this.onData(authenticated.buffered);
        socket.resume();resolve();
      })().catch(error=>{if(error instanceof HostPrincipalBusyError)this.principalBusyPeer=peer;else this.authRefusalPeer=peer;socket.destroy();reject(error);});});
      socket.once("error", reject);
    });
  }

  private startHost(bootstrap?:HandoverBootstrap|RecoveryBootstrap): ChildProcess {
    if(this.ownerContinuityUnavailable)throw this.blockUnavailableOwner();
    assertHostCreationSafe();
    if(!this.hostAuthKey)throw new HostAuthError();
    if(this.pendingPlannedHost&&this.pendingPlannedHost.exitCode===null&&this.pendingPlannedHost.signalCode===null)throw new Error("The previous terminal successor has not exited; another host was not started");
    try {
      fs.rmSync(PTY_HOST_SOCKET_PATH, { force: true });
    } catch {
      // best effort
    }
    const stderr = openHostStderr();
    try {
      // Re-prove absence after opening stderr, immediately before the fork.
      // A grace result or an earlier pre-unlink check is not a reusable permit.
      assertHostCreationSafe();
      const child = spawn(process.execPath, [this.hostScript], {
        detached: true,
        stdio: ["ignore", "ignore", stderr, "pipe", bootstrap?"pipe":"ignore", "pipe"],
        env: {
          ...process.env,
          [RUN_AS_NODE_VAR]: RUN_AS_NODE_VALUE,
          AYA_PTY_OWNER_FD: "3",
          AYA_PTY_AUTH_FD: "5",
          ...(bootstrap ? ("kind" in bootstrap?{AYA_PTY_RECOVERY_FD:"4"}:{AYA_PTY_CHECKPOINT_FD:"4"}) : {}),
        },
      });
      this.ownsOwnerKey=true;this.pendingPlannedHost=child;child.once("exit",()=>{if(this.pendingPlannedHost===child)this.pendingPlannedHost=null;});
      const secretPipe = child.stdio[3] as NodeJS.WritableStream;
      secretPipe.on("error", () => {}); secretPipe.end(this.ownerSecret);
      const authPipe=child.stdio.at(5) as NodeJS.WritableStream;
      authPipe.on("error",()=>{});authPipe.end(this.hostAuthKey);
      if(bootstrap){const pipe=child.stdio[4] as NodeJS.WritableStream;pipe.on("error",()=>{});pipe.end(JSON.stringify(bootstrap));}
      child.unref();
      return child;
    } finally {
      // The host holds its own copy of the descriptor.
      if (typeof stderr === "number") fs.closeSync(stderr);
    }
  }

  /** Connects to a host just started, retrying until the deadline while its socket is missing
   *  (ENOENT) or refuses: listen() creates the file at bind, a moment before it accepts, so a
   *  connect in that moment is refused (seen on macOS CI). */
  private async openStartedHostSocket(signal?:AbortSignal,child?:ChildProcess): Promise<void> {
    const deadline = Date.now() + PTY_HOST_SOCKET_WAIT_TIMEOUT_MS;
    for (;;) {
      if(this.disposed)throw new Error(DISPOSED_MESSAGE);
      if(signal?.aborted)throw new Error("Terminal host recovery was cancelled");
      if(child&&(child.exitCode!==null||child.signalCode!==null))throw new Error("The terminal host exited before accepting its recovery connection");
      try {
        await this.openSocket();
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ECONNREFUSED" && code !== "ENOENT") throw err;
        if (Date.now() >= deadline) {
          throw code === "ENOENT" ? new Error(`PTY host did not create ${path.basename(PTY_HOST_SOCKET_PATH)}`) : err;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, PTY_HOST_SOCKET_POLL_INTERVAL_MS));
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    // Events decoded from this read are batched and adjacent data chunks of
    // the same stream merged before crossing the IPC boundary: when the main
    // process lags behind a busy host, one socket read carries many event
    // lines, and forwarding them merged means a few webContents.send calls
    // (structured clone + renderer wakeup each) instead of one per line.
    // Responses flush the batch first so stream order is preserved exactly.
    let events: PtyEvent[] = [];
    const flushEvents = (): void => {
      if (events.length === 0) return;
      const merged = coalesceAdjacentData(events);
      events = [];
      this.sendToSinks(merged);
    };
    while (this.buffer.includes("\n")) {
      const idx = this.buffer.indexOf("\n");
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let message: PtyHostMessage;
      try {
        message = JSON.parse(line) as PtyHostMessage;
      } catch {
        // Malformed line from a stale/crashing host - skip rather than
        // letting the SyntaxError escape the event listener and become an
        // uncaughtException that would crash the Electron main process.
        continue;
      }
      if (this.observationOnly && (!message || typeof message !== "object" || !("id" in message))) continue;
      if ("type" in message && message.type === "cancel-prepare") {
        this.preparations.get(message.prepareId)?.abort();
        this.preparations.delete(message.prepareId);
        continue;
      }
      if ("type" in message && message.type === "prepare") {
        flushEvents();
        const socket = this.socket;
        const controller = new AbortController();
        this.preparations.set(message.prepareId, controller);
        void this.prepare(message.req, message.cwd, controller.signal).catch((err: unknown) => ({
          failure: { reason: "spawn-prepare-failed" as const, message: `Could not prepare this terminal: ${String(err)}` },
        })).then((data) => {
          this.preparations.delete(message.prepareId);
          if (controller.signal.aborted || !socket || socket.destroyed || socket !== this.socket || this.disposed) return;
          if(!("failure" in data))this.recoveryLaunches.set(message.req.ptyId,{request:{...message.req},launch:data.launch,spawnedAt:data.spawnedAt,pid:0});
          // No pending entry: this is a reply to the host's prepare message, not an app request.
          socket.write(JSON.stringify({ id: this.nextId++, type: "prepared", prepareId: message.prepareId, data }) + "\n");
        });
        continue;
      }
      if ("type" in message && message.type === "spawned") {
        flushEvents();
        if(message.ownerBacked)this.ownerBacked=true;
        if(message.ownerIdentity)this.cacheRecoveryOwner(message.ownerIdentity);
        if(message.hostPid)this.cacheHostProcess(message.hostPid);
        if(message.restored)this.live.add(message.req.ptyId);
        const prior=this.recoveryLaunches.get(message.req.ptyId);
        this.recoveryLaunches.set(message.req.ptyId,{request:message.req,launch:message.launch??prior?.launch??{command:message.req.command,cwd:message.cwd},spawnedAt:message.spawnedAt,pid:message.pid});
        this.lostOwned.delete(message.req.ptyId);
        this.sessionWatches.get(message.req.ptyId)?.();
        this.sessionWatches.set(message.req.ptyId,
          watchAgentSession(message.req, message.cwd, message.pid, message.spawnedAt, (sessionId) =>
            this.sendToSinks([{ type: "osc-session", ptyId: message.req.ptyId, sessionId }])));
        continue;
      }
      if ("type" in message && message.type === "snapshot") {
        flushEvents();
        const snapshot = asVtSnapshot(message.snapshot);
        if (snapshot) this.acceptSnapshot(message.ptyId, snapshot, message.replay === true);
        continue;
      }
      if ("type" in message && message.type === "event") {
        if(PANE_ENDED_EVENTS.has(message.event.type)){this.authRefusedPanes.delete(message.event.ptyId);this.principalBusyPanes.delete(message.event.ptyId);}
        if(message.event.type==="recovery-screen"){
          this.recoveryScreens.set(message.event.ptyId,message.event);
          const state=this.recoveredStates.get(message.event.ptyId);if(state?.generation===message.event.generation)state.screenUnknown=!message.event.known;
        }
        if(message.event.type==="exit"&&message.event.ownerExit){
          const {generation,event}=message.event.ownerExit,id=message.event.ptyId;
          if(!Number.isInteger(generation)||generation<1||generation>0xffffffff||!Number.isInteger(event)||event<1||event>0xffffffff)continue;
          const previous=this.observedExits.get(id);
          const receipt=previous?.generation===generation&&previous.event===event?previous:{generation,event};
          if(receipt!==previous)this.exitAckRetries.delete(id);
          this.observedExits.set(id,receipt);this.endedBootPanes.set(id,message.event.exitCode);
          this.observeExit(id,receipt);
          if(previous?.generation===generation&&previous.event===event&&!this.exitReplayFlights.has(id))continue;
        }
        if (message.event.type === "disconnected") this.lostOwned.add(message.event.ptyId);
        if (PANE_ENDED_EVENTS.has(message.event.type)) {
          this.live.delete(message.event.ptyId);
          this.sessionWatches.get(message.event.ptyId)?.();
          this.sessionWatches.delete(message.event.ptyId);
          this.screenStates.delete(message.event.ptyId);this.recoveryScreens.delete(message.event.ptyId);
          this.latestRuleSnapshots.delete(message.event.ptyId);this.ruleStatusStates.delete(message.event.ptyId);
          const ruleTimer=this.ruleStatusTimers.get(message.event.ptyId);if(ruleTimer)clearTimeout(ruleTimer);this.ruleStatusTimers.delete(message.event.ptyId);this.ruleStatusPending.delete(message.event.ptyId);
        }
        events.push(message.event);
        continue;
      }
      if ("id" in message) {
        flushEvents();
        this.onResponse(message);
      }
    }
    flushEvents();
  }

  private cacheHostProcess(pid:number):void {
    if(this.lastHostPid!==pid||!this.lastHostStart){try{this.lastHostStart=ownerProcessStartIdentity(pid);}catch{this.lastHostStart=null;}}
    this.lastHostPid=pid;
  }
  private cacheRecoveryOwner(owner:RecoveryOwnerIdentity&{incompatible:boolean}):void {
    this.recoveryOwner=!owner.incompatible?{pid:owner.pid,startTime:owner.startTime,instanceId:owner.instanceId,binaryHash:owner.binaryHash}:null;
  }
  private onResponse(message: PtyHostResponse): void {
    if(message.ownerIdentity)this.cacheRecoveryOwner(message.ownerIdentity);
    if (message.ownerBacked) { this.ownerBacked = true; this.metadataSocket = this.socket; }
    const reportedPid = message.hostPid ?? (message.ok && message.result && typeof message.result === "object" ? (message.result as { pid?: unknown }).pid : undefined);
    if (typeof reportedPid === "number" && Number.isSafeInteger(reportedPid) && reportedPid > 1) {
      this.cacheHostProcess(reportedPid);
    }
    if(message.ok&&message.result&&typeof message.result==="object"&&"owner" in message.result){
      const owner=(message.result as {owner?:PtyOwnerStatus}).owner;
      this.recoveryOwner=owner&&!owner.incompatible&&owner.instanceId&&owner.startTime&&owner.hash?{pid:owner.pid,instanceId:owner.instanceId,startTime:owner.startTime,binaryHash:owner.hash}:null;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(Object.assign(new Error(message.error), { code: message.code === "PTY_HOST_STALE_REVISION"||message.code === "PTY_HOST_RULES_CHANGED" ? message.code : "PTY_HOST_REMOTE_ERROR" }));
  }

  private sendToSinks(events: PtyEvent[]): void {
    for (const wc of this.sinks) {
      if (wc.isDestroyed()) {
        this.sinks.delete(wc);
        continue;
      }
      for (const event of events) wc.send("pty:event", event);
    }
  }

  private stopSessionWatches(): void {
    for (const controller of this.preparations.values()) controller.abort();
    this.preparations.clear();
    for (const stop of this.sessionWatches.values()) stop();
    this.sessionWatches.clear();
  }

  private onClose(): void {
    this.closeEpoch++;
    this.socket = null;
    for(const timer of this.exitAckTimers.values())clearTimeout(timer);this.exitAckTimers.clear();
    this.stopSessionWatches();
    this.screenStates.clear();
    for(const timer of this.ruleStatusTimers.values())clearTimeout(timer);this.ruleStatusTimers.clear();this.ruleStatusPending.clear();this.latestRuleSnapshots.clear();this.ruleStatusStates.clear();
    // Not gated on dispose: that is the quit, whose closing windows keep a no-session in memory only.
    const lost = this.hostAsked ? [] : [...this.live];
    if (this.ownerBacked||this.ownerContinuityUnavailable) for (const id of lost) this.lostOwned.add(id);
    this.live.clear();
    // The host took its panes down without a word: stopped and restartable, as for a pane it has no session for.
    this.sendToSinks(lost.map((ptyId):PtyEvent => this.ownerBacked||this.ownerContinuityUnavailable
      ? {type:"disconnected",ptyId,...(this.ownsOwnerKey&&this.crashSupervisor?{recoveryBlocked:true,retryable:this.recoveryRetryable,...(this.recoveryRetryable?{reason:this.recoveryReason}:{})}:{})}
      : {type:"no-session",ptyId}));
    for (const [, pending] of this.pending) {
      if((pending.type==="write"||pending.type==="write-fenced")&&pending.ptyId)this.uncertainInput.add(pending.ptyId);
      pending.reject(new Error(pending.type==="write"||pending.type==="write-fenced"?"Terminal input acknowledgement was lost when the terminal host stopped. Some bytes may have reached the process. Aya did not resend it.":"PTY host disconnected"));
    }
    this.pending.clear();
    if(this.crashTask){this.crashAgain=true;return;}
    if(!this.disposed&&!this.hostAsked&&this.ownerContinuityUnavailable){
      this.blockUnavailableOwner();
      for(const ptyId of lost){this.authRefusedPanes.set(ptyId,this.recoveryReason!);this.sendToSinks([{type:"disconnected",ptyId,reason:this.recoveryReason}]);}
      this.recoveryHooks.log?.("pty-crash-recovery-unavailable",{reason:"authenticated recovery manifest unavailable"});return;
    }
    if(!this.disposed&&!this.hostAsked&&this.ownerBacked&&lost.length&&this.crashSupervisor){
      this.crashBlocked=true;
      if(!this.ownsOwnerKey){
        const reason="Aya restarted since this terminal host started, so it cannot restart the host for these panes. The native owner may still keep their processes running. Aya left the panes disconnected and did not respawn them; use Settings > Diagnostics > PTY host > Restart to review stopping them.";
        this.recoveryReason=reason;
        this.recoveryHooks.log?.("pty-crash-recovery-unavailable",{reason:"owner key unknown"});
        this.sendToSinks(lost.map(ptyId=>({type:"disconnected",ptyId,reason})));return;
      }
      if(!this.lastHostPid||!this.lastHostStart||!this.recoveryOwner){
        const reason="Aya cannot verify the stopped host or its native owner. The panes were kept disconnected; processes may still be running and were not respawned.";
        this.recoveryReason=reason;
        this.recoveryHooks.log?.("pty-crash-recovery-unavailable",{reason:"owner or host identity unknown"});
        this.sendToSinks(lost.map(ptyId=>({type:"disconnected",ptyId,reason})));return;
      }
      this.crashContext={pid:this.lastHostPid,start:this.lastHostStart,owner:{...this.recoveryOwner}};
      this.beginCrashRecovery();
    }
  }
  private beginCrashRecovery():void {
    if(this.disposed||this.crashTask||!this.crashSupervisor)return;
    let again=false;
    const task=this.crashSupervisor.recover().then(ok=>{again=ok&&this.crashAgain;return ok;}).finally(()=>{
      if(this.crashTask===task)this.crashTask=null;
      if(again&&!this.disposed){this.crashAgain=false;this.beginCrashRecovery();}
    });this.crashTask=task;
  }
  private async recoverCrashedHost(signal:AbortSignal):Promise<RecoveryAttemptResult> {
    const context=this.crashContext;if(!context||this.disposed||signal.aborted)return "blocked";
    let child:ChildProcess|undefined;
    const stop=()=>{if(child&&child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");};
    signal.addEventListener("abort",stop,{once:true});
    try{
      this.recoveryFailure="The previous host or its native owner could not be verified.";
      const previous=readProcInfo(context.pid);
      if(previous.probeFailed)return "blocked";
      if(previous.alive){const identity=ownerProcessStartIdentity(context.pid);if(!identity||identity===context.start)return "blocked";} // socket loss alone is not death
      const record=readOwnerRecord(),expected=context.owner;
      if(!record||record.pid!==expected.pid||record.startTime!==expected.startTime||record.instanceId!==expected.instanceId||record.binaryHash!==expected.binaryHash||!ownerRecordIsLive(record)||ownerReaderIsLive(record)||ownerBinaryHash(ownerArtifactPaths().executable)!==expected.binaryHash)return "blocked";
      const panes:RecoveryPane[]=[];
      for(const pane of record.panes){
        const launch=this.recoveryLaunches.get(pane.id);
        if(pane.acknowledged||!launch||launch.pid!==pane.pid||!pane.startIdentity)continue;
        const request={...launch.request};delete request.attachOnly;delete request.attachIfReused;delete request.replayAfter;
        panes.push({...launch,id:pane.id,generation:pane.generation,pid:pane.pid,startIdentity:pane.startIdentity,request});
      }
      const observed=[...this.observedExits].slice(0,25).map(([id,p])=>({id,generation:p.generation,event:p.event}));
      const bootstrap=parseRecoveryBootstrap(Buffer.from(JSON.stringify({format:1,kind:"crash",owner:expected,panes,observed})));
      if(this.disposed||signal.aborted)return "blocked";
      if(this.pendingPlannedHost&&this.pendingPlannedHost.exitCode===null&&this.pendingPlannedHost.signalCode===null){
        await new Promise<void>(resolve=>{const timer=setTimeout(resolve,1000);this.pendingPlannedHost!.once("exit",()=>{clearTimeout(timer);resolve();});});
      }
      if(this.disposed||signal.aborted)return "blocked";
      child=this.startHost(bootstrap);if(signal.aborted)stop();
      await this.openStartedHostSocket(signal,child);
      if(signal.aborted||this.disposed)throw Error("Crash recovery cancelled");
      const socket=this.socket;if(!socket)throw Error("Crash recovery did not connect");
      const version=await withTimeout(this.sendRequest(socket,{id:0,type:"version"}),2000) as {pid:number;owner?:PtyOwnerStatus;recovery?:Array<{id:string;generation:string;exitCode?:number}>};
      if(version.pid!==child.pid||version.owner?.pid!==expected.pid||version.owner.instanceId!==expected.instanceId||version.owner.startTime!==expected.startTime||version.owner.hash!==expected.binaryHash||version.owner.incompatible||!Array.isArray(version.recovery)||version.recovery.length>25)throw Error("Crash recovery identity mismatch");
      const ids=new Set<string>();
      for(const p of version.recovery){
        if(!p||!panes.some(x=>x.id===p.id)||ids.has(p.id)||typeof p.generation!=="string"||!p.generation.length||p.generation.length>128||Object.keys(p).some(key=>!["id","generation","exitCode"].includes(key))||(p.exitCode!==undefined&&(!Number.isInteger(p.exitCode)||p.exitCode<0||p.exitCode>255)))throw Error("Crash recovery pane manifest refused");
        ids.add(p.id);
      }
      const expectedIds=panes.filter(p=>!record.panes.some(native=>native.id===p.id&&native.exited&&observed.some(o=>o.id===p.id&&o.generation===native.generation&&o.event===native.event))).map(p=>p.id);
      if(expectedIds.length!==ids.size||expectedIds.some(id=>!ids.has(id)))throw Error("Crash recovery pane manifest is incomplete");
      this.metadataSocket=socket;this.reusedHost=true;this.plannedReusedBoot=true;
      const ready=version.recovery.map(p=>{
        this.lostOwned.delete(p.id);if(p.exitCode===undefined)this.live.add(p.id);
        return {...p,notice:"The terminal host restarted. Previously consumed screen and history were lost; "+(p.exitCode===undefined?"unread output and the running process were kept.":`unread output was kept; the process had exited with code ${p.exitCode}.`)+(this.uncertainInput.has(p.id)?" Input acknowledgement was lost; some bytes may have reached this process. Aya did not resend it. Check before retrying.":""),replayToken:randomBytes(16).toString("hex")};
      });
      this.recoveryHooks.log?.("pty-crash-recovery-inventory",{recovered:ready.map(p=>p.id),disconnected:[...this.lostOwned]});
      this.recoveredStates=new Map(ready.map(p=>[p.id,{type:"recovery-state",ptyId:p.id,generation:p.generation,notice:p.notice,screenUnknown:this.recoveryScreens.get(p.id)?.generation===p.generation&&this.recoveryScreens.get(p.id)?.known===false}]));
      this.recoveryHooks.restored?.(ready);
      for(const pane of ready){
        this.sendToSinks([{type:"recovered",ptyId:pane.id,generation:pane.generation,replayToken:pane.replayToken,notice:pane.notice}]);
        const screen=this.recoveryScreens.get(pane.id);if(screen?.generation===pane.generation)this.sendToSinks([screen]);
        const launch=this.recoveryLaunches.get(pane.id)!;
        await withTimeout(this.sendRequest(socket,{id:0,type:"spawn",req:{...launch.request,attachOnly:true,replayAfter:{generation:pane.generation,offset:0,token:pane.replayToken}}}),2000);
      }
      for(const [id,receipt] of this.observedExits){this.exitAckRetries.delete(id);this.observeExit(id,receipt);}
      if(this.socket!==socket||socket.destroyed||signal.aborted||this.disposed)throw Error("Crash recovery lost its connection");
      this.crashAgain=false;this.crashBlocked=false;this.recoveryReason=undefined;this.recoveryRetryable=false;this.recoveryFailure="";
      return "recovered";
    }catch(error){
      this.recoveryFailure=String(error).slice(0,500);
      this.recoveryHooks.log?.("pty-crash-recovery-attempt-failed",{reason:String(error)});
      stop();
      if(child&&child.exitCode===null&&child.signalCode===null){
        try{await withTimeout(new Promise<void>(resolve=>child!.once("exit",()=>resolve())),3000);}catch{return "blocked";}
      }
      this.dropSocket();return signal.aborted||this.disposed?"blocked":"retry";
    }finally{signal.removeEventListener("abort",stop);}
  }
}

/** `attachOnly` always attaches; `attachIfReused` only on a host this client did not spawn (a fresh host
 *  cannot hold the session, so attaching there would stop every boot tab). */
export function resolveSpawnAttach(
  attachOnly: boolean | undefined,
  attachIfReused: boolean | undefined,
  reusedHost: boolean,
): boolean {
  return !!attachOnly || (!!attachIfReused && reusedHost);
}

/** Narrow an untyped handshake reply to HostIdentity, or null if malformed
 *  (a wrong-shaped reply is as untrustworthy as no reply). */
function asHostIdentity(value: unknown): HostIdentity | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.version !== "string" || typeof v.scriptHash !== "string") {
    return null;
  }
  const runtime = v.runtime as HostIdentity["runtime"];
  return { version: v.version, scriptHash: v.scriptHash,
    ...(typeof runtime?.node === "string" && typeof runtime.electron === "string" ? { runtime } : {}) };
}
