// Main-side policy facade. Production activation is a separate integration step.
// Read-only explain never acknowledges a composer; delivery hold reads may do so
// only against an applied host revision and then must acquire fresh evidence.
import type {VtSnapshot, VtSnapshotFence} from "./vt-mirror";
import {GuardedRuleInput} from "./screen-user-rule-input";
import type {UserRuleProvider} from "./screen-user-rule-provider";
import type {CoordinatedRuleDecision} from "./screen-user-rule-coordinator";
import {HOLD_USER_RULES_UNKNOWN} from "./screen-user-rule-policy";
import {snapshotStatus} from "./vt-state";
import {explainPaneSnapshot, unavailablePaneState, type PaneStateResult} from "./pane-state";

type Configuration=ReturnType<UserRuleProvider["configuration"]>;
type AppliedDecision={screen:VtSnapshot;result:CoordinatedRuleDecision;configuration:Configuration};
export interface UserRuleScreenStatus {generation:string;revision:string;waiting:boolean;dialog?:string}
const configured=(state:Configuration):boolean=>!state.available||state.manifest!==null;
export class UserRulePanePolicy {
  private disposed=false;
  constructor(private input:GuardedRuleInput,private provider:Pick<UserRuleProvider,"configuration">,private host:{
    snapshot:(id:string)=>Promise<VtSnapshot|null>;
    markComposer:(id:string,fence:VtSnapshotFence)=>Promise<boolean>;
    legacyHold:(id:string,pasted?:string)=>Promise<string|null>;
    legacyBusy:(id:string)=>Promise<boolean>;
    legacyState:(id:string)=>Promise<PaneStateResult>;
  }){}
  private async applied(id:string,caller:string,state:Configuration,pasted?:string):Promise<AppliedDecision|null>{
    if(this.disposed||this.provider.configuration()!==state)return null;
    try{
      const screen=await this.host.snapshot(id);
      if(!screen||this.disposed||this.provider.configuration()!==state)return null;
      const result=await this.input.evaluateApplied(id,screen,caller,pasted);
      return result?.current&&!this.disposed&&this.provider.configuration()===state?{screen,result,configuration:state}:null;
    }catch{return null;}
  }
  async holdReason(id:string,pasted?:string):Promise<string|null>{
    const captured=this.provider.configuration();
    if(this.disposed)return HOLD_USER_RULES_UNKNOWN;
    if(!configured(captured)){
      try{const hold=await this.host.legacyHold(id,pasted);return !this.disposed&&this.provider.configuration()===captured?hold:HOLD_USER_RULES_UNKNOWN;}
      catch{return HOLD_USER_RULES_UNKNOWN;}
    }
    const decision=await this.applied(id,"hold",captured,pasted);
    if(!decision||decision.configuration!==captured||this.disposed||this.provider.configuration()!==captured)return HOLD_USER_RULES_UNKNOWN;
    if(!decision.result.composerSeen)return decision.result.decision.hold;
    const fence=decision.result.fence;
    if(!fence)return HOLD_USER_RULES_UNKNOWN;
    let acknowledged=false;
    try{acknowledged=await this.host.markComposer(id,fence);}catch{/* A lost ACK never permits stale clearance. */}
    if(!acknowledged||this.disposed||this.provider.configuration()!==captured)return HOLD_USER_RULES_UNKNOWN;
    // Composer ACK advances the host revision. Neither the previous fence nor
    // its pre-ACK clearance may be used; output may have arrived meanwhile.
    const after=await this.applied(id,"hold-after-composer",captured,pasted);
    if(!after||after.configuration!==captured||this.provider.configuration()!==captured||after.result.composerSeen)return HOLD_USER_RULES_UNKNOWN;
    return after.result.decision.hold;
  }
  async paneBusy(id:string):Promise<boolean>{
    const captured=this.provider.configuration();
    if(this.disposed)return false;
    if(!configured(captured)){
      try{const busy=await this.host.legacyBusy(id);return !this.disposed&&this.provider.configuration()===captured?busy:false;}
      catch{return false;}
    }
    const applied=await this.applied(id,"busy",captured);
    return applied&&applied.configuration===captured&&!this.disposed&&this.provider.configuration()===captured?applied.result.decision.busy:false;
  }
  async paneState(id:string):Promise<PaneStateResult>{
    const captured=this.provider.configuration();
    if(this.disposed)return unavailablePaneState(HOLD_USER_RULES_UNKNOWN);
    if(!configured(captured)){
      try{const result=await this.host.legacyState(id);return !this.disposed&&this.provider.configuration()===captured?result:unavailablePaneState(HOLD_USER_RULES_UNKNOWN);}
      catch{return unavailablePaneState(HOLD_USER_RULES_UNKNOWN);}
    }
    const applied=await this.applied(id,"explain",captured);
    if(!applied||applied.configuration!==captured||this.disposed||this.provider.configuration()!==captured){
      // A missing/stale screen is not proof that a valid rule set failed. A
      // second read-only status may still establish stopped/starting; never
      // borrow an active builtin-only clearance as an effective user decision.
      if(this.disposed||this.provider.configuration()!==captured)return unavailablePaneState(HOLD_USER_RULES_UNKNOWN);
      let terminal:PaneStateResult|null=null;
      try{terminal=await this.host.legacyState(id);}catch{}
      if(this.disposed||this.provider.configuration()!==captured)return unavailablePaneState(HOLD_USER_RULES_UNKNOWN);
      const configuration=captured;
      const userRules={available:configuration.available,digest:configuration.manifest?.digest??null,...(configuration.reason?{reason:configuration.reason}:{})};
      if(!this.disposed&&terminal&&(terminal.state==="stopped"||terminal.state==="starting"))return {...terminal,userRules};
      return {...unavailablePaneState("terminal screen unavailable or changed; automated input is held"),userRules,inputProtection:HOLD_USER_RULES_UNKNOWN};
    }
    const {screen,result}=applied,base=explainPaneSnapshot(screen),decision=result.decision;
    const paneState=screen.shell?"shell":base.state==="unknown"||!decision.user.available?"unknown":decision.waiting?"waiting":decision.busy?"busy":decision.hold?"held":"idle";
    const evidence=base.evidence.map(entry=>entry.for==="waiting"?{...entry,waiting:base.waiting}:entry);
    // Keep builtin provenance independently when an additive account/usage
    // contribution protects input behind the builtin displayed hold.
    const waitingWinner=["dialog","suppressor","prompt"].find(kind=>decision.user.evidence.some(match=>match.kind===kind));
    for(const match of decision.user.evidence){
      const kind=match.kind;
      if((kind==="prompt"||kind==="dialog"||kind==="suppressor")&&kind!==waitingWinner)continue;
      evidence.push({...(kind==="suppressor"?{waiting:false}:kind==="prompt"||kind==="dialog"?{waiting:true}:{}),for:kind==="busy"?"busy":kind==="prompt"||kind==="dialog"||kind==="suppressor"?"waiting":"hold",match});
    }
    return {...base,state:paneState,hold:decision.hold,busy:decision.busy,waiting:decision.waiting,userHold:decision.userHold,inputProtection:decision.inputProtection,userRules:{available:decision.user.available,digest:decision.user.digest,...(decision.user.reason?{reason:decision.user.reason}:{})},...(!decision.user.available?{reason:decision.user.reason,screenEvidence:false}:{}),evidence};
  }
  /** Status is advisory renderer state. The host revision is checked by the
   * coordinator before it returns, and the client verifies it is still the
   * latest received revision before broadcasting it. */
  async status(id:string,screen:VtSnapshot):Promise<UserRuleScreenStatus|null>{
    const captured=this.provider.configuration();
    if(this.disposed||!configured(captured)||!screen.revision)return null;
    let currentScreen=screen;
    let result=await this.input.evaluateApplied(id,currentScreen,"renderer-status");
    if(this.disposed||this.provider.configuration()!==captured||!result?.current)return null;
    // The host's automatic legacy composer ACK is intentionally disabled while
    // this observer is active. ACK only the exact revision evaluated here,
    // then base status on a newly applied snapshot.
    if(result.composerSeen){
      const fence=result.fence;if(!fence)return null;
      let acknowledged=false;try{acknowledged=await this.host.markComposer(id,fence);}catch{}
      if(!acknowledged||this.disposed||this.provider.configuration()!==captured)return null;
      let fresh:VtSnapshot|null=null;try{fresh=await this.host.snapshot(id);}catch{}
      if(!fresh||this.disposed||this.provider.configuration()!==captured)return null;
      currentScreen=fresh;
      result=await this.input.evaluateApplied(id,currentScreen,"renderer-status");
      if(this.disposed||this.provider.configuration()!==captured||!result?.current||result.composerSeen)return null;
    }
    const builtin=snapshotStatus(currentScreen),waiting=result.decision.user.available?result.decision.waiting:(builtin.waiting??false);
    if(waiting===null)return null;
    const userDialog=result.decision.user.available&&result.decision.user.evidence.find(match=>match.kind==="dialog");
    return {generation:currentScreen.generation,revision:currentScreen.revision!,waiting,...(waiting&&builtin.dialog?{dialog:builtin.dialog}:waiting&&userDialog?{dialog:"User-defined dialog"}:{})};
  }
  dispose():void{this.disposed=true;}
}
