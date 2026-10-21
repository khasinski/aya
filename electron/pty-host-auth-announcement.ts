// Main-only ordinary quit transaction. No PTY freeze or process lifecycle.
import {randomBytes} from "node:crypto";
import {performance} from "node:perf_hooks";
import type {PtyHostRequest} from "./pty-host-protocol";
import type {HostAuthPeer} from "./pty-host-auth";
import {AUTH_QUIT_PUBLICATION_MS} from "./pty-host-auth-transfer";
import {authTransferTicketPath,writeAuthTransferTicket,cancelAuthTransferTicket,withinAuthTransferBudget,type AuthTransferTicket,type AuthTransferTicketBudget} from "./pty-host-auth-ticket";
interface Deps {
 home:string;
 connected:()=>boolean;
 peer:()=>HostAuthPeer;
 control:(request:PtyHostRequest)=>Promise<unknown>;
 log:(event:string,fields:Record<string,unknown>)=>void;
 publish?:typeof writeAuthTransferTicket;
 cancelFile?:typeof cancelAuthTransferTicket;
 now?:()=>number;
 budgetMs?:number;
 replacedBuild?:boolean;
}
export class OrdinaryAuthAnnouncement {
 private preparation:Promise<boolean>|null=null;
 private readonly cancelled=new AbortController();
 private ticket:AuthTransferTicket|null=null;
 private cleanupWork:Promise<void>|null=null;
 constructor(private readonly deps:Deps){}
 prepare():Promise<boolean>{return this.preparation??=this.run();}
 private async run():Promise<boolean>{
  if(!this.deps.connected()||this.cancelled.signal.aborted)return false;
  const now=this.deps.now??(()=>performance.now());
  const budget:AuthTransferTicketBudget={deadline:now()+(this.deps.budgetMs??AUTH_QUIT_PUBLICATION_MS),now,signal:this.cancelled.signal};
  try{
   await withinAuthTransferBudget(budget,async check=>{
    const peer=this.deps.peer();check();
    const nonce=randomBytes(32).toString("hex"),deadline=null;
    const replacedBuild=this.deps.replacedBuild??false;
    const value=await this.deps.control({id:0,type:"auth-transfer-reserve",purpose:"ordinary-quit",nonce,deadline});check();
    const result=value as Record<string,unknown>|null;
    if(!result||typeof result!=="object"||Object.keys(result).sort().join(",")!=="attempt,deadline,hostPid,hostStartIdentity,purpose"||typeof result.attempt!=="string"||!/^[a-f0-9]{64}$/.test(result.attempt)||result.purpose!=="ordinary-quit"||result.deadline!==deadline||result.hostPid!==peer.pid||result.hostStartIdentity!==peer.startIdentity)throw Error("Invalid terminal transfer reservation");
    this.ticket={format:2,attempt:result.attempt,purpose:"ordinary-quit",deadline,replacedBuild,nonce,hostPid:peer.pid,hostStartIdentity:peer.startIdentity};
    await (this.deps.publish??writeAuthTransferTicket)(authTransferTicketPath(this.deps.home,this.ticket.attempt),this.ticket,budget);check();
    if(!this.deps.connected())throw Error("Terminal connection changed before announcement");
    const activated=await this.deps.control({id:0,type:"auth-transfer-activate",attempt:this.ticket.attempt});check();
    if(activated!==true)throw Error("Terminal transfer activation refused");
   });
   this.deps.log("host-transfer-announced",{purpose:"ordinary-quit",hostPid:this.ticket!.hostPid});return true;
  }catch{
   // Cancellation is best effort and attempt-owned. It cannot delay quit
   // beyond the parent publication budget or undo a committed recipient.
   void this.cleanup();this.deps.log("host-transfer-unavailable",{purpose:"ordinary-quit"});return false;
  }
 }
 private cleanup():Promise<void>{
  return this.cleanupWork??=this.cleanupOnce();
 }
 private async cleanupOnce():Promise<void>{
  const ticket=this.ticket;if(!ticket)return;
  const now=this.deps.now??(()=>performance.now()),budget={deadline:now()+AUTH_QUIT_PUBLICATION_MS,now};
  const file=(this.deps.cancelFile??cancelAuthTransferTicket)(authTransferTicketPath(this.deps.home,ticket.attempt),ticket.attempt,ticket.nonce,budget);
  const control=this.deps.connected()?withinAuthTransferBudget(budget,async()=>{await this.deps.control({id:0,type:"auth-transfer-cancel",attempt:ticket.attempt});}):Promise.resolve();
  await Promise.allSettled([file,control]);
 }
 async abort():Promise<void>{this.cancelled.abort();await this.preparation;await this.cleanup();}
}
