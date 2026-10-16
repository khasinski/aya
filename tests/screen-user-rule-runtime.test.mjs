import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Worker} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{UserRuleRuntime,USER_RULE_LIMITS}=require('../dist-electron/screen-user-rule-runtime.js');
const {RULE_AGENTS}=require('../dist-electron/screen-rule-data.js');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const rule=(id,kind='prompt',pattern='APPROVE',flags='')=>({id,kind,pattern,flags,region:'tail',source:'user/claude.json',version:'local-1'});
function manifest(rules=[rule('local-prompt')]){return{digest:createHash('sha256').update(JSON.stringify(rules)).digest('hex'),sets:Object.fromEntries(RULE_AGENTS.map(agent=>[agent,rules])),files:[{source:'user/claude.json',version:'local-1',digest:'a'.repeat(64)}]};}
const request=(paneId='pane',scope='revision-1:caller-A:no-exclusion',text='APPROVE')=>({paneId,scope,agent:'claude',regions:{tail:text,lastLine:text,screen:text}});
class FakeWorker extends EventEmitter{
 sent=[];terminations=0;stop=null;
 postMessage(message){this.sent.push(message);}
 unref(){}
 terminate(){this.terminations++;return this.stop??Promise.resolve(1);}
}
async function fakeReady(options={}){
 const worker=new FakeWorker(),m=manifest(),runtime=new UserRuleRuntime({...options,createWorker:()=>worker});
 const starting=runtime.replace(m);await tick();worker.emit('message',{type:'ready',digest:m.digest});assert.equal(await starting,true);
 return{runtime,worker,m};
}
function answer(worker,m,job,matches=[]){worker.emit('message',{type:'result',id:job.id,digest:m.digest,matches});}
function spawnWorker(m){return new Worker(path.resolve('dist-electron/screen-user-rule-worker.js'),{workerData:m,env:{},resourceLimits:{maxOldGenerationSizeMb:64,stackSizeMb:4}});}
async function waitUntil(f){const until=performance.now()+1500;while(!f()){if(performance.now()>=until)throw Error('Worker termination did not finish');await new Promise(r=>setTimeout(r,5));}}

test('default budgets are pinned; no user files creates no worker or IPC',async()=>{
 assert.deepEqual(USER_RULE_LIMITS,{initMs:2000,activeMs:100,queueMs:1000,queueRequests:25,queueBytes:16*1024*1024,requestBytes:4*1024*1024});
 let creates=0;const runtime=new UserRuleRuntime({createWorker:()=>{creates++;throw Error('no worker expected');}});
 try{assert.equal(await runtime.replace(null),true);assert.deepEqual(await runtime.evaluate(request()),{available:true,epoch:1,digest:null,matches:[]});assert.equal(creates,0);}finally{await runtime.dispose();}
});

test('actual worker compiles every user pattern outside main and returns first matches by kind',async()=>{
 const rules=['prompt','suppressor','dialog','busy','usage-limit','account-setting'].map((kind,i)=>rule('local-'+i,kind,'WORKER_ONLY_PATTERN','i'));
 rules.push(rule('later-prompt','prompt','WORKER_ONLY_PATTERN'));
 const runtime=new UserRuleRuntime(),original=globalThis.RegExp;let forbiddenCompiles=0;
 globalThis.RegExp=function(pattern,...args){if(pattern==='WORKER_ONLY_PATTERN'){forbiddenCompiles++;throw Error('user compile reached main');}return new original(pattern,...args);};
 try{
  assert.equal(await runtime.replace(manifest(rules)),true);
  const result=await runtime.evaluate(request('p','r1:caller:excluded','prefix worker_only_pattern suffix'));
  assert.equal(result.available,true);assert.deepEqual(result.matches.map(m=>m.id),rules.slice(0,6).map(r=>r.id));
  for(const match of result.matches){assert.equal(match.start,7);assert.equal(match.length,'WORKER_ONLY_PATTERN'.length);}
  assert.equal(forbiddenCompiles,0);
 }finally{globalThis.RegExp=original;await runtime.dispose();}
});

