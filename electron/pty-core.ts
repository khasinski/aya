// PTY host. One IPty per ptyId, all events forwarded to the renderer.
//
// We accept a literal `command` string from the renderer and wrap it in
// `$SHELL -l -i -c 'cd CWD && exec COMMAND'`. Using the user's login +
// interactive shell - not a hard-coded bash - lets PATH, functions, aliases,
// and env from their normal terminal startup files flow through.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as PtyModule from "node-pty";
import { OwnerPty } from "./pty-owner-adapter";
import {MAX_CHECKPOINT_BYTES,MAX_VT_SNAPSHOT_BYTES} from "./vt-checkpoint-schema";
import {MAX_PTY_PANES, paneLimitFailureMessage} from "./pty-pane-limits";
import type { VtCheckpoint } from "./vt-checkpoint";
import { validatePaneCoreCheckpoint, validateCoreHandoverPart, checkpointGeneration, type CoreHandoverPart, type EndedCoreCheckpoint, type PaneCoreCheckpoint } from "./pty-core-checkpoint";
import { currentOwnerRuntime, getOwnerRuntime } from "./pty-owner-runtime";
import type { PtyEvent, SpawnFailureReason, SpawnRequest } from "./types";
import {
  extractAyaOsc,
  parseAyaOscSession,
  parseAyaOscStatus,
} from "./osc-extractor";
import {
  beginVtRecovery,
  panes as vtPanes,
  snapshotOf,
  vtSnapshotMatches,
  validVtSnapshotFence,
  type VtSnapshotFence,
  checkpointVtPane,
  restoreVtPane,
  closeAllVtPanes,
  closeVtPane,
  openVtPane,
  resizeVtPane,
  vtPaneAltScreen,
  vtPaneReplayModeState,
  writeVtPane,
} from "./vt-mirror";
import type { OwnerPane } from "./pty-owner-client";
import type { RecoveryPane } from "./pty-recovery-bootstrap";
import { validateRecoveryLaunch } from "./pty-core-checkpoint";
import type { PaneLaunch } from "./launch-mode";
import type { PaneSize } from "./pane-render";
import { COMMAND_NOT_FOUND_EXIT_CODE, MIN_PTY_COLS, MIN_PTY_ROWS } from "./pty-core-constants";
import { consumeReplayModes, initialReplayModeTracker, legacyReplayModeTracker, replayModePrefix, validateReplayModeTracker, type ReplayModeTracker, type ReplayModeState } from "./pty-replay-modes";
import { ptyLog } from "./pty-log";

export type PreparedSpawn =
  | { failure: { reason: SpawnFailureReason; message: string } }
  | { argv: string[]; env: Record<string, string>; command: string; launch: PaneLaunch; ownSessionId: string | null; spawnedAt: number };
export interface SpawnServices {
  prepare(req: SpawnRequest, cwd: string, signal: AbortSignal): Promise<PreparedSpawn>;
  opened?(req: SpawnRequest, pid: number, prepared: Exclude<PreparedSpawn, { failure: unknown }>, sink: PtyEventSink): () => void;
  openMirror?: typeof openVtPane;
  replay?(req: SpawnRequest, pid: number, spawnedAt: number, sink: PtyEventSink): Promise<void> | void;
}
// Search-snippet context window around a match (chars).
const SEARCH_SNIPPET_CONTEXT_BEFORE = 30; // chars before the match
const SEARCH_SNIPPET_CONTEXT_AFTER = 50; // chars after the match
// Stop counting occurrences past this many (snippet "more" cap).
const SEARCH_MAX_COUNT_DISPLAY = 99;

const ptys = new Map<string, OwnerPty>();
const launches = new Map<string, PaneLaunch>();
const spawnTimes = new Map<string, number>();
const spawnRequests = new Map<string, SpawnRequest>();
const pendingOwnerExits = new Map<string,OwnerPane>();

const vtStatusEvent = (ptyId: string, waiting: boolean, dialog: string | undefined): PtyEvent =>
  dialog ? { type: "vt-status", ptyId, waiting, dialog } : { type: "vt-status", ptyId, waiting };

// Per-PTY rolling buffer of recent output, used to repaint xterm.js when the
// renderer remounts (Vite HMR, React strict-mode double-mount, etc.). The PTY
// keeps running across these events but the new xterm.js instance has no
// scrollback - we replay the buffered bytes so the user sees the existing
// terminal state instead of an empty pane.
export const OUTPUT_BUFFER_MAX = 1_000_000; // ~1MB of recent bytes per terminal
// `total` is the summed length of `chunks`, kept incrementally so the 1MB cap
// is enforced in O(1) per chunk instead of re-summing the whole buffer (which
// was O(chunks) per chunk → O(n²) over a busy session).
interface OutputBuffer {
  chunks: string[];
  total: number;
  /** Monotonic append counter; invalidates searchCache below. (`total` alone
   *  is not a safe key: cap eviction can shrink and regrow it to the same
   *  value with different content.) */
  version: number;
  /** Clean UTF-16 output boundary, independent of chunk/coalescing edges. */
  end: number;
  /** Cleaned + lowercased render of `chunks`, reused across search keystrokes
   *  so an unchanged buffer costs indexOf scans instead of a full join + 4
   *  regex passes + toLowerCase over ~1MB per live PTY per keystroke. */
  searchCache?: { version: number; cleaned: string; lower: string };
  /** Mode state at the first retained byte, including a split CSI carry. */
  replayModes: ReplayModeTracker;
  /** False only for legacy ended checkpoints with no VT state to reconstruct it. */
  replayModesKnown: boolean;
}
const outputBuffers = new Map<string, OutputBuffer>();
function restoreOutputBuffer(value: PaneCoreCheckpoint["output"], legacyCurrentModes?: ReplayModeState): OutputBuffer {
  const legacyModes = value.replayModes ? undefined : legacyCurrentModes
    ? legacyReplayModeTracker(legacyCurrentModes, value.chunks.join("")) : undefined;
  return { chunks: [...value.chunks], total: value.total, version: value.version, end: value.end,
    replayModes: value.replayModes ? validateReplayModeTracker(value.replayModes) :
      legacyModes ?? initialReplayModeTracker(),
    replayModesKnown: value.replayModes !== undefined || (legacyCurrentModes !== undefined && legacyModes !== null) };
}
// Restored processes read immediately. Keep their replay and real exit outcome
// until the first renderer attaches, even if the child exits during that gap.
const frozenEndedPanes=new Map<string,EndedCoreCheckpoint>();
const restoredPanes = new Map<string, {generation: string; attached: boolean; replayToken?: string; exitCode?: number; releaseOwner?:()=>void}>();

function removeRestoredPane(id:string):void {restoredPanes.get(id)?.releaseOwner?.();restoredPanes.delete(id);}
function clearRestoredPanes():void {for(const id of restoredPanes.keys())removeRestoredPane(id);}
function holdEndedPane(id:string,generation:string,exitCode:number):void {
 removeRestoredPane(id);restoredPanes.set(id,{generation,exitCode,attached:false,releaseOwner:currentOwnerRuntime()?.holdRestoration()});
}

// Per-PTY held-back partial OSC 9001 sequence, when a chunk boundary lands
// mid-sequence (see osc-extractor.ts). Cleared alongside outputBuffers on
// exit/kill/shutdown so nothing leaks across a respawn under the same id.
const oscCarryBuffers = new Map<string, string>();

