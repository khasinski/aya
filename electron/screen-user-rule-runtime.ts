// Main-owned deadlines and queue. This module never compiles a user pattern.
import {Worker} from "node:worker_threads";
import * as path from "node:path";
import {performance} from "node:perf_hooks";
import {RULE_AGENTS} from "./screen-rule-data";
import type {RuleAgent, RuleKind, ScreenRegion} from "./screen-rule-data";
import type {UserRuleManifest} from "./screen-user-rule-data";
export const USER_RULE_LIMITS = Object.freeze({initMs:2000,activeMs:100,queueMs:1000,queueRequests:25,queueBytes:16*1024*1024,requestBytes:4*1024*1024});
export interface UserRuleRequest {paneId:string;scope:string;agent:RuleAgent;regions:Record<ScreenRegion,string>}
export interface UserRuleMatch {id:string;kind:RuleKind;region:ScreenRegion;start:number;length:number}
export type UserRuleResult = {available:true;epoch:number;digest:string|null;matches:readonly UserRuleMatch[]} | {available:false;epoch:number;digest:string|null;reason:string};
type WorkerHandle = Pick<Worker,"on"|"postMessage"|"terminate"|"unref">;
interface Job {id:number;request:UserRuleRequest;bytes:number;expires:number;deadline:number;resolve:(result:UserRuleResult)=>void;timer:ReturnType<typeof setTimeout>|null}
type Availability = "absent"|"initializing"|"ready"|"unavailable"|"disposed";
export class UserRuleRuntime {
  private worker:WorkerHandle|null=null;
  private stopping:Promise<unknown>=Promise.resolve();
  private manifest:UserRuleManifest|null=null;
  private epoch=0;
  private sequence=0;
  private state:Availability="absent";
  private reason="user rules are not ready";
  private quarantine:string|null=null;
  private active:Job|null=null;
  private queued=new Map<string,Job>();
  private queuedBytes=0;
  private init:{deadline:number;timer:ReturnType<typeof setTimeout>;resolve:(ready:boolean)=>void}|null=null;
  constructor(private options:{now?:()=>number;createWorker?:(manifest:UserRuleManifest)=>WorkerHandle;log?:(reason:string,digest:string|null)=>void}={}) {}
  private now():number {return this.options.now?.()??performance.now();}
  private unavailable(reason=this.reason):UserRuleResult {return {available:false,epoch:this.epoch,digest:this.manifest?.digest??null,reason};}
  private settle(job:Job,result:UserRuleResult):void {if(job.timer)clearTimeout(job.timer);job.timer=null;job.resolve(result);}
  /** Release every outstanding caller and serialize actual thread termination. */
  private retire():Promise<unknown> {
    const worker=this.worker;this.worker=null;
    if(this.init){clearTimeout(this.init.timer);this.init.resolve(false);this.init=null;}
    if(this.active){this.settle(this.active,this.unavailable());this.active=null;}
    for(const job of this.queued.values())this.settle(job,this.unavailable());
    this.queued.clear();this.queuedBytes=0;
    if(worker)this.stopping=this.stopping.then(()=>worker.terminate());
    return this.stopping;
  }
  private fail(worker:WorkerHandle,reason:string):void {
    if(this.worker!==worker)return;
    this.state="unavailable";this.reason=reason;this.quarantine=this.manifest?.digest??null;
    try{this.options.log?.(reason,this.quarantine);}catch{/* Diagnostics never changes safety. */}
    void this.retire().catch(()=>{});
  }
  /** A fresh worker and initialization deadline cover every candidate compile. */
  async replace(manifest:UserRuleManifest|null):Promise<boolean> {
    if(this.state==="disposed")return false;
    const epoch=++this.epoch,deadline=this.now()+USER_RULE_LIMITS.initMs;
    if(this.manifest?.digest!==manifest?.digest)this.quarantine=null;
    this.manifest=manifest?structuredClone(manifest):null;this.state=manifest?"initializing":"absent";this.reason="user rule set changed";
    let stopTimer:ReturnType<typeof setTimeout>|undefined;
    const retired=await Promise.race([
      this.retire().then(()=>true,()=>false),
      new Promise<false>(resolve=>{stopTimer=setTimeout(()=>resolve(false),Math.max(0,deadline-this.now()));}),
    ]);
    if(stopTimer)clearTimeout(stopTimer);
    if(epoch!==this.epoch)return false; // dispose also advances epoch
    if(!retired||this.now()>=deadline){this.state="unavailable";this.reason="user rule worker could not terminate within its deadline";return false;}
    if(!manifest)return true;
    if(this.quarantine===manifest.digest){this.state="unavailable";this.reason="this user rule digest is quarantined";return false;}
    let worker:WorkerHandle;
    try{worker=this.options.createWorker?.(this.manifest!)??new Worker(path.join(__dirname,"screen-user-rule-worker.js"),{workerData:this.manifest,env:{},resourceLimits:{maxOldGenerationSizeMb:64,stackSizeMb:4}});}
    catch{this.state="unavailable";this.quarantine=manifest.digest;this.reason="user rule worker could not start";return false;}
    this.worker=worker;
    const expire=()=>{
      if(this.worker!==worker||!this.init)return;
      const remaining=deadline-this.now();
      if(remaining>0){this.init.timer=setTimeout(expire,remaining);return;}
      this.fail(worker,"user rule compilation exceeded its deadline");
    };
    const ready=new Promise<boolean>(resolve=>{this.init={deadline,resolve,timer:setTimeout(expire,Math.max(0,deadline-this.now()))};});
    worker.on("message",message=>this.onMessage(worker,message));
    worker.on("error",()=>this.fail(worker,"user rule worker failed"));
    worker.on("exit",()=>this.fail(worker,"user rule worker exited"));
    worker.unref();
    return ready;
  }
  private onMessage(worker:WorkerHandle,message:unknown):void {
    if(this.worker!==worker)return;
    if(!message||typeof message!=="object"||Array.isArray(message)){this.fail(worker,"invalid user rule worker reply");return;}
    const m=message as Record<string,unknown>;
    if(this.state==="initializing"){
      if(!this.init||this.now()>=this.init.deadline){this.fail(worker,"user rule compilation exceeded its deadline");return;}
      if(Object.keys(m).length!==2||m.type!=="ready"||m.digest!==this.manifest?.digest){this.fail(worker,"user rule compilation failed");return;}
      const init=this.init;this.init=null;clearTimeout(init.timer);this.state="ready";init.resolve(true);this.pump();return;
    }
    const job=this.active;
    if(!job||this.state!=="ready"){this.fail(worker,"unexpected user rule worker reply");return;}
    if(this.now()>=job.deadline){this.fail(worker,"user rule evaluation exceeded its deadline");return;}
    if(Object.keys(m).length!==4||m.type!=="result"||m.id!==job.id||m.digest!==this.manifest?.digest||!this.validMatches(m.matches,job)){
      this.fail(worker,"invalid user rule worker reply");return;
    }
    this.active=null;this.settle(job,{available:true,epoch:this.epoch,digest:this.manifest!.digest,matches:m.matches as UserRuleMatch[]});this.pump();
  }
  private validMatches(value:unknown,job:Job):boolean {
    if(!Array.isArray(value)||value.length>6)return false;
    const kinds=new Set<string>();
    return value.every(item=>{
      if(!item||typeof item!=="object"||Array.isArray(item)||Object.keys(item).length!==5||!["id","kind","region","start","length"].every(key=>Object.hasOwn(item,key)))return false;
      const match=item as UserRuleMatch,rule=this.manifest!.sets[job.request.agent].find(rule=>rule.id===match.id);
      if(!rule||rule.kind!==match.kind||rule.region!==match.region||kinds.has(match.kind))return false;
      kinds.add(match.kind);const text=job.request.regions[match.region];
      return Number.isSafeInteger(match.start)&&Number.isSafeInteger(match.length)&&match.start>=0&&match.length>=0&&match.start<=text.length&&match.length<=text.length-match.start;
    });
  }
  evaluate(request:UserRuleRequest):Promise<UserRuleResult> {
    if(this.state==="absent")return Promise.resolve({available:true,epoch:this.epoch,digest:null,matches:[]});
    if(this.state!=="ready")return Promise.resolve(this.unavailable());
    if(!request||typeof request.paneId!=="string"||!request.paneId.length||request.paneId.length>256||typeof request.scope!=="string"||request.scope.length>256||!RULE_AGENTS.includes(request.agent)||!request.regions||Object.keys(request.regions).length!==3||!["tail","lastLine","screen"].every(region=>Object.hasOwn(request.regions,region)&&typeof request.regions[region as ScreenRegion]==="string"))return Promise.resolve(this.unavailable("invalid user rule evaluation request"));
    const bytes=Object.values(request.regions).reduce((sum,text)=>sum+Buffer.byteLength(text),0);
    if(bytes>USER_RULE_LIMITS.requestBytes)return Promise.resolve(this.unavailable("user rule evaluation text limit"));
    // scope includes caller, applied revision and pasted-draft exclusion.
    // Different contexts for one pane must never borrow one another's result.
    const key=JSON.stringify([request.paneId,request.scope,request.agent]);
    const previous=this.queued.get(key);
    if(previous){this.queued.delete(key);this.queuedBytes-=previous.bytes;this.settle(previous,this.unavailable("a newer evaluation replaced this queued request"));}
    if(this.queued.size>=USER_RULE_LIMITS.queueRequests||this.queuedBytes+bytes>USER_RULE_LIMITS.queueBytes)return Promise.resolve(this.unavailable("user rule evaluation queue is full"));
    // Copy text/context so callers cannot mutate a queued decision's identity.
    const copy={paneId:request.paneId,scope:request.scope,agent:request.agent,regions:{tail:request.regions.tail,lastLine:request.regions.lastLine,screen:request.regions.screen}};
    return new Promise(resolve=>{
      const job:Job={id:++this.sequence,request:copy,bytes,expires:this.now()+USER_RULE_LIMITS.queueMs,deadline:0,resolve,timer:null};
      job.timer=setTimeout(()=>{if(this.queued.get(key)!==job)return;this.queued.delete(key);this.queuedBytes-=bytes;this.settle(job,this.unavailable("user rule evaluation expired in the queue"));},USER_RULE_LIMITS.queueMs);
      this.queued.set(key,job);this.queuedBytes+=bytes;this.pump();
    });
  }
  private pump():void {
    const worker=this.worker;if(!worker||this.state!=="ready"||this.active)return;
    for(const [key,job] of this.queued){
      this.queued.delete(key);this.queuedBytes-=job.bytes;
      // Reserve the full active budget. A request aged out by queue load is
      // refused locally, never misclassified as a pathological rule digest.
      const dispatched=this.now();
      if(dispatched+USER_RULE_LIMITS.activeMs>job.expires){this.settle(job,this.unavailable("user rule evaluation expired in the queue"));continue;}
      if(job.timer)clearTimeout(job.timer);this.active=job;job.deadline=dispatched+USER_RULE_LIMITS.activeMs;
      const expire=()=>{
        if(this.active!==job||this.worker!==worker)return;
        const remaining=job.deadline-this.now();
        if(remaining>0){job.timer=setTimeout(expire,remaining);return;}
        this.fail(worker,"user rule evaluation exceeded its deadline");
      };
      job.timer=setTimeout(expire,Math.max(0,job.deadline-this.now()));
      try{worker.postMessage({id:job.id,agent:job.request.agent,regions:job.request.regions});}catch{this.fail(worker,"user rule worker dispatch failed");}
      return;
    }
  }
  async dispose():Promise<void>{if(this.state==="disposed")return this.stopping.then(()=>{});this.state="disposed";this.reason="user rule evaluation stopped";this.epoch++;await this.retire();}
}