test('syntax failure terminates and quarantines only the failed digest; changed data recovers',async()=>{
 let creates=0;const threads=[],runtime=new UserRuleRuntime({createWorker:m=>{creates++;const w=spawnWorker(m);threads.push(w);return w;}}),bad=manifest([rule('local-bad','prompt','[')]);
 try{
  assert.equal(await runtime.replace(bad),false);await waitUntil(()=>threads[0].threadId===-1);
  assert.equal((await runtime.evaluate(request())).available,false);assert.equal(await runtime.replace(bad),false);assert.equal(creates,1);
  assert.equal(await runtime.replace(manifest()),true);assert.equal(creates,2);assert.equal((await runtime.evaluate(request())).available,true);
 }finally{await runtime.dispose();}
});

for(const [pattern,flags,text] of [
 ['^(a|aa){1,100}b$','','a'.repeat(45)],
 ['^(?:(?:(a|aa){1,3}){1,3}){1,3}b$','','a'.repeat(45)],
 ['^(?:ſ+s){1,100}X$','iu','s'.repeat(45)],
 ['^(?:[ſ]+s){1,100}X$','iu','s'.repeat(45)],
])test(`actual catastrophic evaluation is terminated while main heartbeat runs: ${pattern}`,{timeout:6000},async()=>{
 const threads=[],runtime=new UserRuleRuntime({createWorker:m=>{const w=spawnWorker(m);threads.push(w);return w;}});let beats=0,timer;
 try{
  assert.equal(await runtime.replace(manifest([rule('local-pathological','prompt',pattern,flags)])),true);
  timer=setInterval(()=>beats++,5);const began=performance.now(),result=await runtime.evaluate(request('p','r1',text));
  assert.equal(result.available,false);assert.match(result.reason,/deadline/);assert.ok(performance.now()-began<2000);assert.ok(beats>=2,'main must remain responsive during regexp execution');
  await waitUntil(()=>threads[0].threadId===-1);assert.equal(threads.length,1);
  const digest=runtime.manifest;assert.equal(await runtime.replace(digest),false);assert.equal(threads.length,1);
  assert.equal(await runtime.replace(manifest()),true);assert.equal((await runtime.evaluate(request())).available,true);
 }finally{clearInterval(timer);await runtime.dispose();}
});

test('a stalled reload compile is bounded by fresh-worker initialization and actually terminated', {timeout:6000},async()=>{
 const threads=[],runtime=new UserRuleRuntime({createWorker:m=>{
  if(threads.length)assert.equal(threads[0].threadId,-1,'old worker must be gone before reload starts');
  const worker=threads.length?new Worker('while(true){}',{eval:true,env:{},resourceLimits:{maxOldGenerationSizeMb:64,stackSizeMb:4}}):spawnWorker(m);threads.push(worker);return worker;
 }});let beats=0,timer;
 try{
  assert.equal(await runtime.replace(manifest()),true);timer=setInterval(()=>beats++,10);const began=performance.now();
  assert.equal(await runtime.replace(manifest([rule('local-reload')])),false);assert.ok(performance.now()-began<4000);assert.ok(beats>=10);await waitUntil(()=>threads[1].threadId===-1);assert.equal((await runtime.evaluate(request())).available,false);
 }finally{clearInterval(timer);await runtime.dispose();}
});

test('valid initialization received at its absolute deadline cannot win before timer dispatch',async()=>{
 let now=0;const worker=new FakeWorker(),m=manifest(),runtime=new UserRuleRuntime({now:()=>now,createWorker:()=>worker});
 try{const ready=runtime.replace(m);await tick();now=2000;worker.emit('message',{type:'ready',digest:m.digest});assert.equal(await ready,false);await tick();assert.equal(worker.terminations,1);}finally{await runtime.dispose();}
});

test('valid evaluation at its absolute deadline cannot clear before timer dispatch',async()=>{
 let now=0;const {runtime,worker,m}=await fakeReady({now:()=>now});
 try{const pending=runtime.evaluate(request());now=100;answer(worker,m,worker.sent[0]);const result=await pending;assert.equal(result.available,false);assert.match(result.reason,/deadline/);await tick();assert.equal(worker.terminations,1);}finally{await runtime.dispose();}
});

test('different caller/exclusion scopes for the same pane never coalesce results',async()=>{
 const {runtime,worker,m}=await fakeReady();
 try{
  const active=runtime.evaluate(request('blocker')),a=runtime.evaluate(request('same','r1:A:excluded-a')),b=runtime.evaluate(request('same','r1:B:excluded-b'));
  answer(worker,m,worker.sent[0]);assert.equal((await active).available,true);
  assert.equal(worker.sent.length,2);answer(worker,m,worker.sent[1],[{id:'local-prompt',kind:'prompt',region:'tail',start:0,length:7}]);assert.equal((await a).matches.length,1);
  assert.equal(worker.sent.length,3);answer(worker,m,worker.sent[2]);assert.deepEqual((await b).matches,[]);
 }finally{await runtime.dispose();}
});

