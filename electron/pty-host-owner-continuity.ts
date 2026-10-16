// Main-only validation. The native owner credential is returned only in memory
// after authenticated socket proof and a complete, generation-bound manifest.
import {createHash} from "node:crypto";
import {parseRecoveryBootstrap,MAX_RECOVERY_BOOTSTRAP_BYTES,type RecoveryBootstrap} from "./pty-recovery-bootstrap";
import type {HostAuthPeer} from "./pty-host-auth";
import {MAX_PTY_PANES} from "./pty-pane-limits";
export interface OwnerContinuity {credential:Buffer;bootstrap:RecoveryBootstrap}
const closed=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).sort().join(",")===keys.sort().join(",");
export function validateOwnerContinuity(value:unknown,peer:HostAuthPeer,version:unknown):OwnerContinuity {
  const json=JSON.stringify(value);
  if(!json||Buffer.byteLength(json)>MAX_RECOVERY_BOOTSTRAP_BYTES||!closed(value,["format","host","secret","bootstrap"])||value.format!==1||
    !closed(value.host,["pid","startIdentity"])||value.host.pid!==peer.pid||value.host.startIdentity!==peer.startIdentity||typeof value.secret!=="string"||!/^[a-f0-9]{64}$/.test(value.secret))throw Error("Invalid terminal owner continuity response");
  const expected=(version as {owner?:Record<string,unknown>}|null)?.owner;
  if(!expected||expected.incompatible!==false||!Array.isArray(expected.inventory)||expected.inventory.length>MAX_PTY_PANES)throw Error("Terminal owner continuity inventory is unavailable");
  const bootstrap=parseRecoveryBootstrap(Buffer.from(JSON.stringify(value.bootstrap)));
  const own=bootstrap.owner;
  if(bootstrap.observed!==undefined||own.pid!==expected.pid||own.startTime!==expected.startTime||own.instanceId!==expected.instanceId||own.binaryHash!==expected.hash||
    bootstrap.panes.length!==expected.inventory.length)throw Error("Terminal owner continuity identity or inventory changed");
  const ids=new Set<string>();
  for(const pane of expected.inventory){
    if(!pane||typeof pane!=="object"||typeof pane.id!=="string"||ids.has(pane.id)||pane.exited!==false||pane.acknowledged!==false)throw Error("Invalid terminal owner continuity inventory");
    ids.add(pane.id);
    const saved=bootstrap.panes.find(p=>p.id===pane.id);
    if(!saved||saved.pid!==pane.pid||saved.generation!==pane.generation||saved.startIdentity!==pane.startIdentity)throw Error("Terminal owner continuity pane generation changed");
  }
  return {credential:Buffer.from(value.secret,"hex"),bootstrap};
}

/** An announced recipient validates the exact receipt before completing the
 * credential transaction. Empty continuity never creates or probes an owner. */
export function validateTransferredOwnerContinuity(value:unknown,peer:HostAuthPeer,version:unknown):{credential:Buffer;bootstrap:RecoveryBootstrap|null;receipt:string}{
 const encoded=JSON.stringify(value);
 if(!encoded||Buffer.byteLength(encoded)>MAX_RECOVERY_BOOTSTRAP_BYTES||!closed(value,["format","host","secret","bootstrap","transferReceipt"])||typeof value.transferReceipt!=="string"||!/^[a-f0-9]{64}$/.test(value.transferReceipt))throw Error("Invalid transferred owner continuity response");
 const {transferReceipt,...body}=value;
 const raw=JSON.stringify(body.bootstrap);
 if(!raw||Buffer.byteLength(raw)>MAX_RECOVERY_BOOTSTRAP_BYTES||createHash("sha256").update(raw).digest("hex")!==transferReceipt)throw Error("Terminal owner continuity receipt changed");
 if(body.format===1)return {...validateOwnerContinuity(body,peer,version),receipt:transferReceipt};
 const status=version as {owner?:unknown;ptyCount?:unknown}|null;
 if(body.format!==2||!closed(body.host,["pid","startIdentity"])||body.host.pid!==peer.pid||body.host.startIdentity!==peer.startIdentity||typeof body.secret!=="string"||!/^[a-f0-9]{64}$/.test(body.secret)||
    !closed(body.bootstrap,["format","kind","owner","panes"])||body.bootstrap.format!==2||body.bootstrap.kind!=="empty"||body.bootstrap.owner!==null||!Array.isArray(body.bootstrap.panes)||body.bootstrap.panes.length!==0||status?.owner!==null||status.ptyCount!==0)throw Error("Terminal owner continuity is not empty");
 return {credential:Buffer.from(body.secret,"hex"),bootstrap:null,receipt:transferReceipt};
}
