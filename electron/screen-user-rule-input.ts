// Main-side automatic-input adapter for direct pane control and team delivery.
// Explicit user keyboard/paste does not use this policy or its input fence.
import type {VtSnapshot, VtSnapshotFence} from "./vt-mirror";
import type {UserRuleProvider} from "./screen-user-rule-provider";
import {UserRuleCoordinator, type CoordinatedRuleDecision} from "./screen-user-rule-coordinator";
import {HOLD_DRAFT} from "./pane-holds";
import {HOLD_USER_RULES_UNKNOWN} from "./screen-user-rule-policy";
export interface AutomaticWriteContext {phase:"paste"|"enter";pasted?:string}
const configuredState=(state:ReturnType<UserRuleProvider["configuration"]>):boolean=>!state.available||state.manifest!==null;
export class GuardedRuleInput {
  private coordinator:UserRuleCoordinator;
  private disposed=false;
  constructor(private provider:Pick<UserRuleProvider,"configuration"|"evaluate">,private host:{
    snapshot:(id:string)=>Promise<VtSnapshot|null>;
    check:(id:string,fence:VtSnapshotFence)=>Promise<boolean>;
    writeFenced:(id:string,data:string,fence:VtSnapshotFence,policyEpoch:number)=>Promise<boolean>;
    writeLegacy:(id:string,data:string,stillAllowed?:()=>boolean)=>Promise<boolean|void>;
  }){
    this.coordinator=new UserRuleCoordinator({configuration:()=>provider.configuration(),evaluate:request=>provider.evaluate(request),checkSnapshot:(id,fence)=>host.check(id,fence)});
  }
  configured():boolean{return configuredState(this.provider.configuration());}
  private refused(reason:string,code="PTY_HOST_RULES_UNAVAILABLE"):Error{return Object.assign(new Error(`${reason}. This input was not sent.`),{code});}
  async decision(id:string,caller:string,pasted?:string):Promise<CoordinatedRuleDecision|null>{
    if(this.disposed)return null;
    try{const screen=await this.host.snapshot(id);if(!screen||this.disposed)return null;return await this.evaluateApplied(id,screen,caller,pasted);}catch{return null;}
  }
  /** Evaluate a caller-owned applied snapshot; acquisition and any later ACK remain separate. */
  async evaluateApplied(id:string,screen:VtSnapshot,caller:string,pasted?:string):Promise<CoordinatedRuleDecision|null>{
    if(this.disposed)return null;return this.coordinator.evaluate(id,screen,caller,pasted);
  }
  /** Direct pane-send blocks user-only dialogs/unknown user safety independently
   * of a builtin display hold. A generic approval can still be answered by an
   * explicit pane-send, exactly as before. No composer/exit ACK occurs here. */
  async protection(id:string,pasted?:string,cancelled?:()=>boolean):Promise<string|null>{
    if(this.disposed)return HOLD_USER_RULES_UNKNOWN;
    if(cancelled?.())return null;
    const result=await this.decision(id,pasted===undefined?"direct:protect-paste":"direct:protect-enter",pasted);
    if(cancelled?.())return null;
    if(!result?.current||!result.decision.user.available)return HOLD_USER_RULES_UNKNOWN;
    return result.decision.inputProtection;
  }
  async write(kind:"direct"|"team",id:string,data:string,context:AutomaticWriteContext,cancelled?:()=>boolean):Promise<boolean|void>{
    if(this.disposed||cancelled?.())throw this.refused("Automatic input was cancelled","PTY_HOST_INPUT_CANCELLED");
    // The caller enables this optional adapter only for the user-rule path.
    // Builtin-only behavior uses the existing writer without extra snapshots.
    const initial=this.provider.configuration();
    if(!configuredState(initial))return this.host.writeLegacy(id,data,()=>!this.disposed&&!cancelled?.()&&this.provider.configuration()===initial);
    const state=this.provider.configuration(),{phase,pasted}=context;
    const result=await this.decision(id,`${kind}:write-${phase}`,pasted);
    if(this.disposed||cancelled?.())throw this.refused("Automatic input was cancelled","PTY_HOST_INPUT_CANCELLED");
    if(this.provider.configuration()!==state||!result?.current||!result.fence||!result.decision.user.available)throw this.refused(HOLD_USER_RULES_UNKNOWN);
    const decision=result.decision;
    if(decision.inputProtection)throw this.refused(decision.inputProtection,"PTY_HOST_INPUT_PROTECTED");
    if(kind==="team"){
      if(phase==="paste"&&decision.busy)throw this.refused("The agent is busy","PTY_HOST_INPUT_BUSY");
      // A builtin draft may be allowed before Enter, but may never hide an
      // additional user prompt/account hold. Keep those contributions separate.
      const hold=decision.userHold??decision.hold;
      if(hold&&!(hold===HOLD_DRAFT&&phase==="enter"))throw this.refused(hold,"PTY_HOST_INPUT_HELD");
    }
    // No await between the last main-owned epoch/cancel check and dispatch.
    // The host rechecks the fence at its actual first accepted master byte.
    // A stale revision or uncertain/lost ACK is propagated, never retried here.
    return this.host.writeFenced(id,data,result.fence,state.epoch);
  }
  dispose():void{this.disposed=true;this.coordinator.dispose();}
}
