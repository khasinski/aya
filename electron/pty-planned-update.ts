// Planned updates alone announce the nonce. Ordinary quit and crash recovery
// keep their existing behavior. All refusal decisions precede process death.
import {randomBytes} from "node:crypto";
import type {PtyHostClient} from "./pty-host-client";
import type {HandoverDisplays} from "./pty-handover-display";
import {readHandoverTicket,writeHandoverTicket,cancelHandoverTicket,type HandoverTicket} from "./pty-handover-ticket";
import {discardCheckpoint,type CheckpointReceipt} from "./pty-checkpoint-store";
import {PTY_HANDOVER_TICKET_PATH,PTY_HANDOVER_DISPLAY_DIRECTORY} from "./pty-host-paths";
import type {HostIdentity} from "./pty-host-staleness";
export interface PlannedUpdateDeps {
  host:Pick<PtyHostClient,"preparePlannedHandover"|"announcePlannedHandover"|"cancelPlannedHandover"|"adoptPlannedHandover"|"restart"|"hostStatus"> & Partial<Pick<PtyHostClient,"authorizePlannedFallback">>;
  displays:Pick<HandoverDisplays,"capture"|"inspect"|"acknowledgeEscrow"|"clear">;
  expected:()=>HostIdentity;
  livePaneIds?:()=>Promise<string[]>;
  confirmStop:(ids:readonly string[]|undefined,reason:string)=>Promise<boolean>;
  log:(event:string,fields:Record<string,unknown>)=>void;
}
export class PlannedUpdate {
  private preparation:Promise<boolean>|null=null;
  private ticket:HandoverTicket|null=null;
  constructor(private readonly deps:PlannedUpdateDeps){}
  prepare():Promise<boolean> {
    return this.preparation??=this.prepareOnce().finally(()=>{if(!this.ticket)this.preparation=null;});
  }
  private async prepareOnce():Promise<boolean> {
    let display:CheckpointReceipt|null=null;
    try{
      const state=await this.deps.host.preparePlannedHandover(Date.now()+120000);
      const consented=state.ineligible.map(p=>p.id);
      if(consented.length&&!await this.deps.confirmStop(consented,"Restarting to update")){await this.deps.host.cancelPlannedHandover();return false;}
      display=await this.deps.displays.capture(state);
      const ticket=await this.deps.host.announcePlannedHandover(state,display,consented,randomBytes(32).toString('hex'));
      writeHandoverTicket(PTY_HANDOVER_TICKET_PATH,ticket);this.ticket=ticket;
      return true;
    }catch(error){
      await this.deps.host.cancelPlannedHandover().catch(()=>{});
      if(display)await discardCheckpoint(PTY_HANDOVER_DISPLAY_DIRECTORY,display).catch(e=>{if(e.code!=="ENOENT")this.deps.log("checkpoint-cleanup-refused",{reason:String(e)});});
      this.deps.log("planned-handover-unavailable",{reason:String(error)});
      return this.deps.confirmStop(undefined,"Restarting to update");
    }
  }
  async abort():Promise<void> {
    if(!this.ticket)return;
    try{
      cancelHandoverTicket(PTY_HANDOVER_TICKET_PATH,this.ticket.nonce);
    }finally{
      this.ticket=null;this.preparation=null;
      await this.deps.host.cancelPlannedHandover();
    }
  }
  /** Kept means Cancel: the caller leaves the old host and red dot intact. */
  async resume():Promise<"none"|"restored"|"kept"> {
    let ticket:HandoverTicket|null;
    try{ticket=readHandoverTicket(PTY_HANDOVER_TICKET_PATH);}catch(error){return this.refused(error);}
    if(!ticket)return "none";
    try{
      const state=await this.deps.host.adoptPlannedHandover(ticket,this.deps.expected(),value=>this.deps.displays.inspect(value));
      // Reuse ACK already removed its display escrow. A replacement's new main
      // owns the validated display cache and acknowledges the private files.
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
