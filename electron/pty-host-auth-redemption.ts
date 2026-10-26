// A dedicated pre-auth credential exchange, never an application RPC parser.
import {randomBytes,createHash,createHmac,timingSafeEqual} from "node:crypto";
import {performance} from "node:perf_hooks";
import type {Socket} from "node:net";
import type {AuthTransferTicket} from "./pty-host-auth-ticket";
import type {HostAuthPeer} from "./pty-host-auth";
import {HostAuthTransfer,HostAuthTransferError,validAuthTransferDeadline,type AuthRedemptionFailure} from "./pty-host-auth-transfer";
import {handoverPeer} from "./pty-handover-window";
export const AUTH_REDEMPTION_BYTES=1024;
export const AUTH_REDEMPTION_MS=5000;
const hex=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
const peerOk=(p:HostAuthPeer):boolean=>!!p&&Number.isSafeInteger(p.pid)&&p.pid>1&&typeof p.startIdentity==="string"&&/^\d+:\d+$/.test(p.startIdentity)&&p.startIdentity.length<=63;
function frame(line:string,keys:readonly string[]):Record<string,unknown>{
 if(Buffer.byteLength(line)>AUTH_REDEMPTION_BYTES)throw new HostAuthTransferError();
 const v=JSON.parse(line) as unknown;
 if(!v||typeof v!=="object"||Array.isArray(v)||Object.keys(v).sort().join(",")!==[...keys].sort().join(","))throw new HostAuthTransferError();
 return v as Record<string,unknown>;
}
interface Transcript {attempt:string;purpose:string;deadline:number|null;clientNonce:string;serverNonce:string;instance:string;host:HostAuthPeer;client:HostAuthPeer;credential:string}
function proof(nonce:string,t:Transcript):string{
 const secret=Buffer.from(nonce,"hex");
 try{
  // A transcript MAC, not password hashing/storage. Both the nonce and host
  // capability are independent random256-bit values. Hashing the canonical
  // capability bytes binds the response without embedding them in the MAC
  // transcript; the receiver independently recomputes this digest.
  const capability=Buffer.from(t.credential,"base64");
  let capabilityDigest:string;
  try{capabilityDigest=createHash("sha256").update(capability).digest("hex");}finally{capability.fill(0);}
  return createHmac("sha256",secret).update(JSON.stringify(["aya-pty-host-transfer",1,"credential-digest",t.attempt,t.purpose,t.deadline,t.clientNonce,t.serverNonce,t.instance,t.host.pid,t.host.startIdentity,t.client.pid,t.client.startIdentity,capabilityDigest])).digest("hex");
 }
 finally{secret.fill(0);}
}
export class HostRedemptionServer {
 private used=false;
 private readonly deadline:number;
 private failure:AuthRedemptionFailure="malformed";
 constructor(private readonly transfer:HostAuthTransfer,private readonly host:HostAuthPeer,private readonly client:HostAuthPeer,private readonly clock:()=>number=()=>performance.now(),private readonly instance=randomBytes(32).toString("hex")){
  if(!peerOk(host)||!peerOk(client)||!hex(instance))throw new HostAuthTransferError();this.deadline=clock()+AUTH_REDEMPTION_MS;
 }
 get refusalReason():AuthRedemptionFailure{return this.failure;}
 receive(line:string):string{
  try{
   if(this.used||this.clock()>=this.deadline){this.failure="expired";throw new HostAuthTransferError();}this.used=true;
   const m=frame(line,["type","version","attempt","purpose","deadline","nonce","clientNonce","hostPid","hostStartIdentity"]);
   if(m.type!=="pty-transfer-redeem"||m.version!==1||!hex(m.attempt)||!hex(m.clientNonce)||(m.purpose!=="ordinary-quit"&&m.purpose!=="planned-update")||m.hostPid!==this.host.pid||m.hostStartIdentity!==this.host.startIdentity)throw new HostAuthTransferError();
   const stateFailure=this.transfer.redemptionFailure(m.attempt,m.purpose,m.deadline);
   if(!validAuthTransferDeadline(m.purpose,m.deadline)){this.failure=stateFailure??"other";this.transfer.refuseActiveRedemption();}
   if(stateFailure){this.failure=stateFailure;this.transfer.refuseActiveRedemption();}
   if(this.clock()>=this.deadline){this.failure="expired";throw new HostAuthTransferError();}
   this.failure="other";
   const key=this.transfer.redeem(m.attempt,m.nonce as string,this.client);
   try{
    const credential=key.toString("base64"),serverNonce=randomBytes(32).toString("hex");
    const transcript:Transcript={attempt:m.attempt,purpose:m.purpose,deadline:m.deadline as number|null,clientNonce:m.clientNonce,serverNonce,instance:this.instance,host:this.host,client:this.client,credential};
    return JSON.stringify({type:"pty-transfer-credential",version:1,serverNonce,instance:this.instance,credential,proof:proof(m.nonce as string,transcript)});
   }finally{key.fill(0);}
  }catch{throw new HostAuthTransferError();}
 }
}
export class HostRedemptionClient {
 readonly hello:string;
 private used=false;
 private readonly deadline:number;
 private readonly clientNonce=randomBytes(32).toString("hex");
 constructor(private readonly ticket:AuthTransferTicket,private readonly host:HostAuthPeer,private readonly client:HostAuthPeer,private readonly clock:()=>number=()=>performance.now()){
  if(!peerOk(host)||!peerOk(client)||ticket.format!==2||host.pid!==ticket.hostPid||host.startIdentity!==ticket.hostStartIdentity||!hex(ticket.attempt)||!hex(ticket.nonce)||(ticket.purpose!=="ordinary-quit"&&ticket.purpose!=="planned-update")||!validAuthTransferDeadline(ticket.purpose,ticket.deadline,Date.now()))throw new HostAuthTransferError();
  this.deadline=clock()+AUTH_REDEMPTION_MS;
  this.hello=JSON.stringify({type:"pty-transfer-redeem",version:1,attempt:ticket.attempt,purpose:ticket.purpose,deadline:ticket.deadline,nonce:ticket.nonce,clientNonce:this.clientNonce,hostPid:host.pid,hostStartIdentity:host.startIdentity});
 }
 receive(line:string):Buffer{
  let key:Buffer|undefined;
  try{
   if(this.used||this.clock()>=this.deadline||!validAuthTransferDeadline(this.ticket.purpose,this.ticket.deadline,Date.now()))throw new HostAuthTransferError();this.used=true;
   const m=frame(line,["type","version","serverNonce","instance","credential","proof"]);
   if(m.type!=="pty-transfer-credential"||m.version!==1||!hex(m.serverNonce)||!hex(m.instance)||!hex(m.proof)||typeof m.credential!=="string"||!/^[A-Za-z0-9+/]{43}=$/.test(m.credential))throw new HostAuthTransferError();
   key=Buffer.from(m.credential,"base64");if(key.length!==32||key.toString("base64")!==m.credential)throw new HostAuthTransferError();
   const expected=proof(this.ticket.nonce,{attempt:this.ticket.attempt,purpose:this.ticket.purpose,deadline:this.ticket.deadline,clientNonce:this.clientNonce,serverNonce:m.serverNonce,instance:m.instance,host:this.host,client:this.client,credential:m.credential});
   if(!timingSafeEqual(Buffer.from(expected,"hex"),Buffer.from(m.proof,"hex"))||this.clock()>=this.deadline||!validAuthTransferDeadline(this.ticket.purpose,this.ticket.deadline,Date.now()))throw new HostAuthTransferError();
   return key;
  }catch{key?.fill(0);this.used=true;throw new HostAuthTransferError();}
 }
}
type PeerReader=(socket:Socket)=>HostAuthPeer;
/** Exactly one bounded frame; no suffix is returned to an RPC/event parser. */
function receiveFrame<T>(socket:Socket,consume:(line:string)=>T,deadline:number):Promise<T>{
 return new Promise((resolve,reject)=>{
  let buffer="",done=false;
  const cleanup=()=>{clearTimeout(timer);socket.off("data",data);socket.off("error",fail);socket.off("close",fail);};
  const fail=()=>{if(done)return;done=true;cleanup();socket.destroy();reject(new HostAuthTransferError());};
  const timer=setTimeout(fail,Math.max(0,deadline-performance.now()));
  const data=(chunk:string|Buffer)=>{
   if(done)return;buffer+=String(chunk);
   if(Buffer.byteLength(buffer)>AUTH_REDEMPTION_BYTES+1){fail();return;}
   const end=buffer.indexOf("\n");if(end<0){if(Buffer.byteLength(buffer)>AUTH_REDEMPTION_BYTES)fail();return;}
   if(end!==buffer.length-1){fail();return;}
   try{
    if(performance.now()>=deadline)throw new HostAuthTransferError();
    const value=consume(buffer.slice(0,end));
    if(performance.now()>=deadline){if(Buffer.isBuffer(value))value.fill(0);throw new HostAuthTransferError();}
    done=true;cleanup();socket.pause();resolve(value);
   }catch{fail();}
  };
  socket.setEncoding("utf8");socket.on("data",data);socket.on("error",fail);socket.on("close",fail);
  if(socket.destroyed||!socket.writable)fail();else socket.resume();
 });
}
/** The integrated acceptor must share its existing 32-pending-socket cap. */
export async function acceptHostRedemption(socket:Socket,transfer:HostAuthTransfer,ownPeer:HostAuthPeer,readPeer:PeerReader=handoverPeer):Promise<void>{
 const deadline=performance.now()+AUTH_REDEMPTION_MS;socket.on("error",()=>{});
 try{
  const session=new HostRedemptionServer(transfer,ownPeer,readPeer(socket));
  const response=await receiveFrame(socket,line=>session.receive(line),deadline);
  socket.on("error",()=>{});socket.end(response+"\n",()=>socket.destroy());
  const closing=setTimeout(()=>socket.destroy(),1000);closing.unref();socket.once("close",()=>clearTimeout(closing));
 }catch{socket.destroy();throw new HostAuthTransferError();}
}
export async function redeemHostCapability(socket:Socket,ticket:AuthTransferTicket,ownPeer:HostAuthPeer,readPeer:PeerReader=handoverPeer):Promise<Buffer>{
 const deadline=performance.now()+AUTH_REDEMPTION_MS;socket.on("error",()=>{});
 try{
  // Verify the kernel target before even presenting the nonce.
  const session=new HostRedemptionClient(ticket,readPeer(socket),ownPeer),result=receiveFrame(socket,line=>session.receive(line),deadline);
  void result.catch(()=>{}); // also own rejection if socket.write throws
  socket.write(session.hello+"\n");
  try{return await result;}finally{socket.destroy();}
 }catch{socket.destroy();throw new HostAuthTransferError();}
}
