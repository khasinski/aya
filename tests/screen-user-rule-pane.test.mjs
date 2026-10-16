import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {UserRulePanePolicy}=require('../dist-electron/screen-user-rule-pane.js');
const {GuardedRuleInput}=require('../dist-electron/screen-user-rule-input.js');
const {UserRuleRuntime}=require('../dist-electron/screen-user-rule-runtime.js');
const {RULE_AGENTS}=require('../dist-electron/screen-rule-data.js');
const {HOLD_USER_ACCOUNT,HOLD_USER_RULES_UNKNOWN}=require('../dist-electron/screen-user-rule-policy.js');
const {HOLD_APPROVAL,HOLD_ACCOUNT_SETTING}=require('../dist-electron/pane-holds.js');
const {formatPaneState}=require('../dist-electron/pane-state.js');
const mirror=require('../dist-electron/vt-mirror.js');
let serial=0;
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const rule=(kind,pattern='LOCAL')=>({id:'local-'+kind,kind,pattern,region:'tail',flags:'',source:'user/claude.json',version:'local-1'});
async function fixture(rules=[],text='❯ ',seen=false){
 const id='policy-'+(++serial),runtime=new UserRuleRuntime(),manifest={digest:'b'.repeat(64),sets:Object.fromEntries(RULE_AGENTS.map(a=>[a,rules])),files:[]};
 assert.equal(await runtime.replace(manifest),true);
 let configuration={epoch:1,available:true,manifest};const acks=[],checks=[],writes=[],calls={snapshot:0,evaluate:0,hold:0,busy:0,state:0};
 const provider={configuration:()=>configuration,evaluate:r=>{calls.evaluate++;return runtime.evaluate(r);}};
 mirror.openVtPane(id,80,24,()=>{},'claude');
 const draw=async text=>{mirror.writeVtPane(id,'\x1b[2J\x1b[H'+text);return mirror.vtSnapshot(id);};
 await draw(text);if(seen){const s=await mirror.vtSnapshot(id);assert.equal(mirror.markComposerSeenChecked(id,{generation:s.generation,revision:s.revision}),true);}
 const host={snapshot:async()=>{calls.snapshot++;return mirror.vtSnapshot(id);},check:async(id,fence)=>{checks.push(fence);return mirror.vtSnapshotMatches(id,fence);},writeLegacy:async()=>{throw Error('legacy input');},writeFenced:async(id,data,fence)=>{assert.equal(mirror.vtSnapshotMatches(id,fence),true);writes.push({data,fence});return true;},markComposer:async(id,fence)=>{acks.push(fence);return mirror.markComposerSeenChecked(id,fence);},legacyHold:async()=>{calls.hold++;return 'legacy hold';},legacyBusy:async()=>{calls.busy++;return true;},legacyState:async()=>{calls.state++;return {legacy:true};}};
 const input=new GuardedRuleInput(provider,host),policy=new UserRulePanePolicy(input,provider,host);
 return{id,policy,input,provider,host,runtime,calls,acks,checks,writes,draw,get:()=>configuration,set:s=>configuration=s,async close(){policy.dispose();input.dispose();mirror.closeVtPane(id);await runtime.dispose();}};
}