test('same queued context supersedes only that caller; input is copied before dispatch',async()=>{
 const {runtime,worker,m}=await fakeReady();
 try{
  const active=runtime.evaluate(request('blocker')),old=runtime.evaluate(request('same','identical-scope','OLD')),mutable=request('same','identical-scope','NEW'),next=runtime.evaluate(mutable);mutable.regions.tail='MUTATED';
  assert.equal((await old).available,false);answer(worker,m,worker.sent[0]);await active;assert.equal(worker.sent[1].regions.tail,'NEW');answer(worker,m,worker.sent[1]);assert.equal((await next).available,true);
 }finally{await runtime.dispose();}
});

test('queue expiry from healthy load is request-only and does not quarantine the digest',async()=>{
 let now=0;const {runtime,worker,m}=await fakeReady({now:()=>now});
 try{
  const pending=Array.from({length:25},(_,i)=>runtime.evaluate(request('p'+i)));
  for(let i=0;i<11;i++){now+=90;answer(worker,m,worker.sent[i]);}
  const results=await Promise.all(pending);assert.equal(results.filter(r=>r.available).length,11);assert.ok(results.slice(11).every(r=>/queue/.test(r.reason)));assert.equal(worker.terminations,0);
  const fresh=runtime.evaluate(request('later'));answer(worker,m,worker.sent.at(-1));assert.equal((await fresh).available,true);
 }finally{await runtime.dispose();}
});

for(const failure of ['bad-id','bad-digest','extra-field','unknown-rule','bad-position','duplicate-kind'])test(`malformed worker ${failure} terminates with fixed safe reason`,async()=>{
 const logs=[],{runtime,worker,m}=await fakeReady({log:(...args)=>logs.push(args)});
 try{
  const pending=runtime.evaluate(request()),reply={type:'result',id:worker.sent[0].id,digest:m.digest,matches:[]};
  const match={id:'local-prompt',kind:'prompt',region:'tail',start:0,length:7};
  if(failure==='bad-id')reply.id++;else if(failure==='bad-digest')reply.digest='b'.repeat(64);else if(failure==='extra-field')reply.secret='DO_NOT_LOG';else if(failure==='unknown-rule')reply.matches=[{...match,id:'DO_NOT_LOG'}];else if(failure==='bad-position')reply.matches=[{...match,start:1000000}];else reply.matches=[match,match];
  worker.emit('message',reply);const result=await pending;assert.equal(result.available,false);assert.match(result.reason,/invalid/);await tick();assert.equal(worker.terminations,1);assert.ok(!JSON.stringify(logs).includes('DO_NOT_LOG'));
 }finally{await runtime.dispose();}
});

test('replace waits for old termination, ignores its late result and cannot revive after dispose',async()=>{
 const first=new FakeWorker(),second=new FakeWorker(),a=manifest(),b=manifest([rule('local-new')]);let creates=0,release;
 const runtime=new UserRuleRuntime({createWorker:()=>++creates===1?first:second});
 const opening=runtime.replace(a);await tick();first.emit('message',{type:'ready',digest:a.digest});await opening;
 const old=runtime.evaluate(request()),queued=runtime.evaluate(request('queued'));first.stop=new Promise(resolve=>release=resolve);const replacing=runtime.replace(b);await tick();assert.equal(creates,1);assert.equal((await old).available,false);assert.equal((await queued).available,false);
 first.emit('message',{type:'result',id:first.sent[0].id,digest:a.digest,matches:[]});
 const disposed=runtime.dispose();release(1);assert.equal(await replacing,false);await disposed;assert.equal(creates,1);assert.equal(await runtime.replace(a),false);
});


test('the private manifest snapshot cannot be changed by a caller after compilation',async()=>{
 const {runtime,worker,m}=await fakeReady();
 try{
  m.sets.claude[0].id='caller-mutated';const pending=runtime.evaluate(request());
  answer(worker,m,worker.sent[0],[{id:'local-prompt',kind:'prompt',region:'tail',start:0,length:7}]);assert.equal((await pending).available,true);
 }finally{await runtime.dispose();}
});