// Spawn/kill race guard: if killPty arrives before the corresponding
// spawnPty's IPC has finished (renderer remounted/closed quickly), the kill
// finds no IPty in the map and is a no-op. The pending spawn then runs and
// the resulting PTY is orphaned. We remember which ptyIds got an early kill
// and bail out of subsequent spawn for them.
const pendingKills = new Set<string>();
// Auto-evict pending-kill markers so stale ids don't linger forever (defense
// in depth - usually the spawn either runs within milliseconds or never).
const PENDING_KILL_TTL_MS = 5_000;
// Grace period before escalating a kill to SIGKILL. node-pty's default kill
// sends SIGHUP, which a stuck agent (e.g. `claude --chrome`) can trap and
// survive; since killPty removes the id from the map, a survivor becomes an
// orphan that a later respawn of the same id turns into a SECOND live process.
// The uncatchable follow-up guarantees the old child actually dies.
export const KILL_ESCALATE_MS = 750;
// In-flight spawn guard: spawnPty awaits an async command-exists preflight
// between the `ptys.has` check and registering the PTY. Two concurrent spawns
// for the same id (e.g. a fast unmount+remount) could both pass that check and
// both spawn, orphaning the first. We mark an id as spawning across the await
// so a racing call bails instead of starting a second process. A kill that
// lands meanwhile cancels THAT spawn: the flag lives on its own entry, so no
// other spawn call can consume it and no timer can expire it. `done` settles
// when the spawn does, so a restart that meets a cancelled flight can wait it
// out instead of being dropped (see spawnPty).
interface SpawnFlight {
  abort: AbortController;
  cancelled: boolean;
  done: Promise<void>;
}
const spawning = new Map<string, SpawnFlight>();

function newFlight(): [SpawnFlight, () => void] {
  let settle!: () => void;
  const done = new Promise<void>((resolve) => (settle = resolve));
  return [{ abort: new AbortController(), cancelled: false, done }, settle];
}
// Waiters for input parked on an in-flight spawn. Buffering is not delivery: a
// failed spawn discards the queue, so each waiter gets the real outcome.
const spawnWaiters = new Map<string, ((delivered: boolean) => void)[]>();

/** Settle the parked waiters; `delivered` = the queue reached a live PTY. */
function settleSpawnWaiters(ptyId: string, delivered: boolean): void {
  const waiters = spawnWaiters.get(ptyId);
  if (!waiters) return;
  spawnWaiters.delete(ptyId);
  for (const resolve of waiters) resolve(delivered);
}
// Keystrokes that arrived while a spawn was still in flight. A real tty buffers
// what you type before the shell has read it; dropping it here instead meant a
// command typed into a pane that looked ready vanished with no echo and no
// error. Held only across the spawn window: once the PTY registers, these are
// written in order and the map entry is gone (see spawnPty's flush + finally).
const pendingWrites = new Map<string, string[]>();
// Bound per id, so a spawn that never completes (or a paste into a pane whose
// command hangs in preflight) cannot grow the host's memory without limit.
// Well above any realistic burst of typing; a chunk past it is refused whole.
export const PENDING_WRITE_MAX_BYTES = 64 * 1024;
// Set once the host begins shutting down. shutdownPtyChildren snapshots the live
// PTYs and the host then lingers up to KILL_ESCALATE_MS to deliver SIGKILL; a
// spawn that registered a PTY in that window would escape the snapshot and be
// orphaned on exit. spawnPty bails when this is set (and again after its async
// preflight) so no child is created after the snapshot. One-way: the host is
// exiting, so it never resets.
let shuttingDown = false;
let handoverGated = false;
let handoverFreezing = false;
let handoverEpoch = 0;
const killing = new Set<Promise<void>>();
function requireMutableCore(): void {
  if (handoverGated) throw new Error("Terminal handover is in progress. This operation was not applied.");
}
export function ptyCoreHandoverInProgress(): boolean { return handoverGated; }
const frozenPanes = new Map<string, PaneCoreCheckpoint>();
const ineligiblePanes = new Map<string, string>();

export interface CoreHandoverPreflight {
  eligible: Array<{id: string; generation: string; outputEnd: number}>;
  ineligible: Array<{id: string; reason: string}>;
}
async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Terminal handover drain timed out; its processes were kept.")), ms); })]); }
  finally { clearTimeout(timer); }
}
/** Gate producers before awaiting anything. Existing preparations/kills finish
 * first; each adapter then proves writes and stops reads before VT export. */
export async function freezePtyCore(timeoutMs = 1000, maxBytes = MAX_CHECKPOINT_BYTES): Promise<CoreHandoverPreflight> {
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>MAX_CHECKPOINT_BYTES)throw new Error("Invalid core checkpoint budget");
  if (handoverGated || handoverFreezing || shuttingDown) throw new Error("A terminal handover is already in progress");
  handoverGated = true; handoverFreezing = true;
  const epoch = ++handoverEpoch;
  try {
    await bounded(Promise.all([...spawning.values()].map(flight => flight.done).concat([...killing])), timeoutMs);
    if (!handoverGated || epoch !== handoverEpoch) throw new Error("Terminal handover was cancelled");
    if (pendingWrites.size || pendingKills.size) throw new Error("Pending terminal operations have not settled");
    let endedBytes=0;
    for(const [id,pane] of restoredPanes){
      if(pane.exitCode===undefined||ptys.has(id))continue;
      const output=outputBuffers.get(id)??{chunks:[],total:0,version:0,end:0,replayModes:initialReplayModeTracker(),replayModesKnown:true};
      const nativeExit=pendingOwnerExits.get(id);
      const outputDto={chunks:output.chunks,total:output.total,version:output.version,end:output.end,...(output.replayModesKnown?{replayModes:structuredClone(output.replayModes)}:{})};
      const dto:EndedCoreCheckpoint={format:1,kind:"ended",id,generation:pane.generation,exitCode:pane.exitCode,...(nativeExit?{ownerExit:{generation:nativeExit.generation,event:nativeExit.event}}:{}),output:outputDto};
      await validateCoreHandoverPart(dto);
      if(!handoverGated||epoch!==handoverEpoch)throw Error("Terminal handover was cancelled");
      endedBytes+=Buffer.byteLength(JSON.stringify(dto));
      if(endedBytes>maxBytes)throw Error("Retained terminal exits exceed the aggregate core checkpoint budget");
      frozenEndedPanes.set(id,dto);
    }
    if(frozenEndedPanes.size+ptys.size>MAX_PTY_PANES)throw Error("Too many terminal checkpoint records");
    if(!handoverGated||epoch!==handoverEpoch)throw Error("Terminal handover was cancelled");
    const candidates=await Promise.all([...ptys].map(async([id,child])=>{
      try{return {id,child,adapter:await child.freezeForHandover(timeoutMs)};}
      catch(error){
        child.resumeAfterHandoverAbort();
        if(handoverGated&&epoch===handoverEpoch&&ptys.get(id)===child)ineligiblePanes.set(id,error instanceof Error?error.message:"The pane cannot move at this moment");
        return null;
      }
    }));
    // Read barriers settle in parallel, but materialize/validate snapshots one
    // at a time. Retained producer DTOs share the same128MiB raw aggregate cap.
    let retained=endedBytes;
    for(const candidate of candidates){
      if(!candidate)continue;
      const {id,child,adapter}=candidate;
      try {
        if(!handoverGated||epoch!==handoverEpoch)throw new Error("Terminal handover was cancelled");
        const vt: VtCheckpoint = await checkpointVtPane(id);
        if (ptys.get(id) !== child || !spawnRequests.has(id) || !launches.has(id)) throw new Error("The pane changed during handover");
        const output = outputBuffers.get(id) ?? {chunks: [], total: 0, version: 0, end: 0, replayModes: initialReplayModeTracker(), replayModesKnown:true};
        const dto: PaneCoreCheckpoint = {
          format: 1, id, adapter, request: spawnRequests.get(id)!, launch: launches.get(id)!, spawnedAt: spawnTimes.get(id)!,
          output: {chunks: [...output.chunks], total: output.total, version: output.version, end: output.end, replayModes: structuredClone(output.replayModes)},
          oscCarry: oscCarryBuffers.get(id) ?? "", vt,
        };
        const json=JSON.stringify(dto),bytes=Buffer.byteLength(json);
        if(bytes>MAX_VT_SNAPSHOT_BYTES||bytes>maxBytes-retained)throw new Error("The pane exceeds the aggregate core checkpoint budget");
        const checked = await validatePaneCoreCheckpoint(JSON.parse(json));
        if (!handoverGated || epoch !== handoverEpoch) throw new Error("Terminal handover was cancelled");
        retained+=bytes;frozenPanes.set(id, checked);
      } catch (error) {
        child.resumeAfterHandoverAbort();
        if (handoverGated && epoch === handoverEpoch && ptys.get(id) === child) ineligiblePanes.set(id, error instanceof Error ? error.message : "The pane cannot move at this moment");
      }
    }
    if (!handoverGated || epoch !== handoverEpoch) throw new Error("Terminal handover was cancelled");
    const owner = currentOwnerRuntime();
    for (const id of owner?.disconnected.keys() ?? []) if (!ptys.has(id)) ineligiblePanes.set(id, "The pane's owner connection is unavailable");
    return {
      eligible: frozenPtyCoreParts().map(pane=>({id:pane.id,generation:checkpointGeneration(pane),outputEnd:pane.output.end})),
      ineligible: [...ineligiblePanes].map(([id, reason]) => ({id, reason})),
    };
  } catch (error) { if (epoch === handoverEpoch) abortPtyCoreHandover(); throw error; }
  finally { handoverFreezing = false; }
}
export function abortPtyCoreHandover(): void {
  handoverEpoch++;
  for (const child of ptys.values()) child.resumeAfterHandoverAbort();
  frozenPanes.clear(); frozenEndedPanes.clear(); ineligiblePanes.clear(); handoverGated = false;
}
export function frozenPtyCoreParts(): CoreHandoverPart[] {
  if (!handoverGated) throw new Error("PTY checkpoint has no output barrier");
  return [...frozenEndedPanes.values(),...frozenPanes.values()];
}
/** A bounded aggregate can make an individually valid pane ineligible. Keep
 * its process/read path alive and require its own explicit fallback consent. */
