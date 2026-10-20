// Main-owned atomic candidates. Files are trusted same-user additive data;
// readUserScreenRules supplies bounded metadata/type/schema accident guards.
import * as fs from "node:fs";
import * as path from "node:path";
import {createHash} from "node:crypto";
import {RULE_AGENTS, type RuleAgent, type ScreenRuleSet} from "./screen-rule-data";
import {readUserScreenRules, type UserRuleManifest} from "./screen-user-rule-data";
import {UserRuleRuntime, type UserRuleRequest, type UserRuleResult} from "./screen-user-rule-runtime";
import type {UserRuleConfiguration} from "./screen-user-rule-coordinator";
export const USER_RELOAD_LIMITS=Object.freeze({scanMs:1000,coalesceMs:100,stableMs:100});
type Runtime=Pick<UserRuleRuntime,"replace"|"evaluate"|"dispose">;
type Candidate={ok:true;manifest:UserRuleManifest|null;key:string}|{ok:false;key:"invalid";problem:string};
function publicFileProblem(error:unknown):string{
  const code=(error as NodeJS.ErrnoException)?.code;
  const message=error instanceof Error?error.message:"";
  const file=message.match(/^(generic|claude|codex|opencode|grok|antigravity)\.json: (.*)$/);
  let detail=file?.[2]??message;
  if(code==="EACCES"||code==="EPERM")detail="file or folder permissions prevent Aya from reading it";
  else if(code==="ELOOP")detail="a rule file must not be a symbolic link";
  else if(code==="ENOENT")detail="a rule file changed while Aya was reading it";
  else if(/JSON|position \d+|Unexpected|Expected property name/i.test(detail))detail="file is not valid JSON";
  else if(detail==="invalid object")detail="file contains an invalid object";
  else if(detail==="unknown JSON filename")detail="the folder contains an unsupported JSON filename";
  else if(detail==="folder must be private to your account")detail="folder permissions must be private to your account";
  else if(!/^(file is missing|required|schema version|agent must|rule-set version|rules must|rule count|rule \d+|file must be|file size|file changed|directory|aggregate|effective|a rule file|duplicate|invalid kind|unsupported)/i.test(detail)){
    detail="file could not be read safely";
  }
  return file?file[1]+".json: "+detail:detail;
}
export interface UserRuleProviderState extends UserRuleConfiguration {reason?:string}
export interface UserRuleDiagnostics {
  available:boolean;
  reason?:string;
  quarantinedDigest?:string;
  directory:string;
  fileProblem?:string;
  sets:{agent:RuleAgent;status:"loaded"|"built-in only"|"unavailable";ruleCount?:number;version?:string;digest?:string;sources?:string[]}[];
}
export class UserRuleProvider {
  private state:UserRuleProviderState=Object.freeze({epoch:0,available:false,manifest:null,reason:"user rules have not been loaded"});
  private runtime:Runtime;
  private disposed=false;
  private started=false;
  private observedKey:string|null=null;
  private desiredKey:string|null=null;
  private desiredManifest:UserRuleManifest|null=null;
  private stopping:Promise<void>|null=null;
  private timer:ReturnType<typeof setTimeout>|null=null;
  private scanTimer:ReturnType<typeof setInterval>|null=null;
  private directoryWatch:fs.FSWatcher|null=null;
  private parentWatch:fs.FSWatcher|null=null;
  private lastDiagnostic:string|null=null;
  private quarantinedDigest:string|null=null;
  private fileProblem:string|undefined;
  constructor(private directory:string,private builtin:ScreenRuleSet,private options:{
    read?:()=>UserRuleManifest|null;
    createRuntime?:(onFailure:(reason:string,digest:string|null)=>void)=>Runtime;
    watch?:typeof fs.watch;
    changed?:(state:UserRuleProviderState)=>void;
    log?:(reason:string,digest:string|null)=>void;
  }={}){
    const onFailure=(_reason:string,digest:string|null)=>{
      // Only the current candidate owns this runtime. A retired thread's late
      // failure must not invalidate a different pending candidate.
      if(this.disposed||!digest||this.desiredKey!==digest)return;
      this.quarantinedDigest=digest;
      this.publish(false,this.desiredManifest,"user rule compilation or evaluation failed");
      this.diagnostic("user rule compilation or evaluation failed",digest);
    };
    this.runtime=options.createRuntime?.(onFailure)??new UserRuleRuntime({log:onFailure});
  }
  configuration():UserRuleProviderState{return this.state;}
  diagnostics():UserRuleDiagnostics{
    const state=this.state,files=state.manifest?.files??[];
    return Object.freeze({
      available:state.available,
      ...(state.reason?{reason:state.reason}:{}),
      ...(this.quarantinedDigest?{quarantinedDigest:this.quarantinedDigest}:{}),
      directory:this.directory,
      ...(this.fileProblem?{fileProblem:this.fileProblem}:{}),
      sets:RULE_AGENTS.map(agent=>{
        const effective=files.filter(entry=>entry.source===`user/${agent}.json`||(agent!=="generic"&&entry.source==="user/generic.json"));
        const status=!state.available?"unavailable" as const:effective.length?"loaded" as const:"built-in only" as const;
        if(!effective.length)return {agent,status};
        const identity=effective.map(file=>`${file.source}@${file.version}`).join(", ");
        const digest=createHash("sha256").update(JSON.stringify([agent,effective.map(file=>[file.source,file.version,file.digest])])).digest("hex");
        return {agent,status,ruleCount:state.manifest?.sets[agent].length??0,version:identity,digest,sources:effective.map(file=>file.source)};
      }),
    });
  }
  private publish(available:boolean,manifest:UserRuleManifest|null,reason?:string):void{
    this.state=Object.freeze({epoch:this.state.epoch+1,available,manifest,...(reason?{reason}:{})});
    try{this.options.changed?.(this.state);}catch{/* A listener cannot change rule safety. */}
  }
  private diagnostic(reason:string,digest:string|null):void{
    const signature=JSON.stringify([reason,digest]);if(this.lastDiagnostic===signature)return;this.lastDiagnostic=signature;
    try{if(this.options.log)this.options.log(reason,digest);else console.error("user-screen-rules-unavailable",{reason,digest});}catch{/* Diagnostics cannot change rule safety. */}
  }
  private read():Candidate{
    try{const manifest=this.options.read?this.options.read():readUserScreenRules(this.directory,this.builtin);return{ok:true,manifest,key:manifest?.digest??"absent"};}
    catch(error){return{ok:false,key:"invalid",problem:publicFileProblem(error)};}
  }
  /** Nonblocking startup: main need not delay window creation for a worker. */
  start():void{
    if(this.started||this.disposed)return;this.started=true;this.attachWatches();
    const first=this.read();
    if(first.ok&&!first.manifest){
      // On first startup there is no old user layer to preserve through a
      // deletion gap. Keep the builtin-only path synchronous, without any
      // worker initialization, IPC or artificial settling delay.
      this.observedKey="absent";this.desiredKey="absent";this.publish(true,null);
    }else this.begin(first);
    this.scanTimer=setInterval(()=>this.scan(),USER_RELOAD_LIMITS.scanMs);this.scanTimer.unref?.();
  }
  private clearTimer():void{if(this.timer)clearTimeout(this.timer);this.timer=null;}
  /** Watch notification invalidates immediately, before coalescing or parsing. */
  refresh():void{
    if(this.disposed||!this.started)return;
    // A parent watch can report an unrelated event with no filename. An
    // already absent user layer has no decisions to invalidate; confirm that
    // bounded read before keeping the builtin-only fast path.
    if(this.state.available&&!this.state.manifest&&this.read().key==="absent")return;
    this.clearTimer();this.publish(false,this.state.manifest,"user rules are reloading");
    const epoch=this.state.epoch;
    this.timer=setTimeout(()=>{this.timer=null;if(!this.disposed&&this.state.epoch===epoch)this.begin();},USER_RELOAD_LIMITS.coalesceMs);this.timer.unref?.();
  }
  private begin(candidate=this.read()):void{
    if(this.disposed)return;this.clearTimer();this.observedKey=candidate.key;this.desiredKey=candidate.key;this.desiredManifest=candidate.ok?candidate.manifest:null;
    this.fileProblem=candidate.ok?undefined:candidate.problem;
    this.publish(false,this.state.manifest,"user rules are reloading");const epoch=this.state.epoch;
    // Require a stable second read, including deletion. A rename's brief gap
    // cannot publish builtin-only clearance over an unapplied user hold.
    this.timer=setTimeout(()=>{
      this.timer=null;if(this.disposed||this.state.epoch!==epoch)return;
      const after=this.read();if(after.key!==candidate.key){this.begin(after);return;}
      void this.install(after,epoch);
    },USER_RELOAD_LIMITS.stableMs);this.timer.unref?.();
  }
  private async install(candidate:Candidate,epoch:number):Promise<void>{
    const manifest=candidate.ok?candidate.manifest:null;
    let ready=false;try{ready=await this.runtime.replace(manifest);}catch{/* Unavailable candidate, no fallback execution. */}
    if(this.disposed||this.state.epoch!==epoch)return;
    // Editing during compilation cannot activate a candidate that was already
    // replaced before the watcher or periodic scan ran.
    const after=this.read();if(after.key!==candidate.key){this.begin(after);return;}
    if(!candidate.ok||!ready){
      const reason=candidate.ok?"user rule compilation or evaluation failed":"invalid or unsafe user rule files";
      if(candidate.ok)this.fileProblem=undefined;
      if(candidate.ok&&manifest)this.quarantinedDigest=manifest.digest;
      this.publish(false,manifest,reason);this.diagnostic(reason,manifest?.digest??null);return;
    }
    // Configuration and this specific runtime become available in one turn.
    // Their counters need not equal: provider epoch plus runtime request/job
    // correspondence and digest are the consumer contract.
    this.publish(true,manifest);this.lastDiagnostic=null;this.quarantinedDigest=null;
  }
  scan():void{
    if(this.disposed||!this.started)return;this.attachWatches();const candidate=this.read();
    if(candidate.key!==this.observedKey)this.begin(candidate);
  }
  private attachWatches():void{
    const watch=this.options.watch??fs.watch;
    const install=(directory:string,parent:boolean):fs.FSWatcher|null=>{
      try{
        const watcher=watch(directory,{persistent:false},(_event,name)=>{
          const filename=name?.toString();
          if(!filename||(parent?filename===path.basename(this.directory):filename.endsWith(".json"))){
            if(parent){try{this.directoryWatch?.close();}catch{}this.directoryWatch=null;}
            this.refresh();
          }
        });
        watcher.on("error",()=>{try{watcher.close();}catch{}if(parent){if(this.parentWatch===watcher)this.parentWatch=null;}else if(this.directoryWatch===watcher)this.directoryWatch=null;this.refresh();});
        return watcher;
      }catch{return null;}
    };
    if(!this.parentWatch)this.parentWatch=install(path.dirname(this.directory),true);
    if(!this.directoryWatch)this.directoryWatch=install(this.directory,false);
  }
  async evaluate(request:UserRuleRequest):Promise<UserRuleResult>{
    const state=this.state,digest=state.manifest?.digest??null;
    const unavailable=():UserRuleResult=>({available:false,epoch:state.epoch,digest,reason:"user rules are unavailable or changed"});
    if(this.disposed||!state.available)return unavailable();
    if(!state.manifest)return{available:true,epoch:state.epoch,digest:null,matches:[]};
    try{
      const result=await this.runtime.evaluate(request);
      if(this.disposed||this.state!==state||result.digest!==digest)return unavailable();
      return result;
    }catch{return unavailable();}
  }
  async dispose():Promise<void>{
    if(this.disposed)return this.stopping??undefined;this.disposed=true;this.clearTimer();if(this.scanTimer)clearInterval(this.scanTimer);this.scanTimer=null;
    for(const watcher of [this.directoryWatch,this.parentWatch])try{watcher?.close();}catch{}
    this.directoryWatch=null;this.parentWatch=null;this.stopping=Promise.resolve().then(()=>this.runtime.dispose());this.publish(false,this.state.manifest,"user rules stopped");await this.stopping;
  }
}
