// Private inherited descriptor, not argv/env, carries receipt metadata only.
// Every pane is preflighted before any master is attached. The owner key uses
// its separate inherited descriptor and never enters this representation.
import {Socket} from "node:net";
import {PTY_HANDOVER_CORE_DIRECTORY} from "./pty-host-paths";
import {readCheckpoint, type CheckpointReceipt} from "./pty-checkpoint-store";
import {checkpointPayloadSize,decodeCheckpointPayload} from "./pty-checkpoint-payload";
import {parseCheckpointJson,MAX_CHECKPOINT_BYTES} from "./vt-checkpoint-schema";
import {validatePaneCoreCheckpoint,type PaneCoreCheckpoint} from "./pty-core-checkpoint";

export interface HandoverBootstrap {format:1;core:CheckpointReceipt}
export function parseHandoverBootstrap(data:Buffer):HandoverBootstrap {
  if(data.length>65536)throw new Error("Terminal bootstrap exceeds its length limit");
  const value=parseCheckpointJson(data) as Partial<HandoverBootstrap>;
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(',')!=="core,format"||value.format!==1||!value.core)throw new Error("Invalid terminal bootstrap");
  // Receipt type, permissions and hashes are validated by the escrow reader.
  return value as HandoverBootstrap;
}
export function readHandoverBootstrap(fd:number):Promise<HandoverBootstrap> {
  return new Promise((resolve,reject)=>{
    const input=new Socket({fd,readable:true,writable:false});let bytes=0;const chunks:Buffer[]=[];
    const timer=setTimeout(()=>input.destroy(new Error("Terminal bootstrap timed out")),2000);
    input.on("data",(chunk:Buffer|string)=>{const data=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);bytes+=data.length;if(bytes>65536)input.destroy(new Error("Terminal bootstrap exceeds its length limit"));else chunks.push(data);});
    input.once("error",error=>{clearTimeout(timer);reject(error);});
    input.once("end",()=>{clearTimeout(timer);try{resolve(parseHandoverBootstrap(Buffer.concat(chunks)));}catch(error){reject(error);}});
  });
}
async function checkRawAggregate(receipt:CheckpointReceipt):Promise<{rawBytes:number;encodedBytes:number}> {
  let raw=0,encoded=0;
  for await(const part of readCheckpoint(PTY_HANDOVER_CORE_DIRECTORY,receipt)){
    raw+=checkpointPayloadSize(part.data);encoded+=part.data.length;
    if(raw>MAX_CHECKPOINT_BYTES)throw new Error("Terminal core aggregate decoded-byte limit");
  }
  return {rawBytes:raw,encodedBytes:encoded};
}
export async function preflightCoreHandover(receipt:CheckpointReceipt,expected?:Array<{id:string;generation:string;outputEnd:number}>):Promise<{rawBytes:number;encodedBytes:number}> {
  const sizes=await checkRawAggregate(receipt),remaining=expected?new Map(expected.map(p=>[p.id,p])):null;
  for await(const pane of readCoreHandover(receipt)){
    if(remaining){
      const match=remaining.get(pane.id);
      if(!match||match.generation!==(pane.vt.metadata as {generation:string}).generation||match.outputEnd!==pane.output.end)throw new Error("Terminal checkpoint boundary identity mismatch");
      remaining.delete(pane.id);
    }
  }
  if(remaining?.size)throw new Error("Terminal checkpoint pane set differs");
  return sizes;
}
export async function* readCoreHandover(receipt:CheckpointReceipt):AsyncGenerator<PaneCoreCheckpoint> {
  // Headers for every part are checked before decoding even the first pane.
  await checkRawAggregate(receipt);
  for await(const part of readCheckpoint(PTY_HANDOVER_CORE_DIRECTORY,receipt)){
    const pane=await validatePaneCoreCheckpoint(parseCheckpointJson(decodeCheckpointPayload(part.data)));
    if(pane.id!==part.id||(pane.vt.metadata as {generation:string}).generation!==part.generation)throw new Error("Terminal checkpoint part identity mismatch");
    yield pane;
  }
}
