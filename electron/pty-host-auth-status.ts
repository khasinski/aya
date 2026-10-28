// Main-only retained facts for a refused socket. No owner connection, key
// request, process signal or replacement may be made to populate a question.
import {readOwnerRecord} from "./pty-owner-registry";
import {readProcInfoAsync} from "./pty-host-registry";
import {hostCreationPermit} from "./pty-host-start-guard";
import {ownerProcessStartIdentity} from "./pty-owner-client";
import type {HostAuthPeer} from "./pty-host-auth";
import type {PtyOwnerStatus} from "./pty-host-protocol";
import type {LegacyInventory} from "./pty-host-legacy-status";

export interface HostAuthenticationProblem {required:true;inventoryKnown:boolean;targetVerified:boolean;reason:string;unannounced?:true;legacy?:LegacyInventory}
export interface RefusedHostStatus {
  identity:null;ptyCount:number;pid?:number;startTime:string|null;owner?:PtyOwnerStatus;authentication:HostAuthenticationProblem;
}
export const HOST_UNANNOUNCED_REASON="These terminals cannot be reattached by this Aya. Their processes may still be running; input remains disabled. Use Settings > Diagnostics > PTY host > Restart to review stopping them.";
export const HOST_AUTH_REFUSAL_REASON="Aya could not authenticate to the terminal host. Its processes were kept; input remains disabled. Use Settings > Diagnostics > PTY host > Restart to review them.";
export async function refusedHostStatus(peer:HostAuthPeer|null):Promise<RefusedHostStatus>{
  const status:RefusedHostStatus={identity:null,ptyCount:0,startTime:peer?.startIdentity??null,...(peer?{pid:peer.pid}:{}),
    authentication:{required:true,inventoryKnown:false,targetVerified:false,reason:HOST_AUTH_REFUSAL_REASON}};
  if(!peer)return status;
  try{
    // The ps runs off the event loop. The kernel identity is read before it and again after it: equal, the start
    // time ps reported belongs to the peer's own process instance. The owner-record read that decides targetVerified
    // then follows in the same turn as that second check. Runs only when authentication was refused; nothing here
    // signals, and a restart inspects again after its own process-group probe.
    if(ownerProcessStartIdentity(peer.pid)!==peer.startIdentity)return status;
    const observed=await readProcInfoAsync(peer.pid);
    if(observed.probeFailed||!observed.alive||!observed.startTime||ownerProcessStartIdentity(peer.pid)!==peer.startIdentity)return status;
    const record=readOwnerRecord();
    if(record&&record.jsPid===peer.pid&&record.jsStartTime===observed.startTime){
      const uncertain=[...new Set([...(record.uncertain??[]),...(record.spawnIntents??[]).map(p=>p.id)])];
      status.owner={pid:record.pid,startTime:record.startTime,startIdentity:record.startIdentity,instanceId:record.instanceId,hash:record.binaryHash,incompatible:false,
        disconnected:[...new Set([...record.panes.map(p=>p.id),...uncertain])],
        inventory:record.panes.map(p=>({id:p.id,pid:p.pid,startIdentity:p.startIdentity})),uncertain,recoveryFailures:record.recoveryFailures};
      status.ptyCount=record.panes.length+uncertain.filter(id=>!record.panes.some(p=>p.id===id)).length;
      status.authentication.inventoryKnown=true;status.authentication.targetVerified=true;
    }else{
      // Legacy hosts may have no native-owner ledger. Their private host
      // record can bind the host, but cannot manufacture a pane inventory.
      const proof=await hostCreationPermit();
      status.authentication.targetVerified=proof.hosts.some(p=>p.pid===peer.pid&&p.startTime===observed.startTime&&p.state==="alive");
    }
    if(ownerProcessStartIdentity(peer.pid)!==peer.startIdentity)return {...status,owner:undefined,ptyCount:0,authentication:{...status.authentication,inventoryKnown:false,targetVerified:false}};
  }catch{
    // A late failed identity probe must not retain a partially assembled proof.
    delete status.owner;status.ptyCount=0;status.authentication.inventoryKnown=false;status.authentication.targetVerified=false;
  }
  return status;
}
