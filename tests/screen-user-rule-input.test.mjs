import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {rpc} from './helpers/control-rpc.mjs';
const require=createRequire(import.meta.url);
const {GuardedRuleInput}=require('../dist-electron/screen-user-rule-input.js');
const {UserRuleRuntime}=require('../dist-electron/screen-user-rule-runtime.js');
const {RULE_AGENTS}=require('../dist-electron/screen-rule-data.js');
const {startControlServerOn,deliverTeamMessage,PASTE_START,PASTE_END}=require('../dist-electron/control.js');
const mirror=require('../dist-electron/vt-mirror.js'),{snapshotHold}=require('../dist-electron/vt-state.js');
const {HOLD_APPROVAL,HOLD_DRAFT,HOLD_STARTING}=require('../dist-electron/pane-holds.js');
const {HOLD_USER_ACCOUNT,HOLD_USER_RULES_UNKNOWN}=require('../dist-electron/screen-user-rule-policy.js');
let sequence=0;
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const rule=(kind,pattern='LOCAL_ACCOUNT')=>({id:'local-'+kind,kind,pattern,region:'tail',flags:'',source:'user/claude.json',version:'local-1'});
async function fixture(rules=[rule('account-setting'),rule('dialog')],text='❯ ',seen=true){
 const id='input-'+(++sequence),runtime=new UserRuleRuntime(),manifest={digest:'a'.repeat(64),sets:Object.fromEntries(RULE_AGENTS.map(a=>[a,rules])),files:[]};
 assert.equal(await runtime.replace(manifest),true);
 let configuration={epoch:1,available:true,manifest};const writes=[],checks=[],checkedCalls=[],legacy=[],requests=[];
 const provider={configuration:()=>configuration,evaluate:request=>{requests.push(request);return runtime.evaluate(request);}};
 mirror.openVtPane(id,80,24,()=>{},'claude');
 const draw=async text=>{mirror.writeVtPane(id,'\x1b[2J\x1b[H'+text);return mirror.vtSnapshot(id);};
 await draw(text);if(seen){const s=await mirror.vtSnapshot(id);assert.equal(mirror.markComposerSeenChecked(id,{generation:s.generation,revision:s.revision}),true);}
 const host={snapshot:()=>mirror.vtSnapshot(id),check:async(id,fence)=>{checks.push(fence);return mirror.vtSnapshotMatches(id,fence);},writeLegacy:async(id,data)=>{legacy.push(data);return true;},writeFenced:async(id,data,fence)=>{if(!mirror.vtSnapshotMatches(id,fence))throw Object.assign(Error('Revision changed; this input was not sent.'),{code:'PTY_HOST_STALE_REVISION'});writes.push(data);return true;}};
 const input=new GuardedRuleInput(provider,host);
 return{id,input,provider,host,runtime,writes,checks,checkedCalls,legacy,requests,draw,set:s=>configuration=s,state:()=>configuration,async close(){input.dispose();mirror.closeVtPane(id);await runtime.dispose();}};
}
async function control(f,onWrite){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aya-rule-input-')),socket=path.join(root,'control.sock');
 const stop=startControlServerOn(socket,{getWindow:()=>null,openProject:()=>{},listProjects:async()=>[{slug:'p',tabs:[{id:f.id,name:'Target'}]}],readPane:async()=>'',writePane:async()=>{throw Error('legacy writer must not run');},paneHold:async()=>snapshotHold(await mirror.vtSnapshot(f.id)).hold,paneInputProtection:(id,pasted)=>f.input.protection(id,pasted),writePaneChecked:async(id,data,context)=>{f.checkedCalls.push({data,...context});const result=await f.input.write('direct',id,data,context);await onWrite?.(data);return result;}});
 return{send:(text='hello')=>rpc(socket,{type:'pane-send',target:'Target',text,submit:true}),close(){stop();fs.rmSync(root,{recursive:true,force:true});}};
}
for(const [name,text,seen,expected,rules] of [
 ['builtin approval','Do you want to proceed?\r\nLOCAL_ACCOUNT',true,HOLD_APPROVAL,[rule('account-setting')]],
 ['builtin draft','❯ half typed\r\nLOCAL_ACCOUNT',true,HOLD_DRAFT,[rule('account-setting'),rule('dialog')]],
 ['builtin startup','LOCAL_ACCOUNT',false,HOLD_STARTING,[rule('account-setting'),rule('dialog')]],
])test(`real control pre-paste user account protection survives ${name}`,async()=>{
 const f=await fixture(rules,text,seen);let server;
 try{
  const d=await f.input.decision(f.id,'explain');assert.equal(d.decision.hold,expected);assert.equal(d.decision.userHold,HOLD_USER_ACCOUNT);assert.equal(d.decision.inputProtection,HOLD_USER_ACCOUNT);
  await assert.rejects(f.input.write('direct',f.id,'not allowed',{phase:'paste'}),e=>e.code==='PTY_HOST_INPUT_PROTECTED');assert.deepEqual(f.writes,[]);
  server=await control(f);const result=await server.send();assert.equal(result.ok,false);assert.match(result.error,/user-defined account-setting/);assert.deepEqual(f.writes,[]);assert.deepEqual(f.checkedCalls,[],'control refuses before invoking even the guarded writer');
 }finally{server?.close();await f.close();}
});
test('real control checks new account protection before Enter without hiding it behind builtin approval',async()=>{
 const f=await fixture([rule('account-setting')]);let server;
 try{
  server=await control(f,async data=>{if(data!=='\r')await f.draw('Do you want to proceed?\r\nLOCAL_ACCOUNT');});
  const result=await server.send();assert.equal(result.ok,false);
  assert.deepEqual(f.writes,['hello']);assert.deepEqual(f.checkedCalls.map(c=>c.phase),['paste'],'control must refuse CR before calling guarded writer');
  assert.match(result.error,/user-defined account-setting/);assert.match(result.error,/Enter not sent/);
 }finally{server?.close();await f.close();}
});
test('user account text without any active builtin/user dialog adds no hold and does not block explicit input',async()=>{
 const f=await fixture([rule('account-setting')],'LOCAL_ACCOUNT\r\n❯ ');let server;
 try{server=await control(f);const result=await server.send();assert.equal(result.ok,true);assert.deepEqual(f.writes,['hello','\r']);assert.deepEqual(f.checkedCalls,[{data:'hello',phase:'paste'},{data:'\r',phase:'enter',pasted:'hello'}]);assert.deepEqual(f.legacy,[]);}finally{server?.close();await f.close();}
});
test('unavailable user candidate blocks control before paste and before Enter',async()=>{
 for(const afterPaste of [false,true]){
  const f=await fixture();let server;
  try{
   const invalidate=()=>f.set({epoch:2,available:false,manifest:f.state().manifest});if(!afterPaste)invalidate();
   server=await control(f,async()=>{if(afterPaste)invalidate();});const result=await server.send();assert.equal(result.ok,false);assert.match(result.error,/user screen rules are unavailable/);assert.deepEqual(f.writes,afterPaste?['hello']:[]);assert.equal(f.checkedCalls.length,afterPaste?1:0);
  }finally{server?.close();await f.close();}
 }
});
test('applied but unbroadcast output during worker evaluation refuses before any host write',async()=>{
 const f=await fixture(),wait=deferred(),started=deferred();const evaluate=f.provider.evaluate;f.provider.evaluate=request=>{started.resolve();return wait.promise;};
 try{
  const pending=f.input.write('direct',f.id,'never',{phase:'paste'});await started.promise;
  const applied=await f.draw('Do you want to proceed?');assert.equal(mirror.vtSnapshotMatches(f.id,{generation:applied.generation,revision:applied.revision}),true);
  wait.resolve({available:true,epoch:1,digest:f.state().manifest.digest,matches:[]});await assert.rejects(pending,e=>e.code==='PTY_HOST_RULES_UNAVAILABLE'&&/not sent/.test(e.message));assert.deepEqual(f.writes,[]);
 }finally{f.provider.evaluate=evaluate;await f.close();}
});
test('host first-byte refusal and uncertain lost ACK propagate once without retry',async()=>{
 for(const code of ['PTY_HOST_STALE_REVISION','PTY_HOST_UNCERTAIN_INPUT']){
  const f=await fixture();let attempts=0;const error=Object.assign(Error(code),{code});f.host.writeFenced=async()=>{attempts++;throw error;};
  try{await assert.rejects(f.input.write('direct',f.id,'one paste',{phase:'paste'}),e=>e===error);assert.equal(attempts,1);assert.deepEqual(f.writes,[]);}finally{await f.close();}
 }
});
test('reload and cancellation during evaluation prevent a late continuation; no-files uses only legacy writer',async()=>{
 for(const mode of ['reload','cancel','dispose']){
  const f=await fixture(),wait=deferred(),started=deferred();let cancelled=false;f.provider.evaluate=()=>{started.resolve();return wait.promise;};
  try{const p=f.input.write('direct',f.id,'late',{phase:'paste'},()=>cancelled);await started.promise;if(mode==='reload')f.set({...f.state(),epoch:2});else if(mode==='cancel')cancelled=true;else f.input.dispose();wait.resolve({available:true,epoch:1,digest:'a'.repeat(64),matches:[]});await assert.rejects(p,/not sent/);assert.deepEqual(f.writes,[]);}finally{await f.close();}
 }
 const f=await fixture();try{f.set({epoch:2,available:true,manifest:null});f.host.snapshot=async()=>{throw Error('no extra read');};assert.equal(await f.input.write('team',f.id,'legacy',{phase:'paste'}),true);assert.deepEqual(f.legacy,['legacy']);assert.equal(f.requests.length,0);}finally{await f.close();}
});
test('team checked paste honors fresh user busy, Enter excludes only its own pasted text',async()=>{
 const f=await fixture([rule('busy','LOCAL_BUSY')],'LOCAL_BUSY\r\n❯ ');
 try{await assert.rejects(f.input.write('team',f.id,'work',{phase:'paste'}),e=>e.code==='PTY_HOST_INPUT_BUSY');assert.deepEqual(f.writes,[]);}finally{await f.close();}
 const g=await fixture([rule('account-setting'),rule('dialog')]);
 try{
  const result=await deliverTeamMessage(async()=>{throw Error('unchecked writer');},g.id,'ordinary task',async()=>null,undefined,undefined,undefined,undefined,(id,data,context)=>{g.checkedCalls.push({data,...context});return g.input.write('team',id,data,context);});
  assert.equal(result,null);assert.deepEqual(g.writes,[PASTE_START+'ordinary task'+PASTE_END,'\r']);assert.deepEqual(g.checkedCalls.map(c=>[c.phase,c.pasted]),[['paste',undefined],['enter','ordinary task']]);
 }finally{await g.close();}
});