test('configured explain is read-only, includes user provenance/protection and preserves the builtin winner',async()=>{
 const f=await fixture([rule('account-setting')],'Do you want to proceed?\r\nLOCAL',true);
 try{
  const state=await f.policy.paneState(f.id),text=formatPaneState('name',state,true);
  assert.equal(state.hold,HOLD_APPROVAL);assert.equal(state.userHold,HOLD_USER_ACCOUNT);assert.equal(state.inputProtection,HOLD_USER_ACCOUNT);assert.equal(state.state,'waiting');
  assert.match(text,/hold rule: local-account-setting/);assert.match(text,/source: user\/claude.json/);assert.match(text,/automated input: blocked/);assert.match(text,/user rules: b{64}/);assert.deepEqual(f.acks,[]);assert.deepEqual(f.writes,[]);
 }finally{await f.close();}
});
test('read-only composer explain neither advances revision nor clears startup for future delivery',async()=>{
 const f=await fixture();
 try{const before=await mirror.vtSnapshot(f.id);const state=await f.policy.paneState(f.id);assert.equal(state.hold,null);assert.equal(state.state,'idle');assert.deepEqual(f.acks,[]);assert.equal((await mirror.vtSnapshot(f.id)).revision,before.revision);assert.equal((await mirror.vtSnapshot(f.id)).composerSeen,false);}finally{await f.close();}
});
test('delivery composer ACK uses the captured revision then reacquires and reevaluates, without repeated ACK',async()=>{
 const f=await fixture();
 try{
  const before=await mirror.vtSnapshot(f.id);assert.equal(await f.policy.holdReason(f.id),null);assert.deepEqual(f.acks,[{generation:before.generation,revision:before.revision}]);
  const after=await mirror.vtSnapshot(f.id);assert.equal(after.composerSeen,true);assert.notEqual(after.revision,before.revision);assert.equal(f.calls.evaluate,2);assert.equal(f.calls.snapshot,2);
  assert.equal(await f.policy.holdReason(f.id),null);assert.equal(f.acks.length,1);
  await f.input.write('team',f.id,'hello',{phase:'paste'});assert.equal(f.writes.length,1);assert.equal(f.writes[0].fence.revision,after.revision);assert.notEqual(f.writes[0].fence.revision,before.revision);
 }finally{await f.close();}
});
test('a new applied prompt between evaluation and composer ACK refuses the ACK and retains unknown',async()=>{
 const f=await fixture(),mark=f.host.markComposer;
 try{f.host.markComposer=async(id,fence)=>{await f.draw('Do you want to proceed?');return mark(id,fence);};assert.equal(await f.policy.holdReason(f.id),HOLD_USER_RULES_UNKNOWN);assert.equal((await mirror.vtSnapshot(f.id)).composerSeen,false);assert.equal(f.acks.length,1);assert.deepEqual(f.writes,[]);}finally{await f.close();}
});
test('new prompt applied after successful composer ACK cannot be cleared by its old idle decision',async()=>{
 const f=await fixture(),mark=f.host.markComposer;
 try{f.host.markComposer=async(id,fence)=>{const accepted=await mark(id,fence);await f.draw('Do you want to proceed?');return accepted;};assert.equal(await f.policy.holdReason(f.id),HOLD_APPROVAL);assert.equal(f.calls.evaluate,2);assert.deepEqual(f.writes,[]);}finally{await f.close();}
});
test('user prompt prevents composer ACK even on an otherwise idle builtin screen',async()=>{
 const f=await fixture([rule('prompt')],'LOCAL\r\n❯ ');
 try{assert.ok(await f.policy.holdReason(f.id));const state=await f.policy.paneState(f.id),text=formatPaneState('x',state,true);assert.equal(state.state,'waiting');assert.match(text,/local-prompt \(prompt; waiting\)/);assert.equal((await mirror.vtSnapshot(f.id)).composerSeen,false);assert.deepEqual(f.acks,[]);}finally{await f.close();}
});
for(const outcome of ['false','throw','reload','dispose'])test(`composer ${outcome} cannot yield old clearance or retry`,async()=>{
 const f=await fixture();let attempts=0,committed=false;
 try{f.host.markComposer=async()=>{attempts++;if(outcome==='throw'){const s=await mirror.vtSnapshot(f.id);committed=mirror.markComposerSeenChecked(f.id,{generation:s.generation,revision:s.revision});throw Error('lost ACK');}if(outcome==='reload')f.set({...f.get(),epoch:2});if(outcome==='dispose')f.policy.dispose();return outcome!=='false';};assert.equal(await f.policy.holdReason(f.id),HOLD_USER_RULES_UNKNOWN);assert.equal(attempts,1);if(outcome==='throw')assert.equal(committed,true,'the host really applied the ACK before its reply was lost');assert.equal(f.calls.evaluate,1);assert.deepEqual(f.writes,[]);}finally{await f.close();}
});
test('fresh user busy is additive; unavailable user layer retains builtin busy and account protection',async()=>{
 const f=await fixture([rule('busy')],'LOCAL\r\n❯ ',true);
 try{
  assert.equal(await f.policy.paneBusy(f.id),true);const state=await f.policy.paneState(f.id);assert.equal(state.state,'busy');assert.ok(state.evidence.some(e=>e.for==='busy'&&e.match?.id==='local-busy'));
  f.set({...f.get(),epoch:2,available:false});await f.draw('Do you want to proceed?\r\nblock reads outside the working directories from now on\r\nesc to interrupt');
  assert.equal(await f.policy.paneBusy(f.id),true);const unavailable=await f.policy.paneState(f.id);assert.equal(unavailable.hold,HOLD_ACCOUNT_SETTING);assert.equal(unavailable.inputProtection,HOLD_ACCOUNT_SETTING);assert.equal(unavailable.userRules.available,false);assert.equal(unavailable.state,'unknown');assert.match(formatPaneState('x',unavailable,false),/user rules unavailable/);assert.deepEqual(f.acks,[]);
 }finally{await f.close();}
});
test('different user/builtin waiting verdicts keep truthful per-rule explain labels',async()=>{
 const f=await fixture([rule('prompt'),rule('suppressor')],'Do you want to proceed?\r\nLOCAL',true);
 try{const state=await f.policy.paneState(f.id),text=formatPaneState('x',state,true);assert.equal(state.waiting,true);assert.match(text,/local-suppressor \(suppressor; clear\)/);assert.doesNotMatch(text,/local-prompt/);assert.equal(state.userHold,null);assert.equal(state.hold,HOLD_APPROVAL);}finally{await f.close();}
});
test('same-generation applied output and rule invalidation cannot publish a late old policy result',async()=>{
 for(const change of ['output','rules']){
  const f=await fixture([rule('busy')],'LOCAL\r\n❯ ',true),gate=deferred(),started=deferred(),evaluate=f.provider.evaluate;
  try{f.provider.evaluate=async r=>{const result=await evaluate(r);started.resolve();await gate.promise;return result;};const pending=f.policy.paneBusy(f.id);await started.promise;if(change==='output')await f.draw('❯ ');else f.set({...f.get(),epoch:2});gate.resolve();assert.equal(await pending,false);assert.deepEqual(f.acks,[]);}finally{gate.resolve();await f.close();}
 }
});
test('no user files preserve the exact legacy routes with zero worker/snapshot/ACK work',async()=>{
 const f=await fixture();
 try{f.set({epoch:2,available:true,manifest:null});assert.equal(await f.policy.holdReason(f.id,'pasted'),'legacy hold');assert.equal(await f.policy.paneBusy(f.id),true);assert.deepEqual(await f.policy.paneState(f.id),{legacy:true});assert.deepEqual(f.calls,{snapshot:0,evaluate:0,hold:1,busy:1,state:1});assert.deepEqual(f.acks,[]);}finally{await f.close();}
});
test('shell and empty-agent state stay truthful under additive rules',async()=>{
 const f=await fixture();
 try{
  await f.draw('');assert.equal((await f.policy.paneState(f.id)).state,'unknown');
  mirror.closeVtPane(f.id);mirror.openVtPane(f.id,80,24,()=>{},undefined,true);
  assert.equal((await f.policy.paneState(f.id)).state,'shell');assert.deepEqual(f.acks,[]);
 }finally{await f.close();}
});

