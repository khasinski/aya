import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import childProcess from 'node:child_process';
const require=createRequire(import.meta.url);
const {restartRefusedHost}=require('../dist-electron/pty-host-auth-restart.js');
const target=(pid,startTime,instance='a')=>({pid,startTime,identity:null,ptyCount:1,owner:{pid:pid+10,startTime:'owner',instanceId:instance.repeat(32),hash:'b'.repeat(64),inventory:[{id:'pane',pid:pid+20}],incompatible:false,disconnected:['pane']},authentication:{required:true,targetVerified:true,inventoryKnown:true,reason:'auth refused'}});
function fixture(sequence){
 const signals=[],logs=[],waits=[];let cancelled=false,inspections=0;
 return {signals,logs,waits,get inspections(){return inspections;},cancel(){cancelled=true;},deps:{
  inspect:async()=>structuredClone(sequence[Math.min(inspections++,sequence.length-1)]),
  group:()=>700,signal:(...args)=>{signals.push(args);return 'signalled';},
  waitGone:async(...args)=>{waits.push(args);return true;},cancelled:()=>cancelled,log:(...args)=>logs.push(args),
 }};
}
test('consent for A cannot signal B; Cancel keeps both untouched and asks with B inventory',async()=>{
 const a=target(100,'1:1'),b=target(200,'2:2','c'),f=fixture([b]);let questions=0;
 await assert.rejects(restartRefusedHost({target:a,confirmChanged:async current=>{questions++;assert.deepEqual(current.owner.inventory,[{id:'pane',pid:220}]);return false;}},f.deps),/restart cancelled/);
 assert.equal(questions,1);assert.deepEqual(f.signals,[]);assert.deepEqual(f.waits,[]);
});
test('fresh B consent is re-read before a single individual signal and logs the checked identity',async()=>{
 const a=target(100,'1:1'),b=target(200,'2:2','c'),f=fixture([b,b,b]);let questions=0;
 assert.equal(await restartRefusedHost({target:a,confirmChanged:async()=>{questions++;return true;}},f.deps),true);
 assert.equal(questions,1);assert.equal(f.inspections,3);assert.deepEqual(f.signals,[[200,'2:2',700]]);assert.deepEqual(f.waits,[[200,'2:2']]);
 assert.deepEqual(f.logs,[['pty-host-auth-confirmed-sigterm',{pid:200,startIdentity:'2:2',ownerInstance:'c'.repeat(32),outcome:'signalled'}]]);
});
test('verified legacy target with unknown inventory accepts fresh consent, rechecks and signals once without replacement',async()=>{
 const previous=target(100,'1:1'),current=target(200,'2:2');delete current.owner;
 current.ptyCount=0;current.authentication.inventoryKnown=false;
 const f=fixture([current,current,current]),spawn=childProcess.spawn;let questions=0,starts=0;
 childProcess.spawn=()=>{starts++;throw Error('no replacement may be started');};
 try{
  assert.equal(await restartRefusedHost({target:previous,confirmChanged:async fresh=>{
   questions++;assert.equal(fresh.pid,200);assert.equal(fresh.startTime,'2:2');assert.equal(fresh.owner,undefined);
   assert.equal(fresh.authentication.targetVerified,true);assert.equal(fresh.authentication.inventoryKnown,false);return true;
  }},f.deps),true);
  assert.equal(questions,1);assert.equal(f.inspections,3);assert.equal(starts,0);
  assert.deepEqual(f.signals,[[200,'2:2',700]]);assert.deepEqual(f.waits,[[200,'2:2']]);
  assert.deepEqual(f.logs,[['pty-host-auth-confirmed-sigterm',{pid:200,startIdentity:'2:2',ownerInstance:null,outcome:'signalled'}]]);
 }finally{childProcess.spawn=spawn;}
});
test('socket replacement after the group probe still asks again before signaling',async()=>{
 const a=target(100,'1:1'),b=target(200,'2:2','c'),f=fixture([a,b]);let questions=0;
 await assert.rejects(restartRefusedHost({target:a,confirmChanged:async current=>{questions++;assert.equal(current.pid,200);return false;}},f.deps),/restart cancelled/);
 assert.equal(questions,1);assert.deepEqual(f.signals,[]);
});
test('missing or unverified identity refuses even a blanket yes, and never signals or waits',async()=>{
 for(const change of [{pid:null},{startTime:null},{authentication:{required:true,targetVerified:false,inventoryKnown:false,reason:'unknown'}}]){
  const a=target(100,'1:1'),f=fixture([{...a,...change}]);let questions=0;
  await assert.rejects(restartRefusedHost({target:a,confirmChanged:async()=>{questions++;return true;}},f.deps),/could not be verified/);
  assert.equal(questions,1);assert.deepEqual(f.signals,[]);assert.deepEqual(f.waits,[]);
 }
});
test('identity failure at native signaling asks again and never retries or escalates the signal',async()=>{
 const a=target(100,'1:1');
 for(const outcome of ['mismatch','unknown','absent']){
  const f=fixture([a]);let signals=0,questions=0;
  f.deps.signal=()=>{signals++;return outcome;};
  await assert.rejects(restartRefusedHost({target:a,confirmChanged:async()=>{questions++;return true;}},f.deps),/No replacement was started/);
  assert.equal(signals,1);assert.equal(questions,1);assert.deepEqual(f.waits,[]);
 }
});
test('quit during a fresh question or inspection cannot reach signaling',async()=>{
 const a=target(100,'1:1'),b=target(200,'2:2','c');
 for(const phase of ['question','inspection']){
  const f=fixture([b]);if(phase==='inspection')f.deps.inspect=async()=>{f.cancel();return b;};
  await assert.rejects(restartRefusedHost({target:a,confirmChanged:async()=>{f.cancel();return true;}},f.deps),/Aya is closing/);
  assert.deepEqual(f.signals,[]);
 }
});
test('a host that does not exit is kept without an additional signal or replacement',async()=>{
 const a=target(100,'1:1'),f=fixture([a]);f.deps.waitGone=async()=>false;
 assert.equal(await restartRefusedHost({target:a,confirmChanged:async()=>{throw Error('same target needs no second question');}},f.deps),false);
 assert.equal(f.signals.length,1);
});
