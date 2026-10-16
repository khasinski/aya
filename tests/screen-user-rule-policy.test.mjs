import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {composeUserRuleDecision:compose,HOLD_USER_ACCOUNT,HOLD_USER_RULES_UNKNOWN}=require('../dist-electron/screen-user-rule-policy.js');
const holds=require('../dist-electron/pane-holds.js');
const {RULE_AGENTS}=require('../dist-electron/screen-rule-data.js');
const {UserRuleRuntime}=require('../dist-electron/screen-user-rule-runtime.js');
const kinds=['prompt','dialog','suppressor','busy','account-setting','usage-limit'];
const rules=kinds.map(kind=>({id:`local-${kind}`,kind,region:'tail',pattern:'ONLY_WORKER',flags:'',source:'user/claude.json',version:'local-1'}));
const manifest={digest:'a'.repeat(64),sets:Object.fromEntries(RULE_AGENTS.map(a=>[a,rules])),files:[]};
const context={agent:'claude',regions:{tail:'ONLY_WORKER',screen:'ONLY_WORKER',lastLine:'ONLY_WORKER'}};
const idle={hold:null,busy:false,waiting:false};
const answer=(...kinds)=>({available:true,epoch:1,digest:manifest.digest,matches:kinds.map(kind=>({id:`local-${kind}`,kind,region:'tail',start:0,length:11}))});
const apply=(base=idle,...kinds)=>compose(base,context,manifest,answer(...kinds));

