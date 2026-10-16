// Main-side policy facade. Production activation is a separate integration step.
// Read-only explain never acknowledges a composer; delivery hold reads may do so
// only against an applied host revision and then must acquire fresh evidence.
import type {VtSnapshot, VtSnapshotFence} from "./vt-mirror";
import {GuardedRuleInput} from "./screen-user-rule-input";
import type {UserRuleProvider} from "./screen-user-rule-provider";
import type {CoordinatedRuleDecision} from "./screen-user-rule-coordinator";
import {HOLD_USER_RULES_UNKNOWN} from "./screen-user-rule-policy";
import {explainPaneSnapshot, unavailablePaneState, type PaneStateResult} from "./pane-state";

type AppliedDecision={screen:VtSnapshot;result:CoordinatedRuleDecision;configuration:ReturnType<UserRuleProvider["configuration"]>};
export class UserRulePanePolicy {
  private disposed=false;
  constructor(private input:GuardedRuleInput,private provider:Pick<UserRuleProvider,"configuration">,private host:{
    snapshot:(id:string)=>Promise<VtSnapshot|null>;
    markComposer:(id:string,fence:VtSnapshotFence)=>Promise<boolean>;
    legacyHold:(id:string,pasted?:string)=>Promise<string|null>;
    legacyBusy:(id:string)=>Promise<boolean>;
    legacyState:(id:string)=>Promise<PaneStateResult>;
  }){}
  private async applied(id:string,caller:string,pasted?:string):Promise<AppliedDecision|null>{
    const state=this.provider.configuration();
    if(this.disposed)return null;
    try{
      const screen=await this.host.snapshot(id);
      if(!screen||this.disposed||this.provider.configuration()!==state)return null;
      const result=await this.input.evaluateApplied(id,screen,caller,pasted);
      return result?.current&&!this.disposed&&this.provider.configuration()===state?{screen,result,configuration:state}:null;
    }catch{return null;}
  }
  async holdReason(id:string,pasted?:string):Promise<string|null>{
    if(this.disposed)return HOLD_USER_RULES_UNKNOWN;
    if(!this.input.configured())return this.host.legacyHold(id,pasted);
    const decision=await this.applied(id,"hold",pasted);
    if(!decision||this.provider.configuration()!==decision.configuration)return HOLD_USER_RULES_UNKNOWN;
    if(!decision.result.composerSeen)return decision.result.decision.hold;
    const state=decision.configuration,fence=decision.result.fence;
    if(!fence)return HOLD_USER_RULES_UNKNOWN;
    let acknowledged=false;
    try{acknowledged=await this.host.markComposer(id,fence);}catch{/* A lost ACK never permits stale clearance. */}
    if(!acknowledged||this.disposed||this.provider.configuration()!==state)return HOLD_USER_RULES_UNKNOWN;
    // Composer ACK advances the host revision. Neither the previous fence nor
    // its pre-ACK clearance may be used; output may have arrived meanwhile.
    const after=await this.applied(id,"hold-after-composer",pasted);
    if(!after||after.configuration!==state||this.provider.configuration()!==state||after.result.composerSeen)return HOLD_USER_RULES_UNKNOWN;
    return after.result.decision.hold;
  }
  async paneBusy(id:string):Promise<boolean>{
    if(this.disposed)return false;
    if(!this.input.configured())return this.host.legacyBusy(id);
    const applied=await this.applied(id,"busy");
    return applied&&this.provider.configuration()===applied.configuration?applied.result.decision.busy:false;
  }
  async paneState(id:string):Promise<PaneStateResult>{
    if(this.disposed)return unavailablePaneState(HOLD_USER_RULES_UNKNOWN);
    if(!this.input.configured())return this.host.legacyState(id);
    const applied=await this.applied(id,"explain");
    if(!applied||this.provider.configuration()!==applied.configuration){
      // A missing/stale screen is not proof that a valid rule set failed. A
      // second read-only status may still establish stopped/starting; never
      // borrow an active builtin-only clearance as an effective user decision.
      let terminal:PaneStateResult|null=null;
      try{terminal=await this.host.legacyState(id);}catch{}
      const configuration=this.provider.configuration();
      const userRules={available:configuration.available,digest:configuration.manifest?.digest??null,...(configuration.reason?{reason:configuration.reason}:{})};
      if(!this.disposed&&terminal&&(terminal.state==="stopped"||terminal.state==="starting"))return {...terminal,userRules};
      return {...unavailablePaneState("terminal screen unavailable or changed; automated input is held"),userRules,inputProtection:HOLD_USER_RULES_UNKNOWN};
    }
    const {screen,result}=applied,base=explainPaneSnapshot(screen),decision=result.decision;
    const state=screen.shell?"shell":base.state==="unknown"||!decision.user.available?"unknown":decision.waiting?"waiting":decision.busy?"busy":decision.hold?"held":"idle";
    const evidence=base.evidence.map(entry=>entry.for==="waiting"?{...entry,waiting:base.waiting}:entry);
    // Keep builtin provenance independently when an additive account/usage
    // contribution protects input behind the builtin displayed hold.
    const waitingWinner=["dialog","suppressor","prompt"].find(kind=>decision.user.evidence.some(match=>match.kind===kind));
    for(const match of decision.user.evidence){
      const kind=match.kind;
      if((kind==="prompt"||kind==="dialog"||kind==="suppressor")&&kind!==waitingWinner)continue;
      evidence.push({...(kind==="suppressor"?{waiting:false}:kind==="prompt"||kind==="dialog"?{waiting:true}:{}),for:kind==="busy"?"busy":kind==="prompt"||kind==="dialog"||kind==="suppressor"?"waiting":"hold",match});
    }
    return {...base,state,hold:decision.hold,busy:decision.busy,waiting:decision.waiting,userHold:decision.userHold,inputProtection:decision.inputProtection,userRules:{available:decision.user.available,digest:decision.user.digest,...(decision.user.reason?{reason:decision.user.reason}:{})},...(!decision.user.available?{reason:decision.user.reason,screenEvidence:false}:{}),evidence};
  }
  dispose():void{this.disposed=true;}
}
