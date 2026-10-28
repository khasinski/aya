// Main-only absence proof. The diagnostic registry helper deliberately omits
// unknown processes; an empty diagnostic list is never permission to spawn.
import fs from "node:fs";
import path from "node:path";
import {AYA_HOME} from "./pty-host-paths";
import {readProcInfo,type ProcInfo} from "./pty-host-registry";

export type HostCreationState = "gone" | "alive" | "unknown";
export interface HostCreationProof {state: HostCreationState; hosts: Array<{pid: number; startTime: string; state: HostCreationState}>}
export class HostCreationBlockedError extends Error {
  readonly code="PTY_HOST_START_BLOCKED";
  constructor(readonly proof:HostCreationProof){super(proof.state==="unknown"
    ? "The terminal host inventory is unknown; another host was not started."
    : "A terminal host is still running; another host was not started.");}
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
export function hostCreationProof(directory=path.join(AYA_HOME,"pty-hosts"),probe:(pid:number)=>ProcInfo=readProcInfo,
  ownerFile=path.join(path.dirname(directory),"pty-owner","record.json")):HostCreationProof{
  const hosts:HostCreationProof["hosts"]=[],snapshots:Array<{file:string;stat:fs.Stats}>=[];
  let unknown=false,stat:fs.Stats|undefined,names:string[]=[];
  const observe=(entry:{pid:number;startTime:string})=>{
    let state:HostCreationState="unknown";
    try{
      const info=probe(entry.pid);
      if(!info.probeFailed){if(!info.alive)state="gone";else if(info.startTime)state=info.startTime===entry.startTime?"alive":"gone";}
    }catch{/* Unknown remains unknown. */}
    hosts.push({...entry,state});if(state==="unknown")unknown=true;
  };
  try{
    try{stat=fs.lstatSync(directory);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")unknown=true;}
    if(stat&&(!stat.isDirectory()||stat.uid!==process.getuid?.()||(stat.mode&0o022)))unknown=true;
    else if(stat)names=fs.readdirSync(directory).sort();
    for(const name of names){
      try{
        const file=path.join(directory,name),entry=record(file,name);snapshots.push({file,stat:entry.stat});
        observe({pid:entry.pid,startTime:entry.startTime});
      }catch{unknown=true;}
    }
    // A non-group-leading JS host may have no host-registry record, but its
    // stable owner still records the reader. Never ignore that evidence.
    try{
      const parent=fs.lstatSync(path.dirname(ownerFile));
      if(!parent.isDirectory()||parent.uid!==process.getuid?.()||(parent.mode&0o077))throw Error("unsafe owner directory");
      try{
        const {value,stat:ownerStat}=privateJson(ownerFile,65536),r=value as {jsPid?:unknown;jsStartTime?:unknown};
        if(!r||typeof r!=="object"||!Number.isSafeInteger(r.jsPid)||Number(r.jsPid)<2||Number(r.jsPid)>0x7fffffff||typeof r.jsStartTime!=="string"||!r.jsStartTime||r.jsStartTime.length>128)throw Error("unknown reader");
        observe({pid:Number(r.jsPid),startTime:r.jsStartTime});snapshots.push({file:ownerFile,stat:ownerStat});
      }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")unknown=true;}
      if(!same(parent,fs.lstatSync(path.dirname(ownerFile))))unknown=true;
    }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")unknown=true;}
    if(stat&&(!same(stat,fs.lstatSync(directory))||JSON.stringify(names)!==JSON.stringify(fs.readdirSync(directory).sort())))unknown=true;
    for(const snapshot of snapshots){
      const after=fs.lstatSync(snapshot.file),before=snapshot.stat;
      if(!same(before,after)||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||before.mode!==after.mode||before.uid!==after.uid)unknown=true;
    }
    return {state:unknown?"unknown":hosts.some(host=>host.state==="alive")?"alive":"gone",hosts};
  }catch{return {state:"unknown",hosts};}
}
// Stays synchronous: the proof is the last check before the fork (startHost calls it again right before spawn), and
// an await inside it would let a host appear between the probe and the fork it permits. Per host start, ~2 ms per record.
export function assertHostCreationSafe():void{
  const proof=hostCreationProof();if(proof.state!=="gone")throw new HostCreationBlockedError(proof);
}


export const HOST_SHUTDOWN_GRACE_MS=3000;
interface ShutdownWaitDeps {
  now:()=>number;
  proof:()=>HostCreationProof;
  socketMissing:()=>boolean;
  wait:(milliseconds:number,signal?:AbortSignal)=>Promise<void>;
}
/** Absence of a socket is not absence of its process. Give an already-exiting,
 * verified host a short grace period; the normal final pre-fork proof remains. */
export async function waitForHostShutdown(socketPath:string,signal?:AbortSignal,overrides:Partial<ShutdownWaitDeps>={}):Promise<void>{
  const now=overrides.now??Date.now,deadline=now()+HOST_SHUTDOWN_GRACE_MS;
  const cancelled=()=>{if(signal?.aborted)throw Error("PTY host startup was cancelled");};
  const proof=overrides.proof??(()=>hostCreationProof(undefined,pid=>{
    const remaining=deadline-now();
    return remaining<=0||signal?.aborted?{alive:false,probeFailed:true,startTime:null,command:null}:readProcInfo(pid,Math.max(1,remaining));
  }));
  const missing=overrides.socketMissing??(()=>{try{fs.lstatSync(socketPath);return false;}catch(error){return (error as NodeJS.ErrnoException).code==="ENOENT";}});
  const wait=overrides.wait??((milliseconds:number,cancel?:AbortSignal)=>new Promise<void>((resolve,reject)=>{
    const abort=()=>{clearTimeout(timer);cancel?.removeEventListener("abort",abort);reject(Error("PTY host startup was cancelled"));};
    const timer=setTimeout(()=>{cancel?.removeEventListener("abort",abort);resolve();},milliseconds);
    cancel?.addEventListener("abort",abort,{once:true});if(cancel?.aborted)abort();
  }));
  cancelled();let observed=proof();
  if(observed.state==="gone")return;
  if(observed.state!=="alive"||!missing())throw new HostCreationBlockedError(observed);
  while(now()<deadline){
    await wait(Math.min(50,deadline-now()),signal);cancelled();
    if(now()>=deadline)break;
    observed=proof();
    if(observed.state==="gone")return;
    if(!missing())break;
  }
  throw new HostCreationBlockedError(observed);
}
