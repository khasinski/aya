import test from 'node:test';
import assert from 'node:assert/strict';
const {plannedContinuityReceipt,validatePlannedContinuity}=await import('../dist-electron/pty-handover-continuity.js');
const attempt='a'.repeat(64),peer={pid:100,startIdentity:'1:2'},owner={pid:200,startTime:'owner-start',instanceId:'b'.repeat(32),binaryHash:'c'.repeat(64)};
function sample(){
 const state={core:{bytes:200,nonce:'d'.repeat(64),sha256:'e'.repeat(64)},display:{bytes:100,nonce:'f'.repeat(64),sha256:'1'.repeat(64)},coreRawBytes:2000,coreEncodedBytes:1000,displayRawBytes:4000,displayEncodedBytes:500,deadline:Date.now()+120000,eligible:[{id:'ended',generation:'generation',outputEnd:99}],ineligible:[{id:'legacy',reason:'cannot move'}],consented:['legacy']};
 const value={checkpoint:state,credential:Buffer.alloc(32,42).toString('base64'),continuity:{owner:{...owner},receipt:plannedContinuityReceipt(attempt,peer,owner,state)}};
 const version={owner:{pid:owner.pid,startTime:owner.startTime,instanceId:owner.instanceId,hash:owner.binaryHash,incompatible:false,disconnected:[]}};
 return {state,value,version};
}
test('planned receipt is independent of object key order, excludes credentials, and binds the full checkpoint',()=>{
 const {state,value,version}=sample();const result=validatePlannedContinuity(value,attempt,peer,version,state.deadline);assert.deepEqual(result.state,state);assert.deepEqual(result.owner,owner);
 const reordered=JSON.parse(JSON.stringify(value));reordered.continuity.owner={binaryHash:owner.binaryHash,instanceId:owner.instanceId,startTime:owner.startTime,pid:owner.pid};
 assert.equal(validatePlannedContinuity(reordered,attempt,peer,version,state.deadline).receipt,result.receipt);
 assert.equal(JSON.stringify(state).includes(value.credential),false);
});
for(const [name,mutate] of Object.entries({
 'core checksum':v=>v.checkpoint.core.sha256='0'.repeat(64),
 'display checksum':v=>v.checkpoint.display.sha256='0'.repeat(64),
 'output boundary':v=>v.checkpoint.eligible[0].outputEnd++,
 'generation':v=>v.checkpoint.eligible[0].generation='other',
 'consent':v=>v.checkpoint.consented=[],
 'raw accounting':v=>v.checkpoint.coreRawBytes++,
 'encoded accounting':v=>v.checkpoint.displayEncodedBytes++,
 'owner instance':v=>v.continuity.owner.instanceId='0'.repeat(32),
 'unknown envelope key':v=>v.extra=true,
 'duplicate pane':v=>v.checkpoint.eligible.push({...v.checkpoint.eligible[0]})
}))test(`planned receipt refuses changed ${name}`,()=>{const {state,value,version}=sample();mutate(value);assert.throws(()=>validatePlannedContinuity(value,attempt,peer,version,state.deadline));});
test('planned receipt binds recipient host identity, attempt and deadline',()=>{
 const {state,value,version}=sample();for(const [a,p,d]of [[attempt,{...peer,startIdentity:'1:3'},state.deadline],['0'.repeat(64),peer,state.deadline],[attempt,peer,state.deadline+1]])assert.throws(()=>validatePlannedContinuity(value,a,p,version,d));
});
test('planned receipt cannot substitute a correctly hashed owner different from the current version identity',()=>{
 const {state,value,version}=sample();value.continuity.owner.instanceId='0'.repeat(32);value.continuity.receipt=plannedContinuityReceipt(attempt,peer,value.continuity.owner,state);
 assert.throws(()=>validatePlannedContinuity(value,attempt,peer,version,state.deadline),/owner identity changed/);
});
