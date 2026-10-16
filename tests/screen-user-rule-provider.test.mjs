import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {UserRuleProvider,USER_RELOAD_LIMITS}=require('../dist-electron/screen-user-rule-provider.js');
const {UserRuleRuntime}=require('../dist-electron/screen-user-rule-runtime.js');
const {RULE_AGENTS,loadBundledScreenRules}=require('../dist-electron/screen-rule-data.js');
const builtin=loadBundledScreenRules(),sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(f){const deadline=Date.now()+4000;while(!f()){assert.ok(Date.now()<deadline,'provider settled within bound');await sleep(5);}}
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
const manifest=(digest='a'.repeat(64))=>({digest,sets:Object.fromEntries(RULE_AGENTS.map(a=>[a,[]])),files:[]});
const request={paneId:'p',scope:'revision/caller/exclusion',agent:'claude',regions:{tail:'LOCAL',screen:'LOCAL',lastLine:'LOCAL'}};
class FakeWatcher extends EventEmitter{closed=false;close(){this.closed=true;}}
function setup(){
 let candidate=manifest(),failure;const replacements=[],evaluations=[],watchers=[],changes=[],logs=[];
 const runtime={replace:async m=>{replacements.push(m);return true;},evaluate:async r=>{evaluations.push(r);return{available:true,epoch:999,digest:candidate?.digest??null,matches:[]};},dispose:async()=>{}};
 const provider=new UserRuleProvider('/unused/screen-rules',builtin,{read:()=>candidate,createRuntime:onFailure=>{failure=onFailure;return runtime;},watch:(directory,options,notify)=>{const w=new FakeWatcher();w.notify=notify;watchers.push(w);return w;},changed:s=>changes.push(s),log:(reason,digest)=>logs.push({reason,digest})});
 return{provider,runtime,replacements,evaluations,watchers,changes,logs,set:v=>candidate=v,fail:(...args)=>failure(...args)};
}
test('reload defaults are pinned; no files starts no worker and evaluates without IPC',async()=>{
 assert.deepEqual(USER_RELOAD_LIMITS,{scanMs:1000,coalesceMs:100,stableMs:100});let threads=0;
 const provider=new UserRuleProvider('/unused/screen-rules',builtin,{read:()=>null,watch:()=>{throw Error('missing');},createRuntime:failure=>new UserRuleRuntime({log:failure,createWorker:()=>{threads++;throw Error('no thread expected');}})});
 try{provider.start();assert.equal(provider.configuration().available,true,'absent files have no artificial startup wait');await until(()=>provider.configuration().available);assert.equal(provider.configuration().manifest,null);assert.equal((await provider.evaluate(request)).available,true);provider.scan();assert.equal(threads,0);}finally{await provider.dispose();}
});
test('watch invalidates immediately, coalesces and atomically publishes the paired runtime',async()=>{
 const f=setup();try{
  f.provider.start();await until(()=>f.provider.configuration().available);const old=f.provider.configuration();
  f.set(manifest('b'.repeat(64)));f.watchers[1].notify('change','claude.json');
  assert.equal(f.provider.configuration().available,false);assert.ok(f.provider.configuration().epoch>old.epoch);
  assert.equal((await f.provider.evaluate(request)).available,false);f.provider.refresh();f.provider.refresh();
  await until(()=>f.provider.configuration().available);assert.equal(f.replacements.length,2);assert.equal(f.provider.configuration().manifest.digest,'b'.repeat(64));
  const result=await f.provider.evaluate(request);assert.equal(result.available,true);assert.equal(result.epoch,999,'runtime epoch is independent, not blindly equated');
 }finally{await f.provider.dispose();}
});
test('periodic scan detects changes without watcher events and unchanged digest does not recompile',async()=>{
 const f=setup();try{
  f.provider.start();await until(()=>f.provider.configuration().available);const epoch=f.provider.configuration().epoch;f.provider.scan();assert.equal(f.provider.configuration().epoch,epoch);
  f.set(manifest('c'.repeat(64)));await until(()=>f.provider.configuration().available&&f.provider.configuration().manifest.digest==='c'.repeat(64));
  assert.equal(f.replacements.length,2);
 }finally{await f.provider.dispose();}
});
test('a brief deletion cannot publish builtin-only clearance before stable reread',async()=>{
 let candidate=manifest(),readNull=0;const changes=[],f=setup();await f.provider.dispose();
 const provider=new UserRuleProvider('/unused/screen-rules',builtin,{read:()=>{if(!candidate)readNull++;return candidate;},watch:()=>{throw Error('unavailable');},createRuntime:()=>f.runtime,changed:s=>changes.push(s)});
 try{
  provider.start();await until(()=>provider.configuration().available);candidate=null;provider.refresh();await until(()=>readNull>0);
  assert.equal(provider.configuration().available,false);candidate=manifest('d'.repeat(64));await until(()=>provider.configuration().available);
  assert.equal(provider.configuration().manifest.digest,'d'.repeat(64));assert.equal(changes.some(s=>s.available&&s.manifest===null),false);
 }finally{await provider.dispose();}
});
test('old compilation and evaluation completions cannot publish over a new candidate',async()=>{
 const f=setup(),oldCompile=deferred();f.runtime.replace=async m=>{f.replacements.push(m);return m?.digest==='a'.repeat(64)?oldCompile.promise:true;};
 try{
  f.provider.start();await until(()=>f.replacements.length===1);f.set(manifest('b'.repeat(64)));f.provider.refresh();await until(()=>f.provider.configuration().available);
  const state=f.provider.configuration();oldCompile.resolve(true);await sleep(0);assert.equal(f.provider.configuration(),state);
  const oldEval=deferred();f.runtime.evaluate=()=>oldEval.promise;const pending=f.provider.evaluate(request);f.provider.refresh();oldEval.resolve({available:true,epoch:999,digest:state.manifest.digest,matches:[]});assert.equal((await pending).available,false);
 }finally{await f.provider.dispose();}
});
test('a candidate changed during compile is reread even without watch or scan',async()=>{
 const f=setup(),compile=deferred();f.runtime.replace=async m=>{f.replacements.push(m);return f.replacements.length===1?compile.promise:true;};
 try{
  f.provider.start();await until(()=>f.replacements.length===1);f.set(manifest('b'.repeat(64)));compile.resolve(true);await until(()=>f.provider.configuration().available);
  assert.equal(f.changes.some(s=>s.available&&s.manifest?.digest==='a'.repeat(64)),false);assert.equal(f.provider.configuration().manifest.digest,'b'.repeat(64));
 }finally{await f.provider.dispose();}
});
test('worker failure invalidates active configuration; queue expiry stays request-only',async()=>{
 const f=setup();try{
  f.provider.start();await until(()=>f.provider.configuration().available);const epoch=f.provider.configuration().epoch;
  f.runtime.evaluate=async()=>({available:false,epoch:999,digest:'a'.repeat(64),reason:'queue full'});assert.equal((await f.provider.evaluate(request)).available,false);assert.equal(f.provider.configuration().epoch,epoch);assert.equal(f.provider.configuration().available,true);
  f.fail('RAW SECRET','a'.repeat(64));assert.equal(f.provider.configuration().available,false);assert.ok(f.provider.configuration().epoch>epoch);assert.equal(f.logs.length,1);assert.doesNotMatch(JSON.stringify(f.logs),/SECRET/);
  f.provider.scan();assert.equal(f.replacements.length,1,'polling does not restart quarantined digest');
 }finally{await f.provider.dispose();}
});
test('directory replacement reattaches child watcher and watcher failures retain scan recovery',async()=>{
 const f=setup();try{
  f.provider.start();await until(()=>f.provider.configuration().available);const directory=f.watchers[1];f.watchers[0].notify('rename','screen-rules');assert.equal(directory.closed,true);assert.equal(f.provider.configuration().available,false);
  f.provider.scan();assert.equal(f.watchers.length,3);f.watchers[2].emit('error',Error('RAW PATH'));assert.equal(f.watchers[2].closed,true);f.provider.scan();assert.equal(f.watchers.length,4);await until(()=>f.provider.configuration().available);
 }finally{await f.provider.dispose();assert.ok(f.watchers.every(w=>w.closed));}
});
test('disposal settles no later candidate and every disposer waits for thread cleanup',async()=>{
 const f=setup(),compiling=deferred(),stopping=deferred();let replacing=false;f.runtime.replace=()=>{replacing=true;return compiling.promise;};f.runtime.dispose=()=>stopping.promise;
 f.provider.start();await until(()=>replacing);const first=f.provider.dispose(),second=f.provider.dispose();let done=false;second.then(()=>done=true);await sleep(0);assert.equal(done,false);compiling.resolve(true);stopping.resolve();await Promise.all([first,second]);assert.equal(f.provider.configuration().available,false);const epoch=f.provider.configuration().epoch;f.provider.scan();f.provider.refresh();assert.equal(f.provider.configuration().epoch,epoch);assert.ok(f.watchers.every(w=>w.closed));
});
test('actual private files load/reload/delete, quarantine pathological digest, and recover without main compilation',async()=>{
 fs.mkdirSync('test-results',{recursive:true});const home=fs.mkdtempSync(path.resolve('test-results/user-provider-'));fs.chmodSync(home,0o700);const directory=path.join(home,'screen-rules');fs.mkdirSync(directory,{mode:0o700});const file=path.join(directory,'claude.json'),threads=[],logs=[];
 const write=pattern=>{const bytes=JSON.stringify({schemaVersion:1,ruleSetVersion:'local-1',agent:'claude',rules:[{id:'local-only',kind:'prompt',region:'tail',pattern,flags:''}]});fs.writeFileSync(file+'.tmp',bytes,{mode:0o600});fs.renameSync(file+'.tmp',file);};
 write('LOCAL_ONLY_PROVIDER');const original=globalThis.RegExp;let mainCompiles=0;
 globalThis.RegExp=function(pattern,...args){if(pattern==='LOCAL_ONLY_PROVIDER'){mainCompiles++;throw Error('main compiled user pattern');}return new original(pattern,...args);};
 const provider=new UserRuleProvider(directory,builtin,{createRuntime:failure=>new UserRuleRuntime({log:failure,createWorker:manifest=>{const worker=new Worker(path.resolve('dist-electron/screen-user-rule-worker.js'),{workerData:manifest,env:{}});threads.push(worker);return worker;}}),log:(reason,digest)=>logs.push({reason,digest})});
 try{
  provider.start();await until(()=>provider.configuration().available);assert.equal((await provider.evaluate({...request,regions:{tail:'LOCAL_ONLY_PROVIDER',screen:'',lastLine:''}})).matches[0].id,'local-only');assert.equal(mainCompiles,0);
  write('^(a|aa){1,100}b$');await until(()=>provider.configuration().available&&provider.configuration().manifest.sets.claude[0].pattern.startsWith('^'));
  const failed=await provider.evaluate({...request,regions:{tail:'a'.repeat(45),screen:'',lastLine:''}});assert.equal(failed.available,false);assert.equal(provider.configuration().available,false);const digest=provider.configuration().manifest.digest;assert.equal(logs.at(-1).digest,digest);
  await until(()=>threads.at(-1).threadId===-1);const count=threads.length;provider.scan();assert.equal(threads.length,count);
  write('LOCAL_ONLY_PROVIDER');await until(()=>provider.configuration().available);assert.equal(threads.length,count+1);assert.equal((await provider.evaluate({...request,regions:{tail:'LOCAL_ONLY_PROVIDER',screen:'',lastLine:''}})).available,true);
  fs.unlinkSync(file);await until(()=>provider.configuration().available&&provider.configuration().manifest===null);assert.equal(mainCompiles,0);await until(()=>threads.at(-1).threadId===-1);
 }finally{globalThis.RegExp=original;await provider.dispose();fs.rmSync(home,{recursive:true,force:true});}
});

