// Receipt metadata only. No credential enters this hash or the checkpoint.
// Unlike crash continuity, a planned checkpoint includes unapplied ended panes.
import {createHash} from "node:crypto";
import type {HostAuthPeer} from "./pty-host-auth";
import type {RecoveryOwnerIdentity} from "./pty-owner-runtime";
import type {HostHandoverState} from "./pty-host-handover";
import {handoverState} from "./pty-handover-state";

const closed=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).sort().join(",")===keys.sort().join(",");
const hex=(v:unknown,n:number):v is string=>typeof v==="string"&&new RegExp(`^[a-f0-9]{${n}}$`).test(v);
export function plannedContinuityReceipt(attempt:string,host:HostAuthPeer,owner:RecoveryOwnerIdentity,state:HostHandoverState):string {
  // Explicit field order makes the receipt independent of response key order.
  const body={format:1,purpose:"planned-update",attempt,host:{pid:host.pid,startIdentity:host.startIdentity},owner:{pid:owner.pid,startTime:owner.startTime,instanceId:owner.instanceId,binaryHash:owner.binaryHash},
    checkpoint:{core:{bytes:state.core.bytes,nonce:state.core.nonce,sha256:state.core.sha256},display:state.display?{bytes:state.display.bytes,nonce:state.display.nonce,sha256:state.display.sha256}:null,
      coreRawBytes:state.coreRawBytes,coreEncodedBytes:state.coreEncodedBytes,displayRawBytes:state.displayRawBytes,displayEncodedBytes:state.displayEncodedBytes,deadline:state.deadline,
      eligible:state.eligible.map(p=>({id:p.id,generation:p.generation,outputEnd:p.outputEnd})),ineligible:state.ineligible.map(p=>({id:p.id,reason:p.reason})),consented:state.consented}};
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}
/** Callers must still preflight every raw core part and inspect the display
 * before sending the completion ACK. This checks the bounded control plane. */
export function validatePlannedContinuity(value:unknown,attempt:string,peer:HostAuthPeer,version:unknown,deadline:number):{state:HostHandoverState;owner:RecoveryOwnerIdentity;receipt:string} {
  if(!hex(attempt,64)||!closed(value,["checkpoint","credential","continuity"])||!closed(value.continuity,["owner","receipt"])||!closed(value.continuity.owner,["pid","startTime","instanceId","binaryHash"]))throw Error("Invalid planned owner continuity");
  const owner=value.continuity.owner,expected=(version as {owner?:Record<string,unknown>}|null)?.owner;
  if(!Number.isSafeInteger(owner.pid)||(owner.pid as number)<2||typeof owner.startTime!=="string"||!owner.startTime.length||owner.startTime.length>128||!hex(owner.instanceId,32)||!hex(owner.binaryHash,64)||!hex(value.continuity.receipt,64)||
    !expected||expected.incompatible!==false||!Array.isArray(expected.disconnected)||expected.disconnected.length||owner.pid!==expected.pid||owner.startTime!==expected.startTime||owner.instanceId!==expected.instanceId||owner.binaryHash!==expected.hash)throw Error("Planned owner identity changed");
  const state=handoverState(value.checkpoint,deadline),identity=owner as unknown as RecoveryOwnerIdentity;
  const receipt=plannedContinuityReceipt(attempt,peer,identity,state);
  if(receipt!==value.continuity.receipt)throw Error("Planned owner continuity receipt changed");
  return {state,owner:identity,receipt};
}
