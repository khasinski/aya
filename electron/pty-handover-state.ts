// Main's bounded control-plane response, separate from streamed pane payloads.
import type {HostHandoverState} from "./pty-host-handover";
import {MAX_CHECKPOINT_BYTES} from "./vt-checkpoint-schema";
import {MAX_PTY_PANES} from "./pty-pane-limits";
export function handoverState(value:unknown,deadline:number):HostHandoverState {
  const fail=():never=>{throw new Error("Invalid terminal handover state");};
  if(!value||typeof value!=="object"||Array.isArray(value))fail();
  const v=value as HostHandoverState;
  if(Object.keys(v).sort().join(',')!=="consented,core,coreEncodedBytes,coreRawBytes,deadline,display,displayEncodedBytes,displayRawBytes,eligible,ineligible")fail();
  const receipt=(r:unknown):boolean=>{
    if(!r||typeof r!=="object"||Array.isArray(r)||Object.keys(r).sort().join(',')!=="bytes,nonce,sha256")return false;
    const p=r as {bytes:number;nonce:string;sha256:string};return Number.isSafeInteger(p.bytes)&&p.bytes>0&&p.bytes<=65536&&/^[a-f0-9]{64}$/.test(p.nonce)&&/^[a-f0-9]{64}$/.test(p.sha256);
  };
  const identity=(s:unknown):s is string=>typeof s==='string'&&s.length>0&&Buffer.byteLength(s)<=128;
  if(v.deadline!==deadline||deadline<=Date.now()||!receipt(v.core)||(v.display!==null&&!receipt(v.display)))fail();
  for(const n of [v.coreRawBytes,v.coreEncodedBytes,v.displayRawBytes,v.displayEncodedBytes])if(!Number.isSafeInteger(n)||n<0||n>MAX_CHECKPOINT_BYTES)fail();
  if(v.coreRawBytes+v.displayRawBytes>MAX_CHECKPOINT_BYTES||v.coreEncodedBytes+v.displayEncodedBytes>MAX_CHECKPOINT_BYTES||v.displayRawBytes>96*1024*1024||v.displayEncodedBytes>96*1024*1024)fail();
  if(!Array.isArray(v.eligible)||!Array.isArray(v.ineligible)||!Array.isArray(v.consented)||v.consented.length>MAX_PTY_PANES||v.eligible.length+v.ineligible.length>MAX_PTY_PANES)fail();
  const ids=new Set<string>();
  for(const p of v.eligible){if(!p||Object.keys(p).sort().join(',')!=="generation,id,outputEnd"||!identity(p.id)||!identity(p.generation)||ids.has(p.id)||!Number.isSafeInteger(p.outputEnd)||p.outputEnd<0)fail();ids.add(p.id);}
  for(const p of v.ineligible){if(!p||Object.keys(p).sort().join(',')!=="id,reason"||!identity(p.id)||ids.has(p.id)||typeof p.reason!=='string'||p.reason.length>4096)fail();ids.add(p.id);}
  if(v.consented.length!==new Set(v.consented).size||v.consented.some(id=>!v.ineligible.some(p=>p.id===id)))fail();
  return v;
}

export function handoverCommitResult(value:unknown,consented:string[]):{stopped:string[];ended:Array<{id:string;exitCode:number;ownerExit?:{generation:number;event:number}}>}{
 const fail=():never=>{throw Error("Invalid terminal handover commit result");};
 if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(',')!=="ended,stopped")fail();
 const v=value as {stopped:string[];ended:Array<{id:string;exitCode:number;ownerExit?:{generation:number;event:number}}>};
 if(!Array.isArray(v.stopped)||!Array.isArray(v.ended)||v.stopped.length+v.ended.length>MAX_PTY_PANES)fail();
 const seen=new Set<string>();
 for(const id of v.stopped){if(typeof id!=="string"||!consented.includes(id)||seen.has(id))fail();seen.add(id);}
 for(const p of v.ended){if(!p||!(["exitCode,id","exitCode,id,ownerExit"].includes(Object.keys(p).sort().join(',')))||typeof p.id!=="string"||!p.id.length||Buffer.byteLength(p.id)>128||seen.has(p.id)||!Number.isInteger(p.exitCode)||p.exitCode<0||p.exitCode>255)fail();
  if(p.ownerExit!==undefined){const r=p.ownerExit;if(!r||typeof r!=="object"||Array.isArray(r)||Object.keys(r).sort().join(',')!=="event,generation"||!Number.isInteger(r.generation)||r.generation<1||r.generation>0xffffffff||!Number.isInteger(r.event)||r.event<1||r.event>0xffffffff)fail();}
  seen.add(p.id);}
 return v;
}