test('team control checks user account contribution before paste and before Enter independently of writer refusal',async()=>{
 for(const afterPaste of [false,true]){
  const f=await fixture([rule('account-setting')],afterPaste?'❯ ':'Do you want to proceed?\r\nLOCAL_ACCOUNT');
  try{
   const hold=async(id,pasted)=>{const result=await f.input.decision(id,pasted===undefined?'team:protect-paste':'team:protect-enter',pasted);return result?.decision.userHold??result?.decision.hold??null;};
   const pending=deliverTeamMessage(async()=>{throw Error('unchecked writer');},f.id,'ordinary task',hold,undefined,undefined,undefined,undefined,async(id,data,context)=>{
    f.checkedCalls.push({data,...context});const written=await f.input.write('team',id,data,context);if(context.phase==='paste')await f.draw('Do you want to proceed?\r\nLOCAL_ACCOUNT');return written;
   });
   await assert.rejects(pending,e=>e.typed===afterPaste&&/user-defined account-setting/.test(e.message));
   assert.equal(f.checkedCalls.length,afterPaste?1:0,'upstream team guard refuses before checked writer');assert.deepEqual(f.writes,afterPaste?[PASTE_START+'ordinary task'+PASTE_END]:[]);
  }finally{await f.close();}
 }
});

