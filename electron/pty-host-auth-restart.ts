// Main-only fallback after a confirmed authentication failure. Inspection sends
// no credential; verified pre-auth legacy hosts may report bounded migration
// status. Only an exact, rechecked private-record target may get
// an individual SIGTERM; this path never force-kills or starts either host.
import net from "node:net";
import {execFileSync} from "node:child_process";
import {PTY_HOST_SOCKET_PATH} from "./pty-host-paths";
import {handoverPeer} from "./pty-handover-window";
import {refusedHostStatus,type RefusedHostStatus} from "./pty-host-auth-status";
import {ownerProcessStartIdentity,terminateVerifiedProcess} from "./pty-owner-client";
import type {HostRestartConsent,HostRestartTarget} from "./pty-host-client";
import {probeLegacyInventory} from "./pty-host-legacy-status";

export interface RefusedRestartTarget extends HostRestartTarget {authentication:RefusedHostStatus["authentication"]}
export interface RefusedRestartDeps {
  inspect():Promise<RefusedRestartTarget>;
  group(pid:number):number|null;
  signal(pid:number,startIdentity:string,group:number):"absent"|"mismatch"|"unknown"|"signalled";
  waitGone(pid:number,startIdentity:string):Promise<boolean>;
  cancelled():boolean;
  log(event:string,fields:Record<string,unknown>):void;
}
const same=(a:HostRestartConsent["target"],b:HostRestartTarget):boolean=>a.pid===b.pid&&a.startTime===b.startTime&&
  JSON.stringify(a.owner?[a.owner.pid,a.owner.startTime,a.owner.startIdentity??null,a.owner.instanceId,a.owner.hash]:null)===JSON.stringify(b.owner?[b.owner.pid,b.owner.startTime,b.owner.startIdentity??null,b.owner.instanceId,b.owner.hash]:null);
export async function inspectRefusedHost(legacyPaneIds:readonly string[]=[]):Promise<RefusedRestartTarget>{
  const peer=await new Promise<ReturnType<typeof handoverPeer>|null>(resolve=>{
    let settled=false;
    const done=(value:ReturnType<typeof handoverPeer>|null)=>{if(settled)return;settled=true;clearTimeout(timer);socket.destroy();resolve(value);};
    const timer=setTimeout(()=>done(null),1000);
    const socket=net.createConnection(PTY_HOST_SOCKET_PATH,()=>{try{done(handoverPeer(socket));}catch{done(null);}});
    socket.on("error",()=>done(null));socket.on("close",()=>done(null));
  });
  const status=refusedHostStatus(peer);
  if(peer&&status.authentication.targetVerified&&!status.owner){const legacy=await probeLegacyInventory(peer,legacyPaneIds);if(legacy){status.authentication.legacy=legacy;status.ptyCount=legacy.total;}}
  return {...status,pid:status.pid??null};
}
export async function restartRefusedHost(consent:HostRestartConsent,deps:RefusedRestartDeps):Promise<boolean>{
  let approved=consent.target;
  const active=()=>{if(deps.cancelled())throw Error("Terminal host restart cancelled because Aya is closing");};
  for(let attempt=0;attempt<4;attempt++){
    active();const target=await deps.inspect();active();
    if(!target.pid||!target.startTime||!target.authentication.targetVerified){
      await consent.confirmChanged(target);throw Error("The current terminal host identity could not be verified. Nothing was stopped.");
    }
    if(!same(approved,target)){
      if(!await consent.confirmChanged(target))throw Error("restart cancelled");
      approved=target;continue;
    }
    const group=deps.group(target.pid);
    if(!group)throw Error("The terminal host process identity could not be verified. Nothing was stopped.");
    // Re-open the socket and re-read its bound private inventory after the
    // process-group probe and after every asynchronous confirmation.
    const current=await deps.inspect();active();
    if(!current.authentication.targetVerified||!same(target,current)){
      if(!await consent.confirmChanged(current))throw Error("restart cancelled");
      approved=current;continue;
    }
    const outcome=deps.signal(target.pid,target.startTime,group);
    deps.log("pty-host-auth-confirmed-sigterm",{pid:target.pid,startIdentity:target.startTime,ownerInstance:target.owner?.instanceId??null,outcome});
    if(outcome!=="signalled"){
      const fresh=await deps.inspect();active();
      await consent.confirmChanged(fresh);
      throw Error("The terminal host changed or could not be signalled safely. No replacement was started.");
    }
    return deps.waitGone(target.pid,target.startTime);
  }
  throw Error("The terminal host kept changing. Nothing was stopped; review its inventory and try again.");
}
export function refusedRestartDeps(cancelled:()=>boolean,log:RefusedRestartDeps["log"],legacyPaneIds:readonly string[]=[]):RefusedRestartDeps{
  return {
    inspect:()=>inspectRefusedHost(legacyPaneIds),cancelled,log,
    group(pid){
      try{
        const value=execFileSync("ps",["-p",String(pid),"-o","pgid="],{encoding:"utf8",timeout:500,stdio:["ignore","pipe","ignore"]}).trim();
        return /^\d+$/.test(value)&&Number.isSafeInteger(Number(value))&&Number(value)>1?Number(value):null;
      }catch{return null;}
    },
    signal:(pid,startIdentity,group)=>terminateVerifiedProcess({pid,startIdentity},group),
    async waitGone(pid,startIdentity){
      const deadline=Date.now()+5000;
      do{
        if(cancelled())return false;
        try{
          const current=ownerProcessStartIdentity(pid);
          if(current&&current!==startIdentity)return true;
          if(!current){try{process.kill(pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==="ESRCH")return true;}}
        }catch{/* Unknown is not proof of exit. */}
        await new Promise(resolve=>setTimeout(resolve,25));
      }while(Date.now()<deadline);
      return false;
    },
  };
}