export function excludeFrozenPtyPane(id: string, reason: string): void {
  if (!handoverGated || !frozenPanes.has(id)) throw new Error("Unknown frozen pane");
  ptys.get(id)?.resumeAfterHandoverAbort();
  frozenPanes.delete(id); ineligiblePanes.set(id, reason);
}
/** Only the coordinator calls this after #219 consent for these exact panes.
 * Eligible panes remain paused and keep their owner masters throughout. */
export interface HandoverCommitResult {stopped:string[];ended:Array<{id:string;exitCode:number;ownerExit?:{generation:number;event:number}}>}
export function endedHandoverPanes():HandoverCommitResult["ended"] {
  return [...restoredPanes].flatMap(([id,p])=>{const native=pendingOwnerExits.get(id);return p.exitCode===undefined?[]:[{id,exitCode:p.exitCode,...(native?{ownerExit:{generation:native.generation,event:native.event}}:{})}];});
}
export async function stopIneligiblePtyPanes(consented: string[]): Promise<HandoverCommitResult> {
  if (!handoverGated || new Set(consented).size !== consented.length || [...ineligiblePanes.keys()].some(id=>!consented.includes(id))) throw new Error("Missing consent for terminal fallback");
  const stopped:string[]=[];
  for (const id of consented) {
    const child=ptys.get(id);
    if(child){
      let outcome:{exitCode:number;signal?:number}|undefined;
      const listener=child.onExit(e=>{outcome=e;});
      try{await killPtyInternal(id);}finally{listener.dispose();}
      // A naturally completed command must never gain automatic respawn rights.
      if(await child.confirmedStopAction())stopped.push(id);
      else if(outcome)holdEndedPane(id,"ended-ineligible",outcome.exitCode);
      else throw new Error("The fallback terminal exit outcome is unknown");
    }else if(currentOwnerRuntime()?.disconnected.has(id)){
      await killPtyInternal(id);stopped.push(id);
    }
    ineligiblePanes.delete(id);
  }
  return {stopped,ended:endedHandoverPanes()};
}
/** An unchanged host still serves newly mounted renderers from B, and must
 * retain a child's exit if it ends before the first post-update attach. */
export function pruneEndedIneligiblePtyPanes():Set<string> {
  for(const id of ineligiblePanes.keys())if(!ptys.has(id)&&!currentOwnerRuntime()?.disconnected.has(id))ineligiblePanes.delete(id);
  return new Set(ineligiblePanes.keys());
}
export function reusePtyCoreAfterHandover():void {
  for(const [id,pane] of frozenPanes)restoredPanes.set(id,{generation:(pane.vt.metadata as {generation:string}).generation,attached:false});
  for(const id of ineligiblePanes.keys())if(ptys.has(id)&&!restoredPanes.has(id))restoredPanes.set(id,{generation:"reused-ineligible",attached:false});
  abortPtyCoreHandover();
}
export async function detachPtyCoreForHandover(commit: () => void = () => {}): Promise<void> {
  if (!handoverGated || ineligiblePanes.size || ptys.size !== frozenPanes.size || [...ptys.keys()].some(id => !frozenPanes.has(id))) throw new Error("PTY handover is not ready");
  // This operation must never fall through to the destructive shutdown path.
  // The host exits after the control lease is detached and all local FDs close.
  const epoch = handoverEpoch;
  await currentOwnerRuntime()!.detachForHandover(() => {
    if (!handoverGated || epoch !== handoverEpoch || ptys.size !== frozenPanes.size) throw new Error("PTY handover was cancelled before lease close");
    commit();
  });
  for (const child of ptys.values()) child.detachForHandover();
  shuttingDown = true;
  ptys.clear(); launches.clear(); spawnTimes.clear(); spawnRequests.clear();pendingOwnerExits.clear();
  outputBuffers.clear();
  clearRestoredPanes(); oscCarryBuffers.clear(); closeAllVtPanes();
}
/** All checkpoints are preflighted in the successor before the old host exits.
 * This host still validates before any attach; reading starts only after the
 * VT and opaque core state are installed, using the normal data/exit path. */
export async function restorePtyCorePane(value: unknown, sink: PtyEventSink): Promise<void> {
  const pane = await validateCoreHandoverPart(value);
  if(restoredPanes.has(pane.id)||ptys.has(pane.id)||spawning.size||shuttingDown)throw Error("PTY restore target is not empty");
  if("kind" in pane){
    const owner=await getOwnerRuntime();
    if(pane.ownerExit){
      const native=owner.disconnected.get(pane.id);
      if(native){
        if(!native.exited||native.generation!==pane.ownerExit.generation||native.event!==pane.ownerExit.event)throw Error("Ended native outcome identity changed");
        pendingOwnerExits.set(pane.id,native);owner.disconnected.delete(pane.id);
      }
    }
    outputBuffers.set(pane.id,restoreOutputBuffer(pane.output));holdEndedPane(pane.id,pane.generation,pane.exitCode);return;
  }
  if (ptys.has(pane.id) || spawning.size || shuttingDown) throw new Error("PTY restore target is not empty");
  await restoreVtPane(pane.id, pane.vt, (waiting, dialog) => {
    if (!sink.isDestroyed()) sink.sendPtyEvent(vtStatusEvent(pane.id, waiting, dialog));
  });
  let child: OwnerPty;
  try { child = await OwnerPty.attach(pane.adapter); }
  catch (error) { closeVtPane(pane.id); throw error; }
  ptys.set(pane.id, child); launches.set(pane.id, pane.launch);
  spawnTimes.set(pane.id, pane.spawnedAt); spawnRequests.set(pane.id, pane.request);
  outputBuffers.set(pane.id, restoreOutputBuffer(pane.output, vtPaneReplayModeState(pane.id)));
  if (pane.oscCarry) oscCarryBuffers.set(pane.id, pane.oscCarry);
  restoredPanes.set(pane.id, {generation: (pane.vt.metadata as {generation:string}).generation, attached:false});
  installChildObservers(pane.request, child, sink, () => {});
}

/** Crash-only attach: no spawn, parser/history checkpoint or implicit owner
 * replacement. The caller preflights the complete bootstrap before this loop. */