test('missing screen preserves read-only stopped/starting status without blaming valid user rules or adopting active clearance',async()=>{
 const f=await fixture();
 try{f.host.snapshot=async()=>null;for(const state of ['stopped','starting','idle']){
  f.host.legacyState=async()=>({state,hold:state==='idle'?null:'not running',busy:false,waiting:null,generation:null,rules:{available:true},evidence:[]});
  const result=await f.policy.paneState(f.id);assert.equal(result.state,state==='idle'?'unknown':state);assert.equal(result.userRules.available,true);assert.doesNotMatch(formatPaneState('x',result,false),/user rules unavailable/);if(state==='idle')assert.equal(result.inputProtection,HOLD_USER_RULES_UNKNOWN);
 }assert.equal(f.calls.evaluate,0);assert.deepEqual(f.acks,[]);}finally{await f.close();}
});

for(const method of ['holdReason','paneBusy','paneState'])for(const end of ['configuration-change','dispose'])test(`no-files legacy ${method} refuses late ${end} completion`,async()=>{
 const f=await fixture([], '❯ ', true),gate=deferred(),started=deferred();
 try{
  f.set({...f.get(),epoch:2,available:true,manifest:null});
  const value=method==='holdReason'?null:method==='paneBusy'?true:{state:'idle',hold:null,busy:false,waiting:false,generation:'g',rules:{available:true},evidence:[]};
  f.host[method==='holdReason'?'legacyHold':method==='paneBusy'?'legacyBusy':'legacyState']=()=>{started.resolve();return gate.promise;};
  const pending=f.policy[method](f.id);await started.promise;
  if(end==='configuration-change')f.set({...f.get(),epoch:3,available:false,manifest:f.get().manifest,reason:'reload pending'});else f.policy.dispose();
  gate.resolve(value);
  if(method==='holdReason')assert.equal(await pending,HOLD_USER_RULES_UNKNOWN);
  else if(method==='paneBusy')assert.equal(await pending,false);
  else{const state=await pending;assert.equal(state.state,'unknown');assert.equal(state.hold,HOLD_USER_RULES_UNKNOWN);}
 }finally{gate.resolve();await f.close();}
});