test('absent user files preserve builtin policy exactly without requiring a worker result',()=>{
 for(const hold of [null,...Object.values(holds).filter(v=>typeof v==='string')])for(const busy of [false,true])for(const waiting of [false,true,null]){
  const result=compose({hold,busy,waiting},context,null,{available:false,epoch:99,digest:null,reason:'not initialized'});
  assert.equal(result.hold,hold);assert.equal(result.busy,busy);assert.equal(result.waiting,waiting);
  assert.equal(result.blocksAutomatedInput,hold===holds.HOLD_ACCOUNT_SETTING);assert.equal(result.user.digest,null);
 }
});
for(const hold of [holds.HOLD_APPROVAL,holds.HOLD_DRAFT,holds.HOLD_STARTING,holds.HOLD_SHELL,holds.HOLD_RECOVERY_UNKNOWN,holds.HOLD_ACCOUNT_SETTING])test(`user clear/suppressor cannot remove builtin hold: ${hold}`,()=>{
 const base={hold,busy:true,waiting:true};
 for(const matches of [[],['suppressor'],['prompt','suppressor']]){
  const result=apply(base,...matches);assert.equal(result.hold,hold);assert.equal(result.busy,true);assert.equal(result.waiting,true);
 }
});
test('prompt, suppressor and dialog ordering is confined to user evidence',()=>{
 assert.equal(apply(idle,'prompt').hold,holds.HOLD_APPROVAL);
 assert.equal(apply(idle,'prompt','suppressor').hold,null);
 assert.equal(apply(idle,'prompt','suppressor').waiting,false);
 assert.equal(apply(idle,'dialog','suppressor').hold,holds.HOLD_APPROVAL);
 assert.equal(apply(idle,'dialog','suppressor').waiting,true);
 assert.equal(apply({...idle,waiting:null},'prompt').waiting,true);
});
test('user account protection survives every builtin display reason independently',()=>{
 for(const hold of [null,holds.HOLD_DRAFT,holds.HOLD_STARTING,holds.HOLD_SHELL,holds.HOLD_APPROVAL,holds.HOLD_ACCOUNT_SETTING]){
  const result=apply({hold,busy:false,waiting:true},'account-setting');
  assert.equal(result.hold,hold??HOLD_USER_ACCOUNT);assert.equal(result.userHold,HOLD_USER_ACCOUNT);
  assert.equal(result.blocksAutomatedInput,true);assert.equal(result.inputProtection,hold===holds.HOLD_ACCOUNT_SETTING?holds.HOLD_ACCOUNT_SETTING:HOLD_USER_ACCOUNT);
  assert.equal(result.user.evidence[0].source,'user/claude.json');
 }
});
test('account and usage rules require an active builtin or user dialog/choice',()=>{
 for(const kind of ['account-setting','usage-limit']){
  const alone=apply(idle,kind);assert.equal(alone.hold,null);assert.equal(alone.blocksAutomatedInput,false);assert.deepEqual(alone.user.evidence,[]);
  assert.equal(apply(idle,'prompt','suppressor',kind).hold,null);
  for(const base of [idle,{...idle,hold:holds.HOLD_CHOICE,waiting:true}]){
   const result=apply(base,'dialog',kind);assert.equal(result.userHold,kind==='account-setting'?HOLD_USER_ACCOUNT:holds.HOLD_USAGE_LIMIT);
  }
 }
 const both=apply(idle,'dialog','account-setting','usage-limit');assert.equal(both.hold,HOLD_USER_ACCOUNT);assert.equal(both.blocksAutomatedInput,true);
});
test('busy is additive and builtin account protection never depends on user success',()=>{
 assert.equal(apply(idle,'busy').busy,true);assert.equal(apply({...idle,busy:true}).busy,true);
 assert.equal(apply({...idle,hold:holds.HOLD_ACCOUNT_SETTING},'suppressor').blocksAutomatedInput,true);
});
test('unavailable, wrong digest and recovery unknown never authorize automation or clear builtin waiting/busy',()=>{
 for(const base of [idle,{hold:holds.HOLD_APPROVAL,busy:true,waiting:true},{hold:holds.HOLD_SHELL,busy:false,waiting:false}]){
  for(const result of [{available:false,epoch:1,digest:manifest.digest,reason:'\x1bSECRET'}, {...answer(),digest:'b'.repeat(64)}]){
   const merged=compose(base,context,manifest,result);assert.equal(merged.hold,base.hold??HOLD_USER_RULES_UNKNOWN);assert.equal(merged.busy,base.busy);
   assert.equal(merged.waiting,base.waiting===true?true:null);assert.equal(merged.blocksAutomatedInput,true);assert.equal(merged.user.reason,HOLD_USER_RULES_UNKNOWN);
  }
 }
 const recovery=compose({...idle,hold:holds.HOLD_RECOVERY_UNKNOWN},{...context,recoveryUnknown:true},manifest,answer('busy'));
 assert.equal(recovery.hold,holds.HOLD_RECOVERY_UNKNOWN);assert.equal(recovery.busy,false);assert.equal(recovery.blocksAutomatedInput,true);
});
test('explain evidence is main-derived, sanitized and preserves specific provenance',()=>{
 const text='\x1b]52;c;HIDDEN\x07VISIBLE\u202e';
 const result=compose(idle,{...context,regions:{...context.regions,tail:text}},manifest,{...answer('prompt'),matches:[{...answer('prompt').matches[0],length:text.length}]});
 assert.deepEqual(result.user.evidence,[{id:'local-prompt',kind:'prompt',region:'tail',source:'user/claude.json',version:'local-1',digest:manifest.digest,excerpt:'VISIBLE'}]);
});
test('malformed evidence cannot produce a clear authorization',()=>{
 for(const matches of [[{...answer('prompt').matches[0],id:'absent'}],[{...answer('prompt').matches[0],start:-1}],[{...answer('prompt').matches[0],length:12}],answer('prompt','prompt').matches]){
  const result=compose(idle,context,manifest,{...answer(),matches});assert.equal(result.user.available,false);assert.equal(result.blocksAutomatedInput,true);
 }
});
test('real worker evidence composes without compiling user source on main',async()=>{
 const worker=new UserRuleRuntime(),original=globalThis.RegExp;let compiles=0;
 globalThis.RegExp=function(pattern,...rest){if(pattern==='ONLY_WORKER'){compiles++;throw Error('main compile');}return new original(pattern,...rest);};
 try{
  await worker.replace(manifest);const result=await worker.evaluate({paneId:'p',scope:'revision:caller:exclusion',...context});
  const composed=compose(idle,context,manifest,result);assert.equal(composed.hold,HOLD_USER_ACCOUNT);assert.equal(composed.busy,true);assert.equal(composed.blocksAutomatedInput,true);assert.equal(compiles,0);
 }finally{globalThis.RegExp=original;await worker.dispose();}
});