test('queue and UTF8 byte caps refuse only that request and retain a usable worker',async()=>{
 const {runtime,worker,m}=await fakeReady();
 try{
  const oversized=request('too-large','r1','界'.repeat(Math.floor(USER_RULE_LIMITS.requestBytes/3)+1));oversized.regions.screen='';oversized.regions.lastLine='';
  assert.match((await runtime.evaluate(oversized)).reason,/text limit/);
  const active=runtime.evaluate(request('blocker')),queued=[];
  const full='x'.repeat(USER_RULE_LIMITS.requestBytes);
  for(let i=0;i<4;i++){const r=request('large-'+i,'r1',full);r.regions.screen='';r.regions.lastLine='';queued.push(runtime.evaluate(r));}
  assert.equal(runtime.queuedBytes,USER_RULE_LIMITS.queueBytes);
  assert.match((await runtime.evaluate(request('overflow','r1','x'))).reason,/queue is full/);assert.equal(worker.terminations,0);
  answer(worker,m,worker.sent[0]);await active;
  for(let i=0;i<4;i++)answer(worker,m,worker.sent[i+1]);assert.ok((await Promise.all(queued)).every(r=>r.available));
  const jobs=[runtime.evaluate(request('next-active'))];for(let i=0;i<25;i++)jobs.push(runtime.evaluate(request('slot-'+i)));
  assert.match((await runtime.evaluate(request('26th-queued'))).reason,/queue is full/);
  for(let i=0;i<26;i++)answer(worker,m,worker.sent[5+i]);assert.ok((await Promise.all(jobs)).every(r=>r.available));assert.equal(worker.terminations,0);
 }finally{await runtime.dispose();}
});

test('replacing an initializing candidate ignores its ready/error/exit after the next epoch',async()=>{
 const workers=[new FakeWorker(),new FakeWorker()],a=manifest(),b=manifest([rule('local-new')]);let creates=0;
 const runtime=new UserRuleRuntime({createWorker:()=>workers[creates++]});
 try{
  const first=runtime.replace(a);await tick();const second=runtime.replace(b);await tick();assert.equal(await first,false);assert.equal(creates,2);
  workers[0].emit('message',{type:'ready',digest:a.digest});workers[0].emit('error',Error('DO_NOT_LOG'));workers[0].emit('exit',1);
  workers[1].emit('message',{type:'ready',digest:b.digest});assert.equal(await second,true);
  const pending=runtime.evaluate(request());answer(workers[1],b,workers[1].sent[0]);assert.equal((await pending).available,true);
 }finally{await runtime.dispose();}
});

test('worker started messages cannot extend the parent deadline or release clear evidence',async()=>{
 const {runtime,worker}=await fakeReady();
 try{const pending=runtime.evaluate(request());worker.emit('message',{type:'started',id:worker.sent[0].id});assert.equal((await pending).available,false);await tick();assert.equal(worker.terminations,1);}finally{await runtime.dispose();}
});

test('a dispatch failure quarantines once without leaking screen or regex through diagnostics',async()=>{
 const logs=[],{runtime,worker,m}=await fakeReady({log:(...args)=>logs.push(args)});
 try{worker.postMessage=()=>{throw Error('DO_NOT_LOG_SCREEN');};assert.equal((await runtime.evaluate(request())).available,false);await tick();worker.emit('exit',1);assert.equal(logs.length,1);assert.ok(!JSON.stringify(logs).includes('DO_NOT_LOG_SCREEN'));assert.equal(await runtime.replace(m),false);}finally{await runtime.dispose();}
});


test('an old termination finishing at the candidate deadline cannot start a late replacement',async()=>{
 let now=0,release,creates=0;const first=new FakeWorker(),second=new FakeWorker(),a=manifest(),b=manifest([rule('local-next')]);
 const runtime=new UserRuleRuntime({now:()=>now,createWorker:()=>++creates===1?first:second});
 try{
  const ready=runtime.replace(a);await tick();first.emit('message',{type:'ready',digest:a.digest});await ready;
  first.stop=new Promise(resolve=>release=resolve);const pending=runtime.replace(b);await tick();now=2000;release(1);
  assert.equal(await pending,false);assert.equal(creates,1);
  const retry=runtime.replace(b);await tick();second.emit('message',{type:'ready',digest:b.digest});assert.equal(await retry,true);assert.equal(creates,2);
 }finally{await runtime.dispose();}
});
