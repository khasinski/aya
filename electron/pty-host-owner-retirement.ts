// Main-only explicit recovery of a retained owner after its JS reader died.
// No key request, owner protocol, helper host, group signal or escalation.
import {readOwnerRecord,writeOwnerRecord,removeOwnerRecord,type OwnerRecord} from "./pty-owner-registry";
import {readProcInfoAsync} from "./pty-host-registry";
import {ownerProcessStartIdentity,ownerProcessGroupExists,ownerGroupMemberPidsAsync,snapshotOwnerRecoveryMembersAsync} from "./pty-owner-client";
import {settleOwnerSurvivors} from "./pty-owner-survivors";
import {refusedRestartDeps} from "./pty-host-auth-restart";
import type {HostRestartConsent,HostRestartTarget} from "./pty-host-client";

export interface OwnerInspection {
  target:HostRestartTarget;record:OwnerRecord|null;readerGone:boolean;state:"same"|"gone"|"changed"|"unknown";
}
export interface OwnerRetirementDeps {
  inspect():Promise<OwnerInspection>;prepare(record:OwnerRecord):void|Promise<void>;
  group(pid:number):number|null|Promise<number|null>;signal(pid:number,startIdentity:string,group:number):"absent"|"mismatch"|"unknown"|"signalled";
  waitGone(pid:number,startIdentity:string):Promise<boolean>;
  survivors(record:OwnerRecord):{needed:boolean;target:HostRestartTarget}|Promise<{needed:boolean;target:HostRestartTarget}>;
  settle(record:OwnerRecord,allowSignals:boolean):Promise<void>;complete(record:OwnerRecord,ids:string[]):void;
  ownerGone():void;cancelled():boolean;log(event:string,fields:Record<string,unknown>):void;
}
export const sameRetainedOwner=(a:HostRestartTarget["owner"],b:HostRestartTarget["owner"]):boolean=>!!a&&!!b&&
  a.pid===b.pid&&a.startTime===b.startTime&&a.startIdentity===b.startIdentity&&a.instanceId===b.instanceId&&a.hash===b.hash;
