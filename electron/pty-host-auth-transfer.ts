// Credential-window state only. This never detaches a PTY reader/owner lease;
// B3's independent core commit remains the authority for that operation.
import {randomBytes,timingSafeEqual} from "node:crypto";
import {performance} from "node:perf_hooks";
import type {HostAuthPeer} from "./pty-host-auth";
export const AUTH_TRANSFER_WINDOW_MS=120_000;
export const AUTH_QUIT_PUBLICATION_MS=2_000;
export type AuthTransferPurpose="ordinary-quit"|"planned-update";
export interface AuthTransferReservation {attempt:string;purpose:AuthTransferPurpose;deadline:number}
type Phase="reserved"|"active"|"claimed"|"owned"|"sealed";
interface Attempt extends AuthTransferReservation {
  phase:Phase;issuer:HostAuthPeer;nonce:Buffer;expires:number;activateBy:number;
  recipient?:HostAuthPeer;continuity?:string;completedReceipt?:string;
}
export class HostAuthTransferError extends Error {
  constructor(){super("Terminal host credential transfer refused");}
}
const hex=(value:unknown):value is string=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value);
function validPeer(peer:HostAuthPeer):boolean{return !!peer&&Object.keys(peer).length===2&&Object.hasOwn(peer,"pid")&&Object.hasOwn(peer,"startIdentity")&&Number.isSafeInteger(peer.pid)&&peer.pid>1&&typeof peer.startIdentity==="string"&&/^\d+:\d+$/.test(peer.startIdentity)&&peer.startIdentity.length<=63;}
function same(a:HostAuthPeer|undefined,b:HostAuthPeer):boolean{return !!a&&a.pid===b.pid&&a.startIdentity===b.startIdentity;}
function refuse():never{throw new HostAuthTransferError();}
/** Main uses this only when the creation guard authorizes a NEW host. No disk
 * key can be read, repaired or reused by this in-memory primitive. */
export function newHostAuthCapability():Buffer{return randomBytes(32);}
export class HostAuthTransfer {
  private attempt:Attempt|null=null;
  private disposed=false;
  private readonly capability:Buffer;
  constructor(capability:Buffer,private readonly clock:{wall:()=>number;monotonic:()=>number}={wall:Date.now,monotonic:()=>performance.now()}){
    if(!Buffer.isBuffer(capability)||capability.length!==32)refuse();
    this.capability=Buffer.from(capability);
  }
  private seal(attempt:Attempt):void{attempt.phase="sealed";attempt.nonce.fill(0);}
  private expire():void{
    const a=this.attempt;if(!a)return;
    const now=this.clock.monotonic();
    if((a.phase==="reserved"&&(now>=a.expires||now>=a.activateBy))||(a.phase==="active"&&now>=a.expires))this.seal(a);
  }
  get phase():Phase|"empty"{this.expire();return this.attempt?.phase??"empty";}
  /** Called only behind ordinary authentication, before any B3 freeze or I/O. */
  reserve(issuer:HostAuthPeer,purpose:AuthTransferPurpose,nonce:string,deadline:number):AuthTransferReservation{
    this.expire();const prior=this.attempt,wall=this.clock.wall(),now=this.clock.monotonic();
    if(this.disposed||!validPeer(issuer)||(purpose!=="ordinary-quit"&&purpose!=="planned-update")||!hex(nonce)||!Number.isSafeInteger(deadline)||deadline<=wall||deadline-wall>AUTH_TRANSFER_WINDOW_MS)refuse();
    if(prior&&(prior.phase!=="owned"||!same(prior.recipient,issuer)))refuse();
    if(prior)prior.nonce.fill(0);
    const reservation={attempt:randomBytes(32).toString("hex"),purpose,deadline};
    this.attempt={...reservation,phase:"reserved",issuer:{...issuer},nonce:Buffer.from(nonce,"hex"),expires:now+(deadline-wall),activateBy:purpose==="ordinary-quit"?Math.min(now+AUTH_QUIT_PUBLICATION_MS,now+(deadline-wall)):now+(deadline-wall)};
    return {...reservation};
  }
  activate(issuer:HostAuthPeer,attempt:string):void{
    this.expire();const a=this.attempt;
    if(!a||a.phase!=="reserved"||a.attempt!==attempt||!validPeer(issuer)||!same(a.issuer,issuer))refuse();
    a.phase="active";
  }
  /** Issuer cleanup cannot undo a committed credential recipient or a B3
   * reader commit. Caller must separately honor B3's own abort/commit result. */
  cancel(issuer:HostAuthPeer,attempt:string):"cancelled"|"committed"{
    this.expire();const a=this.attempt;
    if(!a||a.attempt!==attempt||!validPeer(issuer)||!same(a.issuer,issuer))refuse();
    if(a.phase==="claimed"||a.phase==="owned")return "committed";
    this.seal(a);return "cancelled";
  }
  /** The dedicated pre-auth exchange calls this once after binding the kernel
   * peer and transcript. Commit precedes credential release and any await. */
  redeem(attempt:string,nonce:string,recipient:HostAuthPeer):Buffer{
    this.expire();const a=this.attempt;
    if(!a||a.phase!=="active")refuse();
    // Even a wrong request closes this active window, without displacing its
    // issuer's authenticated principal or touching the PTY core.
    if(a.attempt!==attempt||!hex(nonce)||!validPeer(recipient)||same(a.issuer,recipient)||!timingSafeEqual(a.nonce,Buffer.from(nonce,"hex"))){this.seal(a);refuse();}
    a.phase="claimed";a.recipient={...recipient};a.nonce.fill(0);
    return Buffer.from(this.capability);
  }
  /** Called only after the authenticated owner-continuity response is built.
   * Its exact manifest receipt is acknowledged by the same validated main. */
  noteContinuity(recipient:HostAuthPeer,attempt:string,receipt:string):void{
    const a=this.attempt;
    if(!a||a.phase!=="claimed"||a.attempt!==attempt||!validPeer(recipient)||!same(a.recipient,recipient)||!hex(receipt))refuse();
    a.continuity=receipt;
  }
  complete(recipient:HostAuthPeer,attempt:string,receipt:string):void{
    const a=this.attempt;
    if(!a||a.attempt!==attempt||!validPeer(recipient)||!same(a.recipient,recipient)||!hex(receipt))refuse();
    if(a.phase==="owned"&&a.completedReceipt===receipt)return;
    if(a.phase!=="claimed"||a.continuity!==receipt)refuse();
    a.phase="owned";a.completedReceipt=receipt;a.continuity=undefined;
  }
  dispose():void{this.disposed=true;if(this.attempt)this.seal(this.attempt);this.capability.fill(0);}
}