export async function recoverPtyCorePane(pane:RecoveryPane,sink:PtyEventSink):Promise<void> {
  validateRecoveryLaunch(pane.id,pane.request,pane.launch,pane.spawnedAt);
  if(ptys.has(pane.id)||restoredPanes.has(pane.id)||spawning.size||shuttingDown)throw Error("Recovery target is not empty");
  const owner=await getOwnerRuntime(),actual=owner.disconnected.get(pane.id);
  if(owner.incompatible||!owner.client||!actual||actual.generation!==pane.generation||actual.pid!==pane.pid||actual.startIdentity!==pane.startIdentity)throw Error("Recovery pane identity changed");
  openVtPane(pane.id,actual.cols,actual.rows,()=>{},pane.request.agent,pane.request.agent==='custom'||pane.request.agent===undefined);
  const mirror=vtPanes.get(pane.id)!;
  const screen=(known:boolean)=>{if(!sink.isDestroyed())sink.sendPtyEvent({type:"recovery-screen",ptyId:pane.id,generation:snapshotOf(mirror).generation,known});};
  beginVtRecovery(pane.id,()=>{ptyLog.append("recovery-screen-unknown",{ptyId:pane.id});screen(false);},()=>screen(true));
  let child:OwnerPty;
  try{child=await OwnerPty.attach({pane:actual,process:pane.launch.command,readBytes:0,decoderCarry:""});}
  catch(error){closeVtPane(pane.id);throw error;}
  ptys.set(pane.id,child);launches.set(pane.id,pane.launch);spawnRequests.set(pane.id,pane.request);spawnTimes.set(pane.id,pane.spawnedAt);
  outputBuffers.set(pane.id,{chunks:[],total:0,version:0,end:0,replayModes:initialReplayModeTracker(),replayModesKnown:true});
  restoredPanes.set(pane.id,{generation:snapshotOf(mirror).generation,attached:false});
  if(!actual.exited){child.resize(Math.max(2,actual.cols-1),actual.rows);child.resize(actual.cols,actual.rows);}
  installChildObservers(pane.request,child,sink,()=>{});
  ptyLog.append("crash-pane-attached",{ptyId:pane.id,childPid:child.pid,generation:pane.generation,history:"consumed history lost"});
}

/** Acknowledgement is generation/event scoped, and safe to repeat if the
 * reply was lost after the native ACK. A stale receipt never retires a new ID. */
const retiredOwnerExits=new Map<string,{generation:number;event:number;ownerInstance:string}>();
export async function acknowledgePtyExit(id:string,generation:number,event:number):Promise<"retired"|"unavailable"|"stale"> {
 const owner=currentOwnerRuntime(),retired=retiredOwnerExits.get(id);
 if(retired?.generation===generation&&retired.event===event&&(!owner||retired.ownerInstance===owner.record.instanceId))return "retired";
 if(!owner?.client)return "unavailable";
 const pane=pendingOwnerExits.get(id)??owner.disconnected.get(id);
 if(!pane||!pane.exited||pane.generation!==generation||pane.event!==event)return "stale";
 await owner.retired(pane);
 retiredOwnerExits.delete(id);retiredOwnerExits.set(id,{generation,event,ownerInstance:owner.record.instanceId});
 while(retiredOwnerExits.size>MAX_PTY_PANES)retiredOwnerExits.delete(retiredOwnerExits.keys().next().value!);
 if(pendingOwnerExits.get(id)===pane)pendingOwnerExits.delete(id);
 return "retired";
}

export interface PtyEventSink {
  isDestroyed(): boolean;
  sendPtyEvent(event: PtyEvent): void;
}

function appendToOutputBuffer(ptyId: string, chunk: string): void {
  let buffer = outputBuffers.get(ptyId);
  if (!buffer) {
    buffer = { chunks: [], total: 0, version: 0, end: 0, replayModes: initialReplayModeTracker(), replayModesKnown:true };
    outputBuffers.set(ptyId, buffer);
  }
  buffer.chunks.push(chunk);
  buffer.total += chunk.length;
  buffer.version += 1;
  buffer.end += chunk.length;
  while (buffer.total > OUTPUT_BUFFER_MAX && buffer.chunks.length > 1) {
    const removed = buffer.chunks.shift();
    if (removed) { buffer.total -= removed.length; consumeReplayModes(buffer.replayModes, removed); }
  }
}

export function __testAppendToOutputBuffer(ptyId: string, chunk: string): void {
  appendToOutputBuffer(ptyId, chunk);
}

export function __testClearOutputBuffers(): void {
  outputBuffers.clear();
  clearRestoredPanes();
}

/** Input held for an in-flight spawn: [chunks, bytes]. Empty once any spawn settles, so a test looks while
 *  the spawn is still in flight. */
export function __testPendingWrites(ptyId: string): [number, number] {
  const queued = pendingWrites.get(ptyId) ?? [];
  return [queued.length, queued.reduce((n, s) => n + Buffer.byteLength(s), 0)];
}

export function getBufferedOutput(ptyId: string): string {
  const buffer = outputBuffers.get(ptyId);
  return buffer ? buffer.chunks.join("") : "";
}
/** Full replay begins with the mode state at the first retained byte. */
export function getBufferedReplayOutput(ptyId: string): string {
  const buffer = outputBuffers.get(ptyId);
  return buffer ? (buffer.replayModesKnown ? replayModePrefix(buffer.replayModes) : "") + buffer.chunks.join("") : "";
}

/** A renderer checkpoint is valid only while every byte since B is retained.
 * Counters use cleaned UTF-16 units, just like renderer writes and replay. */
export function getBufferedOutputSince(ptyId: string, offset: number): {chunk: string; reset: boolean} {
  const buffer = outputBuffers.get(ptyId);
  if (!buffer || !Number.isSafeInteger(offset) || offset < buffer.end-buffer.total || offset > buffer.end) {
    return {chunk:getBufferedOutput(ptyId),reset:true};
  }
  return {chunk:buffer.chunks.join("").slice(offset-(buffer.end-buffer.total)),reset:false};
}
function replayOutput(req: SpawnRequest, sink: PtyEventSink): void {
  if (sink.isDestroyed()) return;
  let chunk = getBufferedReplayOutput(req.ptyId);
  ptyLog.append("spawn-replay", {ptyId:req.ptyId,bytes:Buffer.byteLength(chunk)});
  let reset: boolean | undefined;
  if (req.replayAfter) {
    const restored = restoredPanes.get(req.ptyId);
    if (restored) restored.replayToken=req.replayAfter.token;
    const replay = restored?.generation === req.replayAfter.generation
      ? getBufferedOutputSince(req.ptyId,req.replayAfter.offset) : {chunk:getBufferedOutput(req.ptyId),reset:true};
    chunk = replay.reset ? getBufferedReplayOutput(req.ptyId) : replay.chunk; reset = replay.reset;
    if (reset) ptyLog.append("handover-history-from-replay", {ptyId:req.ptyId,reason:"checkpoint boundary unavailable"});
  }
  // An empty replay is still the fence after restoring a captured display.
  if (chunk || req.replayAfter) sink.sendPtyEvent({type:"data",ptyId:req.ptyId,chunk,replay:true,...(outputBuffers.get(req.ptyId)?.replayModesKnown===false?{replayModeUnknown:true}:{}),...(req.replayAfter?.token?{replayToken:req.replayAfter.token}:{}),...(reset !== undefined ? {reset} : {})});
}

/** Strip ANSI escape sequences and control chars so search snippets are
 *  readable. Keeps newlines so line context survives. Exported for unit tests. */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // DCS / PM / APC / SOS (ESC P/X/^/_ … ST) BEFORE OSC, so the OSC rule below
    // can't steal a DCS string's ST terminator and orphan its introducer.
    .replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, "")
    // OSC: terminated by BEL or ST (ESC \). Matching only BEL leaked the title
    // payload of ST-terminated sequences into search snippets.
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

export interface BufferSearchHit {
  ptyId: string;
  /** Cleaned snippet around the first occurrence (~80 chars total). */
  snippet: string;
  /** Position of the match within the cleaned snippet, for highlighting. */
  matchStart: number;
  matchLength: number;
  /** Approximate number of additional occurrences beyond the first. */
  more: number;
}

/** Case-insensitive AND-search over every live PTY buffer: each whitespace token must appear; the snippet
 *  surrounds the earliest-occurring token. */