function targetOf(record:OwnerRecord):HostRestartTarget{
  const uncertain=[...new Set([...(record.uncertain??[]),...(record.spawnIntents??[]).map(p=>p.id)])];
  return {pid:null,startTime:null,identity:null,ptyCount:record.panes.length+uncertain.filter(id=>!record.panes.some(p=>p.id===id)).length,ownerUnavailable:true,
    owner:{pid:record.pid,startTime:record.startTime,startIdentity:record.startIdentity,instanceId:record.instanceId,hash:record.binaryHash,incompatible:true,
      disconnected:[...new Set([...record.panes.map(p=>p.id),...uncertain])],inventory:record.panes.map(p=>({id:p.id,pid:p.pid,startIdentity:p.startIdentity})),uncertain,recoveryFailures:record.recoveryFailures}};
}
export async function inspectRetainedOwner():Promise<OwnerInspection>{
  const unknown:OwnerInspection={target:{pid:null,startTime:null,identity:null,ptyCount:0,ownerUnavailable:true,recoveryReason:"The retained owner identity and inventory are unknown. Nothing can be stopped safely."},record:null,readerGone:false,state:"unknown"};
  try{
    const record=readOwnerRecord();if(!record)return unknown;
    const result:OwnerInspection={...unknown,record,target:targetOf(record)};
    if(!record.startIdentity){result.target.recoveryReason="This older development owner has no recorded kernel start identity. Aya cannot stop it safely; its processes and inventory were kept.";return result;}
    // Async probes: a gone reader or owner stays gone, and retireUnavailableOwner inspects again before and after
    // every signal, which itself verifies the kernel identity.
    const reader=await readProcInfoAsync(record.jsPid);result.readerGone=!reader.alive&&!reader.probeFailed;
    if(!result.readerGone){result.target.recoveryReason="The recorded JS reader is still running or cannot be verified gone. The terminal owner was kept.";return result;}
    const identity=ownerProcessStartIdentity(record.pid);
    if(identity)result.state=identity===record.startIdentity?"same":"changed";
    else{const owner=await readProcInfoAsync(record.pid);if(!owner.alive&&!owner.probeFailed&&!ownerProcessStartIdentity(record.pid))result.state="gone";}
    if(result.state==="changed"||result.state==="unknown")result.target.recoveryReason="The terminal owner's process identity changed or cannot be verified. Nothing will be signalled.";
    return result;
  }catch{return unknown;}
}
export async function retireUnavailableOwner(consent:HostRestartConsent,deps:OwnerRetirementDeps):Promise<boolean>{
  let approved=consent.target.owner;
  const active=()=>{if(deps.cancelled())throw Error("Terminal owner recovery cancelled because Aya is closing");};
  const refuse=async(target:HostRestartTarget):Promise<never>=>{await consent.confirmChanged(target);throw Error(target.recoveryReason??"The retained terminal owner changed. Nothing was stopped.");};
  for(let attempt=0;attempt<4;attempt++){
    active();let current=await deps.inspect();active();
    if(!current.record||!current.readerGone||current.state==="unknown"||current.state==="changed")return refuse(current.target);
    if(!sameRetainedOwner(approved,current.target.owner)){
      if(!await consent.confirmChanged(current.target))throw Error("restart cancelled");approved=current.target.owner;continue;
    }
    const record=current.record,ids=[...new Set([...record.panes.map(p=>p.id),...(record.uncertain??[]),...(record.spawnIntents??[]).map(p=>p.id)])];
    if(current.state==="same"){
      await deps.prepare(record);active();const group=await deps.group(record.pid);
      if(!group)return refuse({...current.target,recoveryReason:"The terminal owner process could not be verified. Nothing was stopped."});
      current=await deps.inspect();active();
      if(!current.record||!current.readerGone||current.state==="unknown"||current.state==="changed")return refuse(current.target);
      if(!sameRetainedOwner(approved,current.target.owner)){
        if(!await consent.confirmChanged(current.target))throw Error("restart cancelled");approved=current.target.owner;continue;
      }
      if(current.state==="same"){
        const outcome=deps.signal(record.pid,record.startIdentity!,group);
        deps.log("pty-owner-confirmed-sigterm",{pid:record.pid,startIdentity:record.startIdentity,instanceId:record.instanceId,outcome});
        if(outcome!=="signalled"){const fresh=await deps.inspect();active();return refuse(fresh.target);}
        if(!await deps.waitGone(record.pid,record.startIdentity!))return false;
      }
    }
    active();const retired=await deps.inspect();active();
    if(!retired.record||!retired.readerGone||!sameRetainedOwner(approved,retired.target.owner)||retired.state!=="gone")return refuse(retired.target);
    deps.ownerGone();const survivors=await deps.survivors(retired.record);let allowed=false;
    if(survivors.needed){
      if(!consent.confirmSurvivors||!await consent.confirmSurvivors(survivors.target))throw Error("The terminal owner stopped. Retained processes were kept because survivor recovery was not confirmed.");
      allowed=true;
    }
    active();await deps.settle(retired.record,allowed);active();
    const final=await deps.inspect();active();
    if(!final.record||!final.readerGone||final.state!=="gone"||!sameRetainedOwner(approved,final.target.owner))return refuse(final.target);
    deps.complete(final.record,ids);return true;
  }
  throw Error("The retained terminal owner kept changing. Nothing was stopped; review the current inventory.");
}
function sameRecord(a:OwnerRecord,b:OwnerRecord|null):boolean{
  return !!b&&a.pid===b.pid&&a.startTime===b.startTime&&a.startIdentity===b.startIdentity&&a.instanceId===b.instanceId&&a.binaryHash===b.binaryHash&&a.jsPid===b.jsPid&&a.jsStartTime===b.jsStartTime;
}
export function ownerRetirementDeps(options:{cancelled:()=>boolean;log:OwnerRetirementDeps["log"];ownerGone:()=>void;complete:(ids:string[],record:OwnerRecord)=>void}):OwnerRetirementDeps{
  const base=refusedRestartDeps(options.cancelled,options.log);
  const persist=(record:OwnerRecord)=>{if(!sameRecord(record,readOwnerRecord()))throw Error("Retained owner record changed; its inventory was kept");writeOwnerRecord(record);};
  return {
    inspect:inspectRetainedOwner,cancelled:options.cancelled,log:options.log,ownerGone:options.ownerGone,group:base.group,signal:base.signal,waitGone:base.waitGone,
    async prepare(record){
      for(const pane of record.panes)if(!pane.recoveryMembers&&pane.startIdentity){
        try{pane.recoveryMembers=await snapshotOwnerRecoveryMembersAsync(pane.pid,pane.startIdentity);}catch{/* Unknown members remain unsignallable after owner shutdown. */}
      }
      persist(record); // Every fallible write precedes the owner signal.
    },
    async survivors(record){
      const target=targetOf(record);let needed=!!target.owner?.uncertain?.length;
      target.owner!.inventory=record.panes.filter(p=>{try{return ownerProcessGroupExists(p.pid);}catch{return true;}}).map(p=>({id:p.id,pid:p.pid,startIdentity:p.startIdentity}));
      needed||=!!target.owner!.inventory.length;
      // Wording for the survivor question only; settle snapshots and verifies every member again before a signal.
      target.owner!.recoveryFailures=await Promise.all(target.owner!.inventory.map(async p=>{
        try{return `${p.id}: retained group members ${(await ownerGroupMemberPidsAsync(p.pid)).map(pid=>`PID ${pid}`).join(", ")}`;}catch{return `${p.id}: surviving process identities are unknown`;}
      }));
      return {needed,target};
    },
    async settle(record,allowSignals){
      const inventory=new Map(record.panes.map(p=>[p.id,p])),disconnected=new Map(inventory);
      await settleOwnerSurvivors({record,inventory,disconnected,persist(){record.panes=[...inventory.values()];persist(record);}},false,allowSignals);
    },
    complete(record,ids){
      if(record.panes.length||record.uncertain?.length||record.spawnIntents?.length||!sameRecord(record,readOwnerRecord()))throw Error("Retained process inventory is not settled");
      removeOwnerRecord(record);if(readOwnerRecord())throw Error("Retained owner record changed before retirement");options.complete(ids,record);
    },
  };
}
