// Only inherited private data from the surviving main; no credential or screen.
import {Socket} from "node:net";
import {parseCheckpointJson} from "./vt-checkpoint-schema";
import {validateRecoveryLaunch} from "./pty-core-checkpoint";
import type {RecoveryOwnerIdentity} from "./pty-owner-runtime";
import type {SpawnRequest} from "./types";
import type {PaneLaunch} from "./launch-mode";
export interface RecoveryPane {
  id:string;generation:number;pid:number;startIdentity:string;
  request:SpawnRequest;launch:PaneLaunch;spawnedAt:number;
}
export interface RecoveryBootstrap {format:1;kind:"crash";owner:RecoveryOwnerIdentity;panes:RecoveryPane[]}
export const MAX_RECOVERY_BOOTSTRAP_BYTES=1024*1024;
function closed(value:unknown,keys:string[]):value is Record<string,unknown> {
 return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===keys.sort().join(',');
}
export function parseRecoveryBootstrap(bytes:Buffer):RecoveryBootstrap {
 if(bytes.length>MAX_RECOVERY_BOOTSTRAP_BYTES)throw Error("Recovery bootstrap length limit");
 const v=parseCheckpointJson(bytes);
 if(!closed(v,['format','kind','owner','panes'])||v.format!==1||v.kind!=='crash'||
  !closed(v.owner,['pid','startTime','instanceId','binaryHash'])||!Number.isSafeInteger(v.owner.pid)||(v.owner.pid as number)<2||(v.owner.pid as number)>0x7fffffff||
  typeof v.owner.startTime!=='string'||!v.owner.startTime.length||v.owner.startTime.length>128||
  typeof v.owner.instanceId!=='string'||!/^[a-f0-9]{32}$/.test(v.owner.instanceId)||
  typeof v.owner.binaryHash!=='string'||!/^[a-f0-9]{64}$/.test(v.owner.binaryHash)||!Array.isArray(v.panes)||v.panes.length>25)throw Error("Invalid recovery bootstrap");
 const ids=new Set<string>();
 for(const p of v.panes){
  if(!closed(p,['id','generation','pid','startIdentity','request','launch','spawnedAt'])||typeof p.id!=='string'||ids.has(p.id)||
   !Number.isInteger(p.generation)||(p.generation as number)<1||(p.generation as number)>0xffffffff||!Number.isSafeInteger(p.pid)||(p.pid as number)<2||(p.pid as number)>0x7fffffff||
   typeof p.startIdentity!=='string'||p.startIdentity.length>63||!/^\d+:\d+$/.test(p.startIdentity))throw Error("Invalid recovery pane identity");
  validateRecoveryLaunch(p.id,p.request,p.launch,p.spawnedAt);ids.add(p.id);
 }
 return v as unknown as RecoveryBootstrap;
}
export function readRecoveryBootstrap(fd:number):Promise<RecoveryBootstrap> {
 return new Promise((resolve,reject)=>{
  const input=new Socket({fd,readable:true,writable:false}),chunks:Buffer[]=[];let size=0;
  const timer=setTimeout(()=>input.destroy(Error("Recovery bootstrap timed out")),2000);
  input.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>MAX_RECOVERY_BOOTSTRAP_BYTES)input.destroy(Error("Recovery bootstrap length limit"));else chunks.push(chunk);});
  input.once('error',error=>{clearTimeout(timer);reject(error);});
  input.once('end',()=>{clearTimeout(timer);try{resolve(parseRecoveryBootstrap(Buffer.concat(chunks)));}catch(error){reject(error);}});
 });
}
