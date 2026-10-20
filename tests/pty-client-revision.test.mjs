import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PtyHostClient} from '../dist-electron/pty-host-client.js';
const fence={generation:'g',revision:'12345678-1234-1234-1234-123456789012:1'};
const policyEpoch='a'.repeat(32)+':1';
test('checked input uses only its distinct verb, requires a boolean outcome, and never falls back on a legacy refusal',async()=>{
 for(const answer of [true,false,null,undefined]){
  const c=new PtyHostClient('/unused'),calls=[];c.socket={destroyed:false,destroy(){this.destroyed=true;}};c.sendRequest=async(_socket,request)=>{calls.push(request.type);return request.type==='rule-policy-epoch'?true:answer;};c.readExistingRequest=async request=>{calls.push(request.type);return answer;};
  try{
   if(typeof answer==='boolean')assert.equal(await c.writeAtSnapshot('p','text',fence,policyEpoch),answer);
   else await assert.rejects(c.writeAtSnapshot('p','text',fence,policyEpoch),/outcome is unknown.*did not resend/);
   assert.deepEqual(calls,['rule-policy-epoch','write-fenced']);
  }finally{c.dispose();}
 }
 const c=new PtyHostClient('/unused'),calls=[];c.socket={destroyed:false,destroy(){this.destroyed=true;}};c.sendRequest=async(_socket,request)=>{calls.push(request.type);if(request.type==='rule-policy-epoch')return true;throw Error('unknown request');};
 try{await assert.rejects(c.writeAtSnapshot('p','text',fence,policyEpoch),/unknown request/);assert.deepEqual(calls,['rule-policy-epoch','write-fenced']);}
 finally{c.dispose();}
});
test('revision check and composer ACK require exact positive answers; missing fences make no request',async()=>{
 const c=new PtyHostClient('/unused'),calls=[];
 try{
  for(const answer of [null,undefined,false,true]){
   c.socket={destroyed:false,destroy(){this.destroyed=true;}};c.sendRequest=async(_socket,request)=>{calls.push(request.type);return answer;};c.readExistingRequest=async request=>{calls.push(request.type);return answer;};
   assert.equal(await c.checkSnapshot('p',fence),answer===true);
   assert.equal(await c.markComposerAtSnapshot('p',fence),answer===true);
  }
  assert.deepEqual(calls,['snapshot-check','composer-seen-checked','snapshot-check','composer-seen-checked','snapshot-check','composer-seen-checked','snapshot-check','composer-seen-checked']);
  calls.length=0;assert.equal(await c.checkSnapshot('p',{}),false);assert.equal(await c.markComposerAtSnapshot('p',{}),false);
  await assert.rejects(c.writeAtSnapshot('p','text',{},policyEpoch),error=>error.code==='PTY_HOST_STALE_REVISION'&&error.message.includes('not sent'));
  assert.deepEqual(calls,[]);
 }finally{c.dispose();}
});
test('typed stale response is preserved and a lost checked-write ACK remains uncertain, never resent',async()=>{
 const c=new PtyHostClient('/unused');
 try{
  const refused=new Promise((_resolve,reject)=>c.pending.set(1,{reject,type:'write-fenced'}));
  c.onResponse({id:1,ok:false,error:'This input was not sent',code:'PTY_HOST_STALE_REVISION'});
  await assert.rejects(refused,{code:'PTY_HOST_STALE_REVISION'});
  const uncertain=new Promise((_resolve,reject)=>c.pending.set(2,{reject,type:'write-fenced',ptyId:'p'}));
  c.onClose();await assert.rejects(uncertain,/Some bytes may have reached.*did not resend/);
  assert.equal(c.uncertainInput.has('p'),true,'a recovered pane must also disclose a lost fenced-write acknowledgement');
 }finally{c.dispose();}
});