test('invalid data is unavailable with one fixed diagnostic, then corrected data recovers',async()=>{
 let invalid=true;const logs=[];
 const provider=new UserRuleProvider('/unused/screen-rules',builtin,{read:()=>{if(invalid)throw Error('PRIVATE FILE CONTENT');return manifest();},watch:()=>{throw Error('missing');},createRuntime:()=>({replace:async()=>true,evaluate:async()=>({available:true,epoch:9,digest:'a'.repeat(64),matches:[]}),dispose:async()=>{}}),log:(reason,digest)=>logs.push({reason,digest})});
 try{
  provider.start();await until(()=>provider.configuration().reason==='invalid or unsafe user rule files');assert.equal(provider.configuration().available,false);assert.equal(logs.length,1);assert.doesNotMatch(JSON.stringify(logs),/PRIVATE/);
  provider.scan();assert.equal(logs.length,1);invalid=false;provider.scan();await until(()=>provider.configuration().available);
 }finally{await provider.dispose();}
});
test('initialization failure records candidate provenance and a changed candidate is independently paired',async()=>{
 const f=setup();f.runtime.replace=async m=>{f.replacements.push(m);if(m.digest==='a'.repeat(64)){f.fail('RAW REGEX',m.digest);return false;}return true;};
 try{
  f.provider.start();await until(()=>f.provider.configuration().reason==='user rule compilation or evaluation failed');assert.equal(f.provider.configuration().manifest.digest,'a'.repeat(64));assert.equal(f.provider.configuration().available,false);
  f.set(manifest('b'.repeat(64)));f.provider.refresh();await until(()=>f.provider.configuration().available);const current=f.provider.configuration();f.fail('late old worker','a'.repeat(64));assert.equal(f.provider.configuration(),current);assert.equal(f.logs.length,1);
 }finally{await f.provider.dispose();}
});

test('construction and pre-start refresh are inert; start is idempotent',async()=>{
 const f=setup();f.provider.refresh();f.provider.scan();assert.equal(f.replacements.length,0);assert.equal(f.watchers.length,0);assert.equal(f.provider.configuration().epoch,0);
 try{f.provider.start();f.provider.start();await until(()=>f.provider.configuration().available);assert.equal(f.replacements.length,1);assert.equal(f.watchers.length,2);}finally{await f.provider.dispose();}
});

test('irrelevant unnamed watch events cannot hold builtin-only panes when files stay absent',async()=>{
 const f=setup();f.set(null);
 try{
  f.provider.start();await until(()=>f.provider.configuration().available);const before=f.provider.configuration();f.watchers[0].notify('change',null);assert.equal(f.provider.configuration(),before);assert.equal((await f.provider.evaluate(request)).available,true);assert.equal(f.replacements.length,0);assert.equal(f.evaluations.length,0);
 }finally{await f.provider.dispose();}
});
