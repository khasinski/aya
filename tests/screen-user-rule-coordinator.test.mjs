import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {UserRuleCoordinator}=require('../dist-electron/screen-user-rule-coordinator.js');
const {RULE_AGENTS}=require('../dist-electron/screen-rule-data.js');
const mirror=require('../dist-electron/vt-mirror.js');
const rule={id:'local-prompt',kind:'prompt',region:'tail',pattern:'LOCAL',flags:'',source:'user/claude.json',version:'local-1'};
const manifest={digest:'a'.repeat(64),sets:Object.fromEntries(RULE_AGENTS.map(a=>[a,[rule]])),files:[]};
const snapshot=(text='IDLE')=>({generation:'g',revision:'12345678-1234-1234-1234-123456789abc:1',agent:'claude',shell:false,composerSeen:true,openedAt:0,lastOutputAt:0,rows:[text],cells:[[...text].map((c,i)=>[i,c,0,0])],cols:80});
const answer=(matches=[])=>({available:true,epoch:1,digest:manifest.digest,matches});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(overrides={}){
 let configuration={epoch:1,available:true,manifest},requests=[],checks=[];
 const coordinator=new UserRuleCoordinator({configuration:()=>configuration,evaluate:async request=>{requests.push(request);return answer();},checkSnapshot:async(id,fence)=>{checks.push({id,fence});return true;},...overrides});
 return{coordinator,requests,checks,set:r=>configuration=r,get:()=>configuration};
}
const unknown=result=>{assert.equal(result.current,false);assert.equal(result.fence,null);assert.equal(result.composerSeen,false);assert.equal(result.decision.blocksAutomatedInput,true);assert.equal(result.decision.waiting,null);};
test('no user files uses builtin path without worker or revision RPC',async()=>{
 const f=fixture();f.set({epoch:1,available:true,manifest:null});
 const result=await f.coordinator.evaluate('p',snapshot(),'explain');
 assert.equal(result.current,true);assert.equal(result.userConfigured,false);assert.equal(result.decision.user.available,true);assert.equal(f.requests.length,0);assert.equal(f.checks.length,0);
});
test('a fresh result returns exact host fence without composer or input side effects',async()=>{
 const f=fixture(),screen=snapshot(),result=await f.coordinator.evaluate('p',screen,'delivery-before-paste');
 assert.equal(result.current,true);assert.deepEqual(result.fence,{generation:screen.generation,revision:screen.revision});assert.equal(f.requests.length,1);assert.equal(f.checks.length,1);
});
test('old host missing revision cannot enter worker or authorize input',async()=>{
 const f=fixture(),screen=snapshot();delete screen.revision;
 unknown(await f.coordinator.evaluate('p',screen,'delivery'));assert.equal(f.requests.length,0);assert.equal(f.checks.length,0);
});
test('same-generation applied but unbroadcast output refuses old worker evidence',async()=>{
 const wait=deferred();let changes=0;mirror.openVtPane('revision-only',80,24,()=>{changes++;},'claude');
 try{
  mirror.writeVtPane('revision-only','IDLE');const screen=await mirror.vtSnapshot('revision-only');
  const f=fixture({evaluate:()=>wait.promise,checkSnapshot:async(id,fence)=>mirror.vtSnapshotMatches(id,fence)});
  const pending=f.coordinator.evaluate('revision-only',screen,'delivery');
  mirror.writeVtPane('revision-only','\r\nAllow operation?');
  const applied=await mirror.vtSnapshot('revision-only');
  assert.ok(applied.rows.some(row=>row.includes('Allow operation?')));
  assert.notEqual(applied.revision,screen.revision);
  assert.equal(mirror.vtSnapshotMatches('revision-only',{generation:applied.generation,revision:applied.revision}),true);
  assert.equal(changes,0,'new output is applied before its debounced broadcast');
  wait.resolve(answer());unknown(await pending);assert.equal(changes,0,'no debounced status event is needed to invalidate');
 }finally{mirror.closeVtPane('revision-only');}
});
test('reload epoch, same-object availability mutation, and disposal fence pending results',async()=>{
 for(const mode of ['epoch','digest','availability','dispose']){
  const wait=deferred(),f=fixture({evaluate:()=>wait.promise}),pending=f.coordinator.evaluate('p',snapshot(),'delivery');
  if(mode==='epoch')f.set({...f.get(),epoch:2});else if(mode==='digest')f.set({...f.get(),manifest:{...manifest,digest:'b'.repeat(64)}});else if(mode==='availability')f.get().available=false;else f.coordinator.dispose();
  wait.resolve(answer());unknown(await pending);assert.equal(f.checks.length,0);
 }
});
test('epoch changing during the final host check cannot return a clear fence',async()=>{
 const wait=deferred(),f=fixture({checkSnapshot:()=>wait.promise}),pending=f.coordinator.evaluate('p',snapshot(),'delivery');
 await tick();f.set({...f.get(),epoch:2});wait.resolve(true);unknown(await pending);
});
test('latest request supersedes only identical caller and exact exclusion',async()=>{
 const waits=[],scopes=[],f=fixture({evaluate:request=>{scopes.push(request.scope);const w=deferred();waits.push(w);return w.promise;}});
 const screen=snapshot(),a=f.coordinator.evaluate('p',screen,'delivery','A'),b=f.coordinator.evaluate('p',screen,'explain','A'),c=f.coordinator.evaluate('p',screen,'delivery','B'),newA=f.coordinator.evaluate('p',screen,'delivery','A');
 assert.equal(new Set(scopes.slice(0,3)).size,3);assert.equal(scopes[0],scopes[3]);
 waits.forEach(w=>w.resolve(answer()));unknown(await a);
 for(const p of [b,c,newA])assert.equal((await p).current,true);
});
test('queued text, metadata and fence derive from the copied screen and parent manifest',async()=>{
 const wait=deferred(),f=fixture({evaluate:()=>wait.promise}),screen=snapshot('LOCAL'),pending=f.coordinator.evaluate('p',screen,'explain');
 screen.rows[0]='changed';screen.revision='changed';f.get().manifest.sets.claude[0].source='user/CHANGED.json';
 try{
  wait.resolve(answer([{id:'local-prompt',kind:'prompt',region:'tail',start:0,length:5}]));const result=await pending;
  assert.equal(result.decision.user.evidence[0].excerpt,'LOCAL');assert.equal(result.decision.user.evidence[0].source,'user/claude.json');assert.equal(result.fence.revision,snapshot().revision);
 }finally{f.get().manifest.sets.claude[0].source='user/claude.json';}
});
test('pasted exclusion masks only matching rows and remains part of scope',async()=>{
 const f=fixture(),screen=snapshot('LOCAL');
 await f.coordinator.evaluate('p',screen,'before-enter','LOCAL');await f.coordinator.evaluate('p',screen,'before-enter','OTHER');
 assert.equal(f.requests[0].regions.tail,'');assert.equal(f.requests[1].regions.tail,'LOCAL');assert.notEqual(f.requests[0].scope,f.requests[1].scope);
});
test('unavailable candidate retains fresh builtin holds but supplies no input fence',async()=>{
 const f=fixture();f.set({epoch:2,available:false,manifest:null});const screen=snapshot();screen.shell=true;
 const result=await f.coordinator.evaluate('p',screen,'explain');assert.equal(result.current,true);assert.equal(result.decision.hold,'runs a shell');assert.equal(result.fence,null);assert.equal(result.decision.blocksAutomatedInput,true);assert.equal(f.requests.length,0);assert.equal(f.checks.length,1);
});
test('worker/check exceptions fail closed and pending context bound is reclaimed',async()=>{
 const waits=[],f=fixture({evaluate:()=>{const w=deferred();waits.push(w);return w.promise;}}),requests=[];
 for(let i=0;i<25;i++)requests.push(f.coordinator.evaluate('p'+i,snapshot(),'delivery'));
 unknown(await f.coordinator.evaluate('overflow',snapshot(),'delivery'));assert.equal(waits.length,25);
 waits.forEach(w=>w.resolve(answer()));await Promise.all(requests);
 const next=f.coordinator.evaluate('after',snapshot(),'delivery');waits.at(-1).resolve(answer());assert.equal((await next).current,true);
 const bad=fixture({evaluate:async()=>{throw Error('secret');}});unknown(await bad.coordinator.evaluate('p',snapshot(),'delivery'));
 const badCheck=fixture({checkSnapshot:async()=>{throw Error('secret');}});unknown(await badCheck.coordinator.evaluate('p',snapshot(),'delivery'));
});

test('scope binds generation and applied revision independently of caller/exclusion',async()=>{
 const f=fixture(),first=snapshot();
 await f.coordinator.evaluate('p',first,'delivery','same');
 await f.coordinator.evaluate('p',{...first,generation:'new-generation'},'delivery','same');
 await f.coordinator.evaluate('p',{...first,revision:'12345678-1234-1234-1234-123456789abc:2'},'delivery','same');
 assert.equal(new Set(f.requests.map(r=>r.scope)).size,3);
 assert.deepEqual(f.checks.map(c=>c.fence),[{generation:first.generation,revision:first.revision},{generation:'new-generation',revision:first.revision},{generation:first.generation,revision:'12345678-1234-1234-1234-123456789abc:2'}]);
});
