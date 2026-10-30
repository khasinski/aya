// Main-only absence proof. The diagnostic registry helper deliberately omits
// unknown processes; an empty diagnostic list is never permission to spawn.
import fs from "node:fs";
import path from "node:path";
import {AYA_HOME} from "./pty-host-paths";
import {readProcInfo,readProcInfoAsync,type ProcInfo} from "./pty-host-registry";

export type HostCreationState = "gone" | "alive" | "unknown";
export interface HostCreationProof {state: HostCreationState; hosts: Array<{pid: number; startTime: string; state: HostCreationState}>}
export class HostCreationBlockedError extends Error {
  readonly code="PTY_HOST_START_BLOCKED";
  readonly proof:HostCreationProof;
  constructor(proof:HostCreationProof){super(proof.state==="unknown"
    ? "The terminal host inventory is unknown; another host was not started."
    : "A terminal host is still running; another host was not started.");this.proof={state:proof.state,hosts:proof.hosts};}
}
const same=(a:fs.Stats,b:fs.Stats):boolean=>a.dev===b.dev&&a.ino===b.ino;
function privateJson(file:string,maxBytes:number):{value:unknown;stat:fs.Stats}{
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try{
    const stat=fs.fstatSync(fd);
    if(!stat.isFile()||stat.uid!==process.getuid?.()||(stat.mode&0o7777)!==0o600||stat.nlink!==1||stat.size<1||stat.size>maxBytes)throw Error("unknown record");
    const bytes=Buffer.alloc(stat.size);let offset=0;
    while(offset<bytes.length){const count=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);if(!count)throw Error("short record");offset+=count;}
    const after=fs.fstatSync(fd);
    if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs||!same(stat,fs.lstatSync(file)))throw Error("changed record");
    return {value:JSON.parse(bytes.toString("utf8")) as unknown,stat};
  }finally{fs.closeSync(fd);}
}
function record(file:string,name:string):{pid:number;startTime:string;stat:fs.Stats}{
    const {value:raw,stat}=privateJson(file,4096);
    const value=raw as {pid?:unknown;pgid?:unknown;startTime?:unknown};
    if(!value||typeof value!=="object"||!Number.isSafeInteger(value.pid)||Number(value.pid)<2||Number(value.pid)>0x7fffffff||
      value.pgid!==value.pid||name!==`${value.pid}.json`||typeof value.startTime!=="string"||!value.startTime||value.startTime.length>128)throw Error("invalid record");
    return {pid:Number(value.pid),startTime:value.startTime,stat};
}
/** What the proof read from disk before probing any process, and the facts its re-check compares against. */
interface CreationInventory {
  entries:Array<{pid:number;startTime:string}>;snapshots:Array<{file:string;stat:fs.Stats}>;unknown:boolean;
  directory:string;directoryStat?:fs.Stats;directoryAbsent:boolean;names:string[];
  ownerFile:string;ownerParent?:fs.Stats;ownerParentAbsent:boolean;ownerAbsent:boolean;
}
const absent=(error:unknown):boolean=>(error as NodeJS.ErrnoException).code==="ENOENT";
function readCreationInventory(directory:string,ownerFile:string):CreationInventory{
  const inventory:CreationInventory={entries:[],snapshots:[],unknown:false,directory,directoryAbsent:false,names:[],ownerFile,ownerParentAbsent:false,ownerAbsent:false};
  try{inventory.directoryStat=fs.lstatSync(directory);}catch(error){if(absent(error))inventory.directoryAbsent=true;else inventory.unknown=true;}
  const stat=inventory.directoryStat;
  if(stat&&(!stat.isDirectory()||stat.uid!==process.getuid?.()||(stat.mode&0o022)))inventory.unknown=true;
  else if(stat)inventory.names=fs.readdirSync(directory).sort();
  for(const name of inventory.names){
    try{
      const file=path.join(directory,name),entry=record(file,name);inventory.snapshots.push({file,stat:entry.stat});
      inventory.entries.push({pid:entry.pid,startTime:entry.startTime});
    }catch{inventory.unknown=true;}
  }
  // A non-group-leading JS host may have no host-registry record, but its
  // stable owner still records the reader. Never ignore that evidence.
  try{
    const parent=fs.lstatSync(path.dirname(ownerFile));inventory.ownerParent=parent;
    if(!parent.isDirectory()||parent.uid!==process.getuid?.()||(parent.mode&0o077))throw Error("unsafe owner directory");
    try{
      const {value,stat:ownerStat}=privateJson(ownerFile,65536),r=value as {jsPid?:unknown;jsStartTime?:unknown};
      if(!r||typeof r!=="object"||!Number.isSafeInteger(r.jsPid)||Number(r.jsPid)<2||Number(r.jsPid)>0x7fffffff||typeof r.jsStartTime!=="string"||!r.jsStartTime||r.jsStartTime.length>128)throw Error("unknown reader");
      inventory.entries.push({pid:Number(r.jsPid),startTime:r.jsStartTime});inventory.snapshots.push({file:ownerFile,stat:ownerStat});
    }catch(error){if(absent(error))inventory.ownerAbsent=true;else inventory.unknown=true;}
  }catch(error){if(absent(error)&&!inventory.ownerParent)inventory.ownerParentAbsent=true;else inventory.unknown=true;}
  return inventory;
}
/** Microseconds of lstat/readdir, no process spawn: true only while every record, the registry listing and the owner
 *  record are exactly what readCreationInventory saw (and what was absent is still absent). */