export function searchPtyOutputs(query: string): BufferSearchHit[] {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return [];
  const hits: BufferSearchHit[] = [];
  for (const [ptyId, buffer] of outputBuffers) {
    // Re-clean only buffers that changed since the last query; while the user
    // types, the typical buffer is static and this is a cache hit.
    let cache = buffer.searchCache;
    if (!cache || cache.version !== buffer.version) {
      const freshCleaned = stripAnsi(buffer.chunks.join(""));
      cache = {
        version: buffer.version,
        cleaned: freshCleaned,
        lower: freshCleaned.toLowerCase(),
      };
      buffer.searchCache = cache;
    }
    const { cleaned, lower } = cache;
    // Every token must be present somewhere.
    const tokenIdxs: Array<{ idx: number; len: number }> = [];
    let allFound = true;
    for (const tok of tokens) {
      const idx = lower.indexOf(tok);
      if (idx < 0) {
        allFound = false;
        break;
      }
      tokenIdxs.push({ idx, len: tok.length });
    }
    if (!allFound) continue;
    // Snippet centered on the earliest-occurring token so the user sees
    // useful context regardless of which word in their query matched first.
    const earliest = tokenIdxs.reduce(
      (best, t) => (t.idx < best.idx ? t : best),
      tokenIdxs[0],
    );
    const start = Math.max(0, earliest.idx - SEARCH_SNIPPET_CONTEXT_BEFORE);
    const end = Math.min(
      cleaned.length,
      earliest.idx + earliest.len + SEARCH_SNIPPET_CONTEXT_AFTER,
    );
    const snippet = cleaned.slice(start, end).replace(/\s+/g, " ").trim();
    const matchStartInSnippet = Math.max(
      0,
      snippet.toLowerCase().indexOf(tokens[tokenIdxs.indexOf(earliest)]),
    );
    // Count additional occurrences of any token across the buffer.
    let more = -1; // we'll add 1 for the highlighted match below
    for (const tok of tokens) {
      let from = 0;
      while (from < lower.length) {
        const next = lower.indexOf(tok, from);
        if (next < 0) break;
        more += 1;
        from = next + tok.length;
        if (more > SEARCH_MAX_COUNT_DISPLAY) break;
      }
      if (more > SEARCH_MAX_COUNT_DISPLAY) break;
    }
    hits.push({
      ptyId,
      snippet,
      matchStart: matchStartInSnippet,
      matchLength: earliest.len,
      more: Math.max(0, more),
    });
  }
  return hits;
}

/** Friendly error reporter - writes a red banner into the terminal and emits
 *  a synthetic exit so the host knows the spawn never happened. */
function reportSpawnFailure(
  sink: PtyEventSink,
  ptyId: string,
  reason: SpawnFailureReason,
  message: string,
): void {
  // Log BEFORE the destroyed-sink bail: the failure happened either way, and
  // a failure nobody could see is exactly what the forensic log is for.
  ptyLog.append("spawn-failed", { ptyId, reason });
  if (sink.isDestroyed()) return;
  const banner = `\r\n\x1b[1;31maya: \x1b[0m\x1b[31m${message}\x1b[0m\r\n\r\n`;
  sink.sendPtyEvent({ type: "spawn-failed", ptyId, reason, detail: message });
  sink.sendPtyEvent({ type: "data", ptyId, chunk: banner });
  if (reason !== "pane-limit-reached") sink.sendPtyEvent({ type: "exit", ptyId, exitCode: COMMAND_NOT_FOUND_EXIT_CODE });
}

const PANE_TERM = "xterm-256color";
export const SPAWN_LOG_COMMAND_MAX_CHARS = 4096;