test('team Enter cannot let the builtin draft exception hide a user-added prompt',async()=>{
 const f=await fixture([rule('prompt','LOCAL_NOTICE')],'❯ half typed\r\nLOCAL_NOTICE');
 try{
  const result=await f.input.decision(f.id,'explain');assert.equal(result.decision.hold,HOLD_DRAFT);assert.equal(result.decision.userHold,HOLD_APPROVAL);
  await assert.rejects(f.input.write('team',f.id,'\r',{phase:'enter',pasted:'ordinary task'}),e=>e.code==='PTY_HOST_INPUT_HELD');assert.deepEqual(f.writes,[]);
 }finally{await f.close();}
});

test('the worker caller/phase cannot change while its decision is pending',async()=>{
 const f=await fixture([rule('busy','LOCAL_BUSY')],'LOCAL_BUSY\r\n❯ '),started=deferred(),release=deferred(),evaluate=f.provider.evaluate;
 f.provider.evaluate=async request=>{const result=await evaluate(request);started.resolve();await release.promise;return result;};
 try{
  const context={phase:'paste'},pending=f.input.write('team',f.id,'must not become an Enter',context);await started.promise;context.phase='enter';release.resolve();
  await assert.rejects(pending,e=>e.code==='PTY_HOST_INPUT_BUSY');assert.deepEqual(f.writes,[]);
 }finally{release.resolve();await f.close();}
});