function inventoryUnchanged(inventory:CreationInventory):boolean{
  try{
    const missing=(file:string)=>{try{fs.lstatSync(file);return false;}catch(error){if(absent(error))return true;throw error;}};
    if(inventory.directoryAbsent&&!missing(inventory.directory))return false;
    const stat=inventory.directoryStat;
    if(stat&&(!same(stat,fs.lstatSync(inventory.directory))||JSON.stringify(inventory.names)!==JSON.stringify(fs.readdirSync(inventory.directory).sort())))return false;
    const ownerDirectory=path.dirname(inventory.ownerFile);
    if(inventory.ownerParentAbsent&&!missing(ownerDirectory))return false;
    if(inventory.ownerParent&&!same(inventory.ownerParent,fs.lstatSync(ownerDirectory)))return false;
    if(inventory.ownerAbsent&&!missing(inventory.ownerFile))return false;
    for(const snapshot of inventory.snapshots){
      const after=fs.lstatSync(snapshot.file),before=snapshot.stat;
      if(!same(before,after)||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||before.mode!==after.mode||before.uid!==after.uid)return false;
    }
    return true;
  }catch{return false;}
}
function stateOf(entry:{startTime:string},observe:()=>ProcInfo):HostCreationState{
  try{
    const info=observe();
    if(!info.probeFailed){if(!info.alive)return "gone";if(info.startTime)return info.startTime===entry.startTime?"alive":"gone";}
  }catch{/* Unknown remains unknown. */}
  return "unknown";
}
function proofOf(inventory:CreationInventory,states:HostCreationState[],unchanged:boolean):HostCreationProof{
  const hosts=inventory.entries.map((entry,index)=>({...entry,state:states[index]??"unknown" as HostCreationState}));
  const unknown=inventory.unknown||!unchanged||hosts.some(host=>host.state==="unknown");
  return {state:unknown?"unknown":hosts.some(host=>host.state==="alive")?"alive":"gone",hosts};
}
const DEFAULT_DIRECTORY=()=>path.join(AYA_HOME,"pty-hosts");
const ownerFileFor=(directory:string)=>path.join(path.dirname(directory),"pty-owner","record.json");
export function hostCreationProof(directory=DEFAULT_DIRECTORY(),probe:(pid:number)=>ProcInfo=readProcInfo,
  ownerFile=ownerFileFor(directory)):HostCreationProof{
  let inventory:CreationInventory|undefined;
  try{
    inventory=readCreationInventory(directory,ownerFile);
    const states=inventory.entries.map(entry=>stateOf(entry,()=>probe(entry.pid)));
    return proofOf(inventory,states,inventoryUnchanged(inventory));
  }catch{return {state:"unknown",hosts:inventory?proofOf(inventory,[],false).hosts:[]};}
}
/** A proof whose process probes ran off the event loop, plus the cheap re-check that makes it usable at the fork. */
export interface HostCreationPermit extends HostCreationProof {
  /** Synchronous and spawn-free (lstat/readdir only). The proof's "gone" verdicts are monotonic: a recorded
   *  (pid, start time) that was dead or reused cannot come back, and a new or rewritten record changes the inventory.
   *  So "gone" here, with no await before the action, is what a fresh synchronous proof would say. */
  confirm():HostCreationProof;
}
/** hostCreationProof without blocking main: the same records, the same fail-closed states, each ps awaited. The
 *  answer must be confirmed with permit.confirm() immediately before the fork it permits. */
