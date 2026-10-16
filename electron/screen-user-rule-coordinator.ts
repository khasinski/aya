// Unused orchestration primitive. No snapshots are acquired and no composer ACK
// or input is sent here; production consumers must use the returned fence at the
// actual first-byte boundary, and check userHold independently before Enter.
import {createHash} from "node:crypto";
import {RULE_AGENTS, type RuleAgent} from "./screen-rule-data";
import {regionText} from "./agent-screen-rules";
import type {UserRuleManifest} from "./screen-user-rule-data";
import type {UserRuleRequest, UserRuleResult} from "./screen-user-rule-runtime";
import {composeUserRuleDecision, HOLD_USER_RULES_UNKNOWN, type AdditivePaneDecision} from "./screen-user-rule-policy";
import {snapshotHold, snapshotBusy, snapshotStatus, withoutPasted} from "./vt-state";
import {validVtSnapshotFence, type VtSnapshot, type VtSnapshotFence} from "./vt-mirror";

export interface UserRuleConfiguration {epoch:number;available:boolean;manifest:UserRuleManifest|null}
export interface CoordinatedRuleDecision {
  decision:AdditivePaneDecision;
  current:boolean;
  userConfigured:boolean;
  fence:VtSnapshotFence|null;
  /** A suggestion only. Any future ACK must carry the exact revision, and its
   * success invalidates that revision before a later conditional write. */
  composerSeen:boolean;
}
export class UserRuleCoordinator {
  private pending=new Map<string,symbol>();
  private disposed=false;
  constructor(private deps:{
    configuration:()=>UserRuleConfiguration;
    evaluate:(request:UserRuleRequest)=>Promise<UserRuleResult>;
    checkSnapshot:(paneId:string,fence:VtSnapshotFence)=>Promise<boolean>;
  }){}
  private stale():CoordinatedRuleDecision {
    return {current:false,userConfigured:true,fence:null,composerSeen:false,decision:{hold:HOLD_USER_RULES_UNKNOWN,busy:false,waiting:null,userHold:null,blocksAutomatedInput:true,inputProtection:HOLD_USER_RULES_UNKNOWN,user:{available:false,digest:null,reason:HOLD_USER_RULES_UNKNOWN,evidence:[]}}};
  }
  async evaluate(paneId:string,snapshot:VtSnapshot,caller:string,pasted?:string):Promise<CoordinatedRuleDecision> {
    if(this.disposed||!paneId||paneId.length>256||!caller||caller.length>80)return this.stale();
    const configuration=this.deps.configuration(),epoch=configuration.epoch,available=configuration.available,digest=configuration.manifest?.digest??null;
    // A host-applied snapshot is already bounded by the protocol schema. Copy
    // once before any await: mutable caller rows/cells cannot change the proof.
    const screen=structuredClone(snapshot);
    const rows=pasted?withoutPasted(screen.rows,pasted):screen.rows;
    const hold=snapshotHold(screen,pasted),status=snapshotStatus({...screen,rows:[...rows]});
    const builtin={hold:hold.hold,busy:snapshotBusy(screen),waiting:status.waiting};
    const regions={tail:regionText(rows,"tail"),lastLine:regionText(rows,"lastLine"),screen:regionText(rows,"screen")};
    const agent=RULE_AGENTS.includes(screen.agent as RuleAgent)?screen.agent as RuleAgent:"generic";
    const context={agent,regions,recoveryUnknown:screen.recoveryUnknown};
    if(available&&!configuration.manifest){
      return {current:true,userConfigured:false,fence:null,composerSeen:hold.composerSeen||status.composerSeen,decision:composeUserRuleDecision(builtin,context,null,{available:true,epoch,digest:null,matches:[]})};
    }
    const fence={generation:screen.generation,revision:screen.revision!};
    if(!validVtSnapshotFence(fence))return this.stale();
    const exclusion=createHash("sha256").update(JSON.stringify(pasted??null)).digest("hex");
    const key=JSON.stringify([paneId,caller,exclusion]);
    if(!this.pending.has(key)&&this.pending.size>=25)return this.stale();
    const token=Symbol();this.pending.set(key,token);
    const stillCurrent=()=>{
      const now=this.deps.configuration();
      return !this.disposed&&this.pending.get(key)===token&&now.epoch===epoch&&now.available===available&&(now.manifest?.digest??null)===digest;
    };
    try{
      // Capture provenance too; only the runtime may compile these data strings.
      const manifest=configuration.manifest?structuredClone(configuration.manifest):null;
      const scope=createHash("sha256").update(JSON.stringify([epoch,digest,screen.generation,screen.revision,caller,exclusion])).digest("hex");
      let result:UserRuleResult={available:false,epoch,digest,reason:HOLD_USER_RULES_UNKNOWN};
      if(available&&manifest)result=await this.deps.evaluate({paneId,scope,agent,regions});
      if(!stillCurrent())return this.stale();
      // The host may have applied bytes not yet broadcast to main. Its answer,
      // not main's latest event, establishes freshness after the worker wait.
      const checked=await this.deps.checkSnapshot(paneId,fence);
      if(!checked||!stillCurrent())return this.stale();
      if(!manifest)return {...this.stale(),current:true,decision:{...this.stale().decision,hold:builtin.hold??HOLD_USER_RULES_UNKNOWN,busy:builtin.busy,waiting:builtin.waiting===true?true:null}};
      const decision=composeUserRuleDecision(builtin,context,manifest,result);
      return {decision,current:true,userConfigured:true,fence:decision.user.available?fence:null,composerSeen:decision.user.available&&!decision.waiting&&!decision.userHold&&(hold.composerSeen||status.composerSeen)};
    }catch{return this.stale();}
    finally{if(this.pending.get(key)===token)this.pending.delete(key);}
  }
  dispose():void{this.disposed=true;this.pending.clear();}
}