export async function spawnPty(req: SpawnRequest, sink: PtyEventSink, services: SpawnServices): Promise<void> {
  requireMutableCore();
  if (shuttingDown) {
    // The host is tearing down; a new PTY here would miss the shutdown snapshot
    // and be orphaned on exit. Drop the spawn.
    ptyLog.append("spawn-dropped-shutting-down", { ptyId: req.ptyId });
    return;
  }
  const nativeEnded=pendingOwnerExits.get(req.ptyId);
  if(nativeEnded){
    if(!req.attachOnly&&!req.attachIfReused&&!req.replayAfter)await acknowledgePtyExit(req.ptyId,nativeEnded.generation,nativeEnded.event);
    else if(!sink.isDestroyed()){
      replayOutput(req,sink);sink.sendPtyEvent({type:"exit",ptyId:req.ptyId,exitCode:nativeEnded.exitCode??0,ownerExit:{generation:nativeEnded.generation,event:nativeEnded.event}});return;
    }else return;
  }
  const restored = restoredPanes.get(req.ptyId);
  if (restored?.exitCode !== undefined) {
    if (!req.attachOnly && !req.attachIfReused && !req.replayAfter) {
      // Explicit restart owns this ended record. Keep the otherwise idle owner
      // throughout preparation, but retire the old display/outcome before any
      // replacement view can mistake it for the newly requested session.
      const releaseOwner = currentOwnerRuntime()?.holdRestoration();
      removeRestoredPane(req.ptyId);outputBuffers.delete(req.ptyId);
      oscCarryBuffers.delete(req.ptyId);closeVtPane(req.ptyId);
      try { await spawnPty(req,sink,services); } finally { releaseOwner?.(); }
      return;
    }
    if (!sink.isDestroyed()) {
      replayOutput(req,sink);
      sink.sendPtyEvent({type:"exit",ptyId:req.ptyId,exitCode:restored.exitCode,...(pendingOwnerExits.has(req.ptyId)?{ownerExit:{generation:pendingOwnerExits.get(req.ptyId)!.generation,event:pendingOwnerExits.get(req.ptyId)!.event}}:{})});
      if (restored.attached) {removeRestoredPane(req.ptyId); outputBuffers.delete(req.ptyId);}
    }
    return;
  }
  const owner = currentOwnerRuntime();
  const unavailable = owner?.disconnected.get(req.ptyId);
  if (unavailable || owner?.incompatible) {
    if (!sink.isDestroyed()) {
      if (unavailable?.exited) {
        sink.sendPtyEvent({ type: "exit", ptyId: req.ptyId, exitCode: unavailable.exitCode ?? 0 });
        await owner!.retired(unavailable);
      } else sink.sendPtyEvent({ type: "disconnected", ptyId: req.ptyId });
    }
    return;
  }
  if (pendingKills.has(req.ptyId)) {
    // killPty arrived before this spawn (the renderer closed the tab between
    // mounting and the IPC round-trip). Drop the spawn so we don't orphan a
    // process the user already asked to discard.
    pendingKills.delete(req.ptyId);
    ptyLog.append("spawn-dropped-pending-kill", { ptyId: req.ptyId });
    return;
  }
  if (ptys.has(req.ptyId)) {
    // Already running - this is a re-mount (Vite HMR or a React double-mount).
    // Don't spawn again; replay the buffered output so the freshly-created
    // xterm.js can repaint the existing scrollback. The PTY's own onData
    // continues to deliver new bytes to the renderer.
    replayOutput(req,sink);
    if (!sink.isDestroyed() && restored && !req.replayAfter) restored.attached = true;
    await services.replay?.(spawnRequests.get(req.ptyId) ?? req, ptys.get(req.ptyId)!.pid, spawnTimes.get(req.ptyId) ?? Date.now(), sink);
    return;
  }
  const inFlight = spawning.get(req.ptyId);
  if (inFlight && !inFlight.cancelled) {
    // A spawn for this id is already in flight (a concurrent re-mount got here
    // first, before it could register its PTY). Bail BEFORE the attachOnly
    // branch: the in-flight spawn owns the session and will stream to the
    // renderer, so emitting no-session here would falsely strand the tab as
    // stopped. (Checked before attachOnly so the host is robust regardless of
    // the renderer's confirmed-output gating.)
    ptyLog.append("spawn-dropped-in-flight", { ptyId: req.ptyId });
    return;
  }
  if (inFlight) {
    // The flight was killed (a restart: kill, then spawn the same id) but is
    // still in its preflight. Dropping this spawn would leave the tab with no
    // process and no event. Take the id over now, so a later kill cancels THIS
    // spawn and a re-mount meanwhile is dropped, wait for the old flight to
    // return, then start over from the top.
    await takeOverCancelledFlight(req, sink, inFlight, services);
    return;
  }
  if (req.attachOnly) {
    // Re-mount of a tab that already ran this session, but its PTY is gone (the
    // process died while the host stayed up). Don't silently start a fresh
    // process - tell the renderer so it can show a stopped/restartable state.
    ptyLog.append("no-session", { ptyId: req.ptyId });
    if (!sink.isDestroyed()) {
      sink.sendPtyEvent({ type: "no-session", ptyId: req.ptyId });
    }
    return;
  }
  const cwd = path.resolve(req.cwd.replace(/^~/, os.homedir()));

  try {
    const stat = fs.statSync(cwd);
    if (!stat.isDirectory()) {
      reportSpawnFailure(
        sink,
        req.ptyId,
        "cwd-not-directory",
        `not a directory: ${cwd}\nEdit the project to fix this, or close it.`,
      );
      return;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      reportSpawnFailure(
        sink,
        req.ptyId,
        "cwd-missing",
        `directory does not exist: ${cwd}\nClose the project (top-bar ✕) to clean up.`,
      );
      return;
    }
    reportSpawnFailure(
      sink,
      req.ptyId,
      "cwd-unreadable",
      `cannot read ${cwd}: ${String(err)}`,
    );
    return;
  }

  // Mark this id in-flight across the async preflight + spawn so a concurrent
  // call bails at the guard above. (The bail itself lives before the attachOnly
  // branch; here we only claim the marker, synchronously before the first await
  // so no racing call can interleave before it is set.)
  const [flight, settleFlight] = newFlight();
  spawning.set(req.ptyId, flight);
  const cancelled = (): boolean => {
    if (flight.cancelled) ptyLog.append("spawn-cancelled", { ptyId: req.ptyId });
    return flight.cancelled;
  };
  try {
    const prepared = await services.prepare(req, cwd, flight.abort.signal);
    if (cancelled() || shuttingDown) return;
    if ("failure" in prepared) {
      reportSpawnFailure(sink, req.ptyId, prepared.failure.reason, prepared.failure.message);
      return;
    }
    const { command, env, launch, ownSessionId } = prepared;
    const [file, ...args] = prepared.argv;

    let child: OwnerPty;
    try {
      child = await OwnerPty.spawn({ id: req.ptyId, command: file, argv: [file, ...args],
        cols: Math.max(req.cols, MIN_PTY_COLS), rows: Math.max(req.rows, MIN_PTY_ROWS), cwd, env: { ...env, TERM: PANE_TERM, PWD: cwd } });
    } catch (err) {
      if (currentOwnerRuntime()?.incompatible) {
        if (!sink.isDestroyed()) sink.sendPtyEvent({ type: "disconnected", ptyId: req.ptyId });
        return;
      }
      if ((err as {code?:string})?.code === "OWNER_REJECTED" && (err as Error).message === "Pane limit reached") {
        reportSpawnFailure(sink, req.ptyId, "pane-limit-reached", paneLimitFailureMessage());
        return;
      }
      reportSpawnFailure(
        sink,
        req.ptyId,
        "node-pty-spawn-error",
        `failed to spawn: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    if (cancelled() || shuttingDown) {
      // Shutdown began during our async preflight, after the snapshot was taken.
      // Registering now would orphan this child, and a scheduled escalation might
      // not fire before the host exits - so force-kill it synchronously (the
      // SIGKILL syscall dooms it regardless of the host's remaining lifetime).
      child.onExit(({ exitCode }) => {
        ptyLog.append("exit", { ptyId: req.ptyId, exitCode, killed: true });
      });
      try {
        child.kill();
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      ptyLog.append("spawn-killed-on-shutdown", { ptyId: req.ptyId });
      await child.closed;
      return;
    }

    ptys.set(req.ptyId, child);
    launches.set(req.ptyId, launch);
    spawnTimes.set(req.ptyId, prepared.spawnedAt);
    spawnRequests.set(req.ptyId, { ...req });
    // Replay anything typed during the spawn window, in order, before the pane
    // takes live input. Writes arriving after this point find the PTY through
    // `ptys` on the normal path, so there is no gap between flush and cleanup.
    const queued = pendingWrites.get(req.ptyId);
    const flushed: Promise<void>[] = [];
    if (queued?.length) {
      pendingWrites.delete(req.ptyId);
      ptyLog.append("pending-write-flush", {
        ptyId: req.ptyId,
        chunks: queued.length,
      });
      // PTY input is the user's own shell input; no code-injection boundary.
      for (const chunk of queued) flushed.push(child.writeAsync(chunk)); // lgtm[js/code-injection]
    }
    // Mirror of the pane's screen, used to tell what it SHOWS (see vt-state.ts).
    // Fires on both edges, so a prompt appearing AND being answered both
    // reach the renderer.
    (services.openMirror ?? openVtPane)(
      req.ptyId,
      req.cols,
      req.rows,
      (waiting, dialog) => {
        if (sink.isDestroyed()) return;
        sink.sendPtyEvent(vtStatusEvent(req.ptyId, waiting, dialog));
      },
      req.agent,
      prepared.argv[4]?.includes("env -u EDITOR -u VISUAL $SHELL") ?? false,
    );
    // The command is logged verbatim: it is the single most diagnostic field
    // (e.g. did this respawn carry --continue?), and it is already stored in
    // plaintext in ~/.aya/presets.json - the log adds no new exposure.
    ptyLog.append("spawn", {
      ptyId: req.ptyId,
      childPid: child.pid,
      projectSlug: req.projectSlug,
      presetId: req.presetId,
      cwd,
      command: command.slice(0, SPAWN_LOG_COMMAND_MAX_CHARS),
    });


    // Known before the CLI writes anything, so a restart before its first message resumes it.
    if (ownSessionId) sink.sendPtyEvent({ type: "osc-session", ptyId: req.ptyId, sessionId: ownSessionId });
    const stopSessionWatch = services.opened?.(req, child.pid, prepared, sink) ?? (() => {});

    installChildObservers(req, child, sink, stopSessionWatch);
    await Promise.all(flushed);
  } finally {
    // A restart may have taken the id over while this (cancelled) spawn was in
    // preflight: the entry and any input queued since belong to it then.
    if (spawning.get(req.ptyId) === flight) {
      spawning.delete(req.ptyId);
      // Covers every early return above (preflight failure, spawn error,
      // shutdown): the spawn window is over, so nothing may keep holding input
      // for it. On the success path the flush already emptied this.
      endSpawnWindow(req.ptyId);
    }
    settleFlight();
  }
}


// Both spawn and validated restore install exactly the same byte/exit path.
function installChildObservers(req: SpawnRequest, child: OwnerPty, sink: PtyEventSink, stopSessionWatch: () => void): void {
    child.onExit(({ exitCode, signal }) => {
      stopSessionWatch();
      if (ptys.get(req.ptyId) !== child) {
        return;
      }
      const nativeExit=child.exitReceipt?.()??null;
      const deferredExit=currentOwnerRuntime()?.deferredExitAcknowledgements&&nativeExit;
      if(deferredExit)pendingOwnerExits.set(req.ptyId,nativeExit);
      ptys.delete(req.ptyId);
      launches.delete(req.ptyId);
      spawnTimes.delete(req.ptyId);
      spawnRequests.delete(req.ptyId);
      if (handoverGated && ineligiblePanes.has(req.ptyId) && !restoredPanes.has(req.ptyId)) restoredPanes.set(req.ptyId,{generation:"ended-ineligible",attached:false});
      const origin = restoredPanes.get(req.ptyId);
      const pendingAttach = origin && !origin.attached ? origin : undefined;
      if (!pendingAttach) removeRestoredPane(req.ptyId);
      if (pendingAttach) {pendingAttach.exitCode = exitCode;pendingAttach.releaseOwner??=currentOwnerRuntime()?.holdRestoration();}
      else outputBuffers.delete(req.ptyId);
      oscCarryBuffers.delete(req.ptyId);
      closeVtPane(req.ptyId);
      // Record the signal on this NON-host-initiated death (#83): when every
      // console dies at once with the host alive, `signal: 9` (SIGKILL) points
      // at an OS jetsam/memory-pressure kill, distinct from a graceful exit or
      // a host-initiated kill. Absence of any exit line at all, meanwhile,
      // means the renderer reloaded and cold-respawned rather than dying.
      ptyLog.append("exit", { ptyId: req.ptyId, exitCode, signal });
      if ((pendingAttach && !pendingAttach.replayToken) || sink.isDestroyed()) return;
      sink.sendPtyEvent({ type: "exit", ptyId: req.ptyId, exitCode,...(deferredExit?{ownerExit:{generation:deferredExit.generation,event:deferredExit.event}}:{}) });
    });
    child.onData((chunk) => {
      // Strip Aya's OSC 9001 vocabulary (integrations.md) before anything
      // downstream sees this chunk: the agent's visible output, the replay
      // buffer, and search must never contain raw escape-sequence noise, and
      // must reflect the exact bytes xterm.js renders.
      const carry = oscCarryBuffers.get(req.ptyId) ?? "";
      const extracted = extractAyaOsc(chunk, carry);
      if (extracted.carry) {
        oscCarryBuffers.set(req.ptyId, extracted.carry);
      } else if (carry) {
        oscCarryBuffers.delete(req.ptyId);
      }
      appendToOutputBuffer(req.ptyId, extracted.cleaned);
      // Same bytes the renderer's xterm will draw, so the mirror matches what
      // the user sees.
      writeVtPane(req.ptyId, extracted.cleaned);
      if (sink.isDestroyed()) return;
      sink.sendPtyEvent({ type: "data", ptyId: req.ptyId, chunk: extracted.cleaned });
      for (const event of extracted.events) {
        const status = parseAyaOscStatus(event);
        if (status) {
          sink.sendPtyEvent({
            type: "osc-status",
            ptyId: req.ptyId,
            level: status.level,
            text: status.text,
            updatedAt: Date.now(),
          });
          continue;
        }
        const sessionId = parseAyaOscSession(event);
        if (sessionId) {
          sink.sendPtyEvent({ type: "osc-session", ptyId: req.ptyId, sessionId });
        }
      }
    });

}

/** Drop input held for a spawn window that is over; a live PTY means the flush
 *  ran, anything else discarded the queue. */
function endSpawnWindow(ptyId: string): void {
  pendingWrites.delete(ptyId);
  settleSpawnWaiters(ptyId, ptys.has(ptyId));
}

async function takeOverCancelledFlight(
  req: SpawnRequest,
  sink: PtyEventSink,
  prior: SpawnFlight,
  services: SpawnServices,
): Promise<void> {
  const [flight, settleFlight] = newFlight();
  spawning.set(req.ptyId, flight);
  ptyLog.append("spawn-waits-cancelled", { ptyId: req.ptyId });
  try {
    await prior.done;
  } finally {
    if (spawning.get(req.ptyId) === flight) spawning.delete(req.ptyId);
    settleFlight();
  }
  if (flight.cancelled) {
    // Killed again while waiting (the tab closed after all): start nothing.
    ptyLog.append("spawn-cancelled", { ptyId: req.ptyId });
    if (!spawning.has(req.ptyId)) endSpawnWindow(req.ptyId);
    return;
  }
  // Synchronous up to its first await, so nothing interleaves between the
  // delete above and it claiming the id again; input typed while this waited
  // stays queued for it.
  await spawnPty(req, sink, services);
  // An early return before its claim (attach-only, bad cwd) leaves no window
  // to flush the queue; unless a newer spawn owns the id by now, end it here.
  if (!spawning.has(req.ptyId)) endSpawnWindow(req.ptyId);
}

/** True while a spawn for this id is in its preflight and not cancelled: the
 *  pane has no PTY yet, but it is coming. */
export function isPtyStarting(ptyId: string): boolean {
  const flight = spawning.get(ptyId);
  return flight !== undefined && !flight.cancelled;
}

export function getPtyLaunch(ptyId: string): PaneLaunch | null {
  return launches.get(ptyId) ?? null;
}

/** The PTY's current size and whether its screen is the alternate one; null
 *  once the pane is gone. */
export function getPtySize(ptyId: string): PaneSize | null {
  const p = ptys.get(ptyId);
  return p ? { cols: p.cols, rows: p.rows, alt: vtPaneAltScreen(ptyId) } : null;
}

export function getPtyPid(ptyId: string): number | null | undefined {
  const connected = ptys.get(ptyId)?.pid;
  if (connected) return connected;
  const pane = currentOwnerRuntime()?.disconnected.get(ptyId);
  return pane && !pane.exited ? pane.pid : currentOwnerRuntime()?.incompatible ? undefined : null;
}

/** Write to a PTY; false means it went NOWHERE (dead id, queue at cap, failed
 *  spawn). Async but holds NO `await`, so `p.write` keeps its place in order. */
export async function writePty(ptyId: string, data: string, fence?: VtSnapshotFence, additionalFence?:()=>void): Promise<boolean> {
  requireMutableCore();
  const p = ptys.get(ptyId);
  const checkFence = fence === undefined ? undefined : () => {
    if (!p || ptys.get(ptyId) !== p || !validVtSnapshotFence(fence) || !vtSnapshotMatches(ptyId, fence)) throw Object.assign(
      new Error("The terminal screen changed. This input was not sent."), {code: "PTY_HOST_STALE_REVISION"});
  };
  const check = fence === undefined ? additionalFence : () => { checkFence?.(); additionalFence?.(); };
  check?.();
  if (!p) {
    // No PTY yet, but one is on its way: hold the input rather than discard it.
    // Anything else (an exited or unknown id) still drops, as before.
    if (spawning.has(ptyId)) {
      if (!bufferPendingWrite(ptyId, data)) return false;
      // Queued is not delivered: answer only once the spawn settles.
      return new Promise<boolean>((resolve) => {
        const waiters = spawnWaiters.get(ptyId) ?? [];
        waiters.push(resolve);
        spawnWaiters.set(ptyId, waiters);
      });
    }
    return false;
  }
  // Writing to the user's own PTY is the whole point of a terminal: the
  // "user-provided value" is their own keystrokes going to their own shell, so
  // there is no trust boundary to cross. Not exploitable code injection.
  await p.writeAsync(data, check); // lgtm[js/code-injection]
  return true;
}

/** Queue input for an in-flight spawn, capped at PENDING_WRITE_MAX_BYTES. False when the chunk
 *  was not queued WHOLE: a cut paste would leave the pane mid-paste. */
function bufferPendingWrite(ptyId: string, data: string): boolean {
  const queued = pendingWrites.get(ptyId) ?? [];
  const used = queued.reduce((n, s) => n + Buffer.byteLength(s), 0);
  const bytes = Buffer.byteLength(data);
  if (bytes > PENDING_WRITE_MAX_BYTES - used) {
    ptyLog.append("pending-write-dropped", { ptyId, bytes });
    return false;
  }
  queued.push(data);
  pendingWrites.set(ptyId, queued);
  return true;
}

export function resizePty(ptyId: string, cols: number, rows: number): void {
  requireMutableCore();
  const p = ptys.get(ptyId);
  if (!p) return;
  resizeVtPane(ptyId, cols, rows);
  try {
    p.resize(Math.max(cols, MIN_PTY_COLS), Math.max(rows, MIN_PTY_ROWS));
  } catch {
    // ignore - pty may have just exited
  }
}

/** Kill a PTY child, escalating to SIGKILL (`claude --chrome` ignores TERM and
 *  would orphan). `schedule` is injectable so tests can drive that step. */
export function terminatePtyChild(
  p: Pick<PtyModule.IPty, "kill">,
  schedule: (fn: () => void, ms: number) => void = setTimeout,
): void {
  try {
    p.kill();
  } catch {
    // already gone
  }
  schedule(() => {
    try {
      p.kill("SIGKILL");
    } catch {
      // already exited - nothing to force-kill
    }
  }, KILL_ESCALATE_MS);
}

export async function killPty(ptyId: string): Promise<void> {
  requireMutableCore();
  const operation = killPtyInternal(ptyId);
  killing.add(operation);
  try { await operation; } finally { killing.delete(operation); }
}
async function killPtyInternal(ptyId: string): Promise<void> {
  const pendingExit=pendingOwnerExits.get(ptyId);
  if(pendingExit){await acknowledgePtyExit(ptyId,pendingExit.generation,pendingExit.event);removeRestoredPane(ptyId);outputBuffers.delete(ptyId);oscCarryBuffers.delete(ptyId);closeVtPane(ptyId);return;}
  const endedRestoration = restoredPanes.get(ptyId)?.exitCode !== undefined;
  removeRestoredPane(ptyId);
  outputBuffers.delete(ptyId);
  oscCarryBuffers.delete(ptyId);
  closeVtPane(ptyId);
  const p = ptys.get(ptyId);
  ptyLog.append("kill", { ptyId, live: !!p });
  if (!p) {
    if (currentOwnerRuntime()?.disconnected.has(ptyId)) { await currentOwnerRuntime()!.killDisconnected(ptyId); return; }
    // No PTY for this id yet. A spawn under way is cancelled on its own entry
    // (no marker: ids are reused, and a reopened tab must start). One whose
    // IPC has not arrived yet bails on the marker, which a TTL evicts if
    // nothing comes (cleaner than leaking ids).
    const flight = spawning.get(ptyId);
    if (flight) {
      flight.cancelled = true;
      flight.abort.abort();
      // What was typed into the killed spawn goes nowhere, even if a restart
      // takes the id over before this spawn returns.
      endSpawnWindow(ptyId);
      return;
    }
    // A known ended restoration has no late native spawn to cancel. Do not
    // let a marker swallow a subsequent explicit restart of this same id.
    if (endedRestoration) return;
    pendingKills.add(ptyId);
    setTimeout(() => pendingKills.delete(ptyId), PENDING_KILL_TTL_MS);
    return;
  }
  // Remove from the map first (a re-mount/respawn should not attach to a dying
  // PTY), then terminate with SIGKILL escalation so a signal-ignoring child
  // can't survive and get orphaned.
  ptys.delete(ptyId);
  launches.delete(ptyId);
  spawnTimes.delete(ptyId);
  spawnRequests.delete(ptyId);
  // The spawn-time onExit skips its "exit" append once the map entry is gone
  // (its identity guard exists so a respawn under the same id is not wrongly
  // torn down) - so log the killed child's actual exit here, or the forensic
  // trail shows a kill with no evidence the child ever died (#88).
  p.onExit(({ exitCode }) => {
    ptyLog.append("exit", { ptyId, exitCode, killed: true });
  });
  terminatePtyChild(p);
  let timer: NodeJS.Timeout | undefined;
  try { await Promise.race([p.closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("The terminal could not confirm its exit. Its native owner inventory was kept; check it before restarting.")), 5000); })]); }
  finally { clearTimeout(timer); }
  if(currentOwnerRuntime()?.deferredExitAcknowledgements)await p.acknowledgeExit();
}

/** Graceful signal to each child, `onDone` exactly once when the last exits, SIGKILL for survivors at the
 *  KILL_ESCALATE_MS deadline. Split out (injectable `schedule`) so the ladder is testable with fake children. */
export function shutdownChildren(
  children: Array<Pick<PtyModule.IPty, "kill" | "onExit">>,
  onDone: () => void,
  schedule: (fn: () => void, ms: number) => void = setTimeout,
): void {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    onDone();
  };

  if (children.length === 0) {
    // Defer so a caller returning a response can flush before the process exits.
    schedule(finish, 0);
    return;
  }

  let remaining = children.length;
  const settleOne = () => {
    remaining -= 1;
    if (remaining <= 0) finish();
  };

  for (const p of children) {
    try {
      p.onExit(() => settleOne());
    } catch {
      // Can't observe this child's exit - let the deadline cover it.
    }
    try {
      p.kill(); // graceful first; a well-behaved child exits and triggers onExit
    } catch {
      settleOne(); // already gone - counts as settled
    }
  }

  schedule(() => {
    for (const p of children) {
      try {
        p.kill("SIGKILL");
      } catch {
        // already exited - nothing to force-kill
      }
    }
    finish();
  }, KILL_ESCALATE_MS);
}

/** Shut down every live PTY: drain the map, then graceful-kill-with-escalation
 *  via shutdownChildren. Used by the host's shutdown path. */
export function shutdownPtyChildren(
  onDone: () => void,
  schedule: (fn: () => void, ms: number) => void = setTimeout,
): void {
  // Block any further spawns (including one mid-preflight) from escaping the
  // snapshot below and getting orphaned when the host exits.
  shuttingDown = true;
  for (const flight of spawning.values()) { flight.cancelled = true; flight.abort.abort(); }
  const entries = [...ptys.entries()];
  const children = entries.map(([, child]) => child);
  ptyLog.append("children-shutdown", { children: children.length });
  // Same identity-guard gap as killPty: the map is cleared below, so the
  // spawn-time onExit never logs these deaths. Log each child's exit (with
  // code) from here so a mass shutdown leaves a per-child trail (#88).
  for (const [ptyId, child] of entries) {
    child.onExit(({ exitCode }) => {
      ptyLog.append("exit", { ptyId, exitCode, killed: true });
    });
  }
  ptys.clear();
  spawnTimes.clear();
  spawnRequests.clear();
  launches.clear();
  outputBuffers.clear();
  clearRestoredPanes();
  oscCarryBuffers.clear();
  closeAllVtPanes();
  pendingKills.clear();
  shutdownChildren(children, onDone, schedule);
}

/** A bounded complete live manifest for an authenticated replacement main.
 * A pending spawn/exit or unsupported opaque record refuses credential export;
 * it never guesses a launch or alters a running pane. */
export function ptyOwnerContinuityPanes(inventory:OwnerPane[]):RecoveryPane[] {
  if(shuttingDown||handoverGated||spawning.size||inventory.length>MAX_PTY_PANES||inventory.length!==ptys.size||new Set(inventory.map(p=>p.id)).size!==inventory.length)throw Error("Terminal recovery manifest is not stable");
  return inventory.map(p=>{
    const child=ptys.get(p.id),request=spawnRequests.get(p.id),launch=launches.get(p.id),spawnedAt=spawnTimes.get(p.id),identity=child?.recoveryIdentity();
    if(p.exited||p.acknowledged||!p.startIdentity||!child||!request||!launch||spawnedAt===undefined||!identity||identity.generation!==p.generation||identity.pid!==p.pid||identity.startIdentity!==p.startIdentity)throw Error("Terminal recovery manifest is incomplete");
    return {id:p.id,generation:p.generation,pid:p.pid,startIdentity:p.startIdentity,request:{...request},launch:{...launch},spawnedAt};
  });
}

export function restoredPtyLaunches():Array<{req:SpawnRequest;pid:number;cwd:string;spawnedAt:number}> {
  return [...restoredPanes.keys()].flatMap(id=>{
    const child=ptys.get(id),req=spawnRequests.get(id);
    return child&&req?[{req,pid:child.pid,cwd:launches.get(id)?.cwd??req.cwd,spawnedAt:spawnTimes.get(id)??Date.now()}]:[];
  });
}

export function hasUnattachedRestoredPanes():boolean {return [...restoredPanes.values()].some(p=>!p.attached);}

export function activePtyCount(): number {
  return ptys.size + [...(currentOwnerRuntime()?.disconnected.values() ?? [])].filter(pane => !pane.exited && !ptys.has(pane.id)).length;
}

/** Only an applied renderer replay releases the pending restoration. */
export function acknowledgePtyRestoration(id:string,generation:string,token?:string):boolean {
 const p=restoredPanes.get(id);
 if(!p||p.generation!==generation||p.replayToken!==token)return false;
 p.attached=true;
 if(p.exitCode!==undefined){removeRestoredPane(id);outputBuffers.delete(id);}
 return true;
}

export function ptyRecoveryStates():Array<{id:string;generation:string;exitCode?:number}>{
 return [...restoredPanes].map(([id,p])=>({id,generation:p.generation,...(p.exitCode!==undefined?{exitCode:p.exitCode}:{})}));
}