export async function hostCreationPermit(directory=DEFAULT_DIRECTORY(),probe:(pid:number)=>ProcInfo|Promise<ProcInfo>=readProcInfoAsync,
  ownerFile=ownerFileFor(directory)):Promise<HostCreationPermit>{
  let inventory:CreationInventory;
  try{inventory=readCreationInventory(directory,ownerFile);}
  catch{const proof:HostCreationProof={state:"unknown",hosts:[]};return {...proof,confirm:()=>proof};}
  const states:HostCreationState[]=[];
  for(const entry of inventory.entries){
    let info:ProcInfo|undefined;
    try{info=await probe(entry.pid);}catch{/* Unknown remains unknown. */}
    states.push(info?stateOf(entry,()=>info):"unknown");
  }
  const proof=proofOf(inventory,states,inventoryUnchanged(inventory));
  return {...proof,confirm:()=>proof.state==="gone"&&!inventoryUnchanged(inventory)?proofOf(inventory,states,false):proof};
}
// The sync form: startHost without a permit (tests, scripts) and the fallback. Per call ~2-4 ms of ps per record.
export function assertHostCreationSafe(permit?:HostCreationPermit):void{
  const proof=permit?permit.confirm():hostCreationProof();if(proof.state!=="gone")throw new HostCreationBlockedError(proof);
}


export const HOST_SHUTDOWN_GRACE_MS=3000;
interface ShutdownWaitDeps {
  now:()=>number;
  proof:()=>HostCreationProof|Promise<HostCreationProof>;
  socketMissing:()=>boolean;
  wait:(milliseconds:number,signal?:AbortSignal)=>Promise<void>;
}
/** Absence of a socket is not absence of its process. Give an already-exiting,
 * verified host a short grace period; the normal final pre-fork proof remains. */
export async function waitForHostShutdown(socketPath:string,signal?:AbortSignal,overrides:Partial<ShutdownWaitDeps>={}):Promise<void>{
  const now=overrides.now??Date.now,deadline=now()+HOST_SHUTDOWN_GRACE_MS;
  const cancelled=()=>{if(signal?.aborted)throw Error("PTY host startup was cancelled");};
  // Informational: whatever this answers, startHost's own permit is confirmed again right before the fork.
  const proof=overrides.proof??(()=>hostCreationPermit(undefined,pid=>{
    const remaining=deadline-now();
    return remaining<=0||signal?.aborted?{alive:false,probeFailed:true,startTime:null,command:null}:readProcInfoAsync(pid,Math.max(1,remaining));
  }));
  const missing=overrides.socketMissing??(()=>{try{fs.lstatSync(socketPath);return false;}catch(error){return (error as NodeJS.ErrnoException).code==="ENOENT";}});
  const wait=overrides.wait??((milliseconds:number,cancel?:AbortSignal)=>new Promise<void>((resolve,reject)=>{
    const abort=()=>{clearTimeout(timer);cancel?.removeEventListener("abort",abort);reject(Error("PTY host startup was cancelled"));};
    const timer=setTimeout(()=>{cancel?.removeEventListener("abort",abort);resolve();},milliseconds);
    cancel?.addEventListener("abort",abort,{once:true});if(cancel?.aborted)abort();
  }));
  cancelled();let observed=await proof();cancelled();
  if(observed.state==="gone")return;
  if(observed.state!=="alive"||!missing())throw new HostCreationBlockedError(observed);
  while(now()<deadline){
    await wait(Math.min(50,deadline-now()),signal);cancelled();
    if(now()>=deadline)break;
    observed=await proof();cancelled();
    if(observed.state==="gone")return;
    if(!missing())break;
  }
  throw new HostCreationBlockedError(observed);
}
