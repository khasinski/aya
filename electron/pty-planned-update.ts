// Reserve the shared credential slot before B3 freezes any reader. Credential
// publication/ownership and the later native-reader commit remain independent.
import {performance} from "node:perf_hooks";
import type {PtyHostClient} from "./pty-host-client";
import type {HandoverDisplays} from "./pty-handover-display";
import {readHandoverTicket,type HandoverTicket} from "./pty-handover-ticket";
import {discardCheckpoint,type CheckpointReceipt} from "./pty-checkpoint-store";
import {AYA_HOME} from "./paths";
import {findAuthTransferTicket,authTransferTicketPath,writeAuthTransferTicket,cancelAuthTransferTicket,withinAuthTransferBudget,type AuthTransferTicket,type AuthTransferTicketBudget} from "./pty-host-auth-ticket";
import {PTY_HANDOVER_TICKET_PATH,PTY_HANDOVER_DISPLAY_DIRECTORY} from "./pty-host-paths";
import type {HostIdentity} from "./pty-host-staleness";
export interface PlannedUpdateDeps {
  host:Pick<PtyHostClient,"reservePlannedHandover"|"activatePlannedHandover"|"cancelPlannedAuth"|"redeemAnnouncedCapability"|"preparePlannedHandover"|"announcePlannedHandover"|"cancelPlannedHandover"|"adoptPlannedHandover"|"restart"|"hostStatus"> & Partial<Pick<PtyHostClient,"authorizePlannedFallback">>;
  displays:Pick<HandoverDisplays,"capture"|"inspect"|"acknowledgeEscrow"|"clear">;
  expected:()=>HostIdentity;
  livePaneIds?:()=>Promise<string[]>;
  confirmStop:(ids:readonly string[]|undefined,reason:string)=>Promise<boolean>;
  log:(event:string,fields:Record<string,unknown>)=>void;
  // Test-owned I/O/clock injection; production always uses the async private
  // ticket store and one monotonic <=120s preparation budget.
  publication?:{publish?:typeof writeAuthTransferTicket;cancel?:typeof cancelAuthTransferTicket;now?:()=>number;budgetMs?:number};
}
interface Preparation {
  cancel:AbortController;
  budget:AuthTransferTicketBudget;
  reservation:AuthTransferTicket|null;
  display:CheckpointReceipt|null;
  coreStarted:boolean;
  committed:boolean;
  userCancelled:boolean;
  work?:Promise<boolean>;
  cleanup?:Promise<void>;
  authCancel?:Promise<"cancelled"|"committed"|"unknown">;
  coreAbort?:Promise<boolean>;
  discarded?:CheckpointReceipt;
}
export class PlannedUpdate {
  private preparation:Promise<boolean>|null=null;
  private ticket:AuthTransferTicket|null=null;
  private current:Preparation|null=null;
  constructor(private readonly deps:PlannedUpdateDeps){}
  get hasPreparedHandover():boolean{return this.ticket!==null;}
  prepare():Promise<boolean> {
    if(this.preparation)return this.preparation;
    const now=this.deps.publication?.now??(()=>performance.now()),ms=this.deps.publication?.budgetMs??120000;
    if(!Number.isFinite(ms)||ms<1||ms>120000)throw Error("Invalid planned handover budget");
    const cancel=new AbortController(),attempt:Preparation={cancel,budget:{deadline:now()+ms,now,signal:cancel.signal},reservation:null,display:null,coreStarted:false,committed:false,userCancelled:false};
    this.current=attempt;
    const work=this.prepareOnce(attempt,Date.now()+ms).finally(()=>{
      if(this.current===attempt&&!this.ticket){this.current=null;this.preparation=null;}
    });
    attempt.work=work;this.preparation=work;return work;
  }
  private async prepareOnce(attempt:Preparation,deadline:number):Promise<boolean> {
    try{
      await withinAuthTransferBudget(attempt.budget,async check=>{
        try{
          // Store even a late reply on THIS attempt, never on a newer one.
          const ticket=await this.deps.host.reservePlannedHandover(deadline);attempt.reservation=ticket;check();
          attempt.coreStarted=true;
          const state=await this.deps.host.preparePlannedHandover(deadline,ticket.attempt);check();
          const consented=state.ineligible.map(p=>p.id);
          if(consented.length&&!await this.deps.confirmStop(consented,"Restarting to update")){attempt.userCancelled=true;attempt.cancel.abort();throw Error("Terminal handover cancelled");}
          check();attempt.display=await this.deps.displays.capture(state);check();
          const announced=await this.deps.host.announcePlannedHandover(state,attempt.display,consented,ticket.nonce,ticket.attempt);check();
          if(announced.hostPid!==ticket.hostPid||announced.hostStartIdentity!==ticket.hostStartIdentity||announced.nonce!==ticket.nonce||announced.deadline!==ticket.deadline)throw Error("Terminal handover target changed");
          await (this.deps.publication?.publish??writeAuthTransferTicket)(authTransferTicketPath(AYA_HOME,ticket.attempt),ticket,attempt.budget);check();
          await this.deps.host.activatePlannedHandover(ticket.attempt);check();
          if(this.current!==attempt)throw Error("Terminal handover attempt changed");
          this.ticket=ticket;
        }finally{
          // A timed-out operation may finish later. Cleanup is scoped by its
          // original attempt/nonce and rechecks newly returned display/file I/O.
          if(attempt.cancel.signal.aborted)void this.cleanupLate(attempt).catch(error=>this.deps.log("host-transfer-cleanup-refused",{reason:String(error)}));
        }
      });
      return true;
    }catch(error){
      attempt.cancel.abort();await this.cleanup(attempt);
      if(attempt.userCancelled||this.current!==attempt)return false;
      this.deps.log("planned-handover-unavailable",{reason:String(error)});
      const yes=await this.deps.confirmStop(undefined,"Restarting to update");
      return yes&&!attempt.userCancelled&&this.current===attempt;
    }
  }
  private async cleanupLate(attempt:Preparation):Promise<void> {
    // The first cleanup may already have passed its display check while a
    // renderer or ticket write was still completing. Re-scan after that pass.
    await attempt.cleanup;
    await this.cleanup(attempt);
  }
  private cleanup(attempt:Preparation):Promise<void> {
    return attempt.cleanup??=this.cleanupOnce(attempt).finally(()=>{attempt.cleanup=undefined;});
  }
  private async cleanupOnce(attempt:Preparation):Promise<void> {
    const ticket=attempt.reservation;if(!ticket)return; // A losing reserve owns no core.
    const outcome=await (attempt.authCancel??=this.deps.host.cancelPlannedAuth(ticket.attempt).catch(()=>"unknown" as const));
    attempt.committed=outcome==="committed";
    // Recipient commit cannot be undone by issuer cleanup. The distinct core
    // abort is permitted only after this issuer's unclaimed window is sealed.
    if(outcome==="cancelled"&&attempt.coreStarted){
      const aborted=await (attempt.coreAbort??=this.deps.host.cancelPlannedHandover(ticket.attempt).then(()=>true,()=>false));
      if(aborted&&attempt.display&&attempt.discarded!==attempt.display){
        const display=attempt.display;attempt.discarded=display;
        await discardCheckpoint(PTY_HANDOVER_DISPLAY_DIRECTORY,display).catch(error=>{if(error.code!=="ENOENT")this.deps.log("checkpoint-cleanup-refused",{reason:String(error)});});
      }
    }
    const now=this.deps.publication?.now??(()=>performance.now());
    await (this.deps.publication?.cancel??cancelAuthTransferTicket)(authTransferTicketPath(AYA_HOME,ticket.attempt),ticket.attempt,ticket.nonce,{deadline:now()+2000,now}).catch(error=>this.deps.log("host-transfer-cleanup-refused",{reason:String(error)}));
    if(!attempt.committed&&this.current===attempt&&this.ticket===ticket)this.ticket=null;
  }
  async abort():Promise<void> {
    const attempt=this.current;if(!attempt)return;
    attempt.userCancelled=true;attempt.cancel.abort();await attempt.work?.catch(()=>{});await this.cleanup(attempt);
    if(this.current===attempt&&!attempt.committed){this.ticket=null;this.preparation=null;this.current=null;}
  }
  /** Kept means Cancel: the caller leaves the old host and red dot intact. */
  async resume(announced?:HandoverTicket):Promise<"none"|"restored"|"kept"> {
    let ticket:HandoverTicket|null;
    try{
      ticket=announced??await findAuthTransferTicket(AYA_HOME)??readHandoverTicket(PTY_HANDOVER_TICKET_PATH);
      if(!announced&&ticket&&"format" in ticket)await this.deps.host.redeemAnnouncedCapability(ticket as AuthTransferTicket);
    }catch(error){return this.refused(error);}
    if(!ticket)return "none";
    try{
      const state=await this.deps.host.adoptPlannedHandover(ticket,this.deps.expected(),value=>this.deps.displays.inspect(value));
      if(state.display)await this.deps.displays.acknowledgeEscrow(state.display).catch(error=>{if(error.code!=="ENOENT")this.deps.log("checkpoint-cleanup-refused",{reason:String(error)});});
      this.deps.log("planned-handover-complete",{panes:state.eligible.length,fallback:state.consented.length});
      return "restored";
    }catch(error){return this.refused(error);}
  }
  private async refused(error:unknown):Promise<"restored"|"kept"> {
    this.deps.displays.clear();this.deps.log("planned-handover-refused",{reason:String(error)});
    const ids=await this.deps.livePaneIds?.()??[];
    if(!await this.deps.confirmStop(undefined,"Restarting the terminals after the planned handover could not complete"))return "kept";
    this.deps.host.authorizePlannedFallback?.(ids);
    if(!await this.deps.host.restart())return "kept";
    return "restored";
  }
}
