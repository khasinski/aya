import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {retireUnavailableOwner}=require('../dist-electron/pty-host-owner-retirement.js');
function inspection(pid=200,startIdentity='2:1',instance='a',state='same'){
 const record={pid,startIdentity,startTime:'owner',instanceId:instance.repeat(32),binaryHash:'b'.repeat(64),jsPid:100,jsStartTime:'reader',executable:'/owner',panes:[{id:'pane',pid:300}],uncertain:[]};
 const owner={pid,startIdentity,startTime:'owner',instanceId:record.instanceId,hash:record.binaryHash,incompatible:true,disconnected:['pane'],inventory:[{id:'pane',pid:300}]};
 return {record,state,readerGone:true,target:{pid:null,startTime:null,identity:null,ptyCount:1,ownerUnavailable:true,owner}};
}
function fixture(sequence){
 const calls=[];let n=0,stopped=false;
 return {calls,deps:{inspect:async()=>{const result=structuredClone(sequence[Math.min(n++,sequence.length-1)]);if(stopped)result.state='gone';return result;},
  prepare:()=>calls.push('prepare'),group:()=>700,signal:(...args)=>{calls.push(['signal',...args]);return 'signalled';},
  waitGone:async()=>{stopped=true;calls.push('wait');return true;},ownerGone:()=>calls.push('owner-gone'),
  survivors:r=>({needed:false,target:inspection(r.pid,r.startIdentity).target}),settle:async(_r,allow)=>calls.push(['settle',allow]),complete:(_r,ids)=>calls.push(['complete',ids]),cancelled:()=>false,log:(...args)=>calls.push(['log',...args])}};
}
test('exact owner consent sends one individual SIGTERM, waits, settles without child-signal authority then completes',async()=>{
 const a=inspection(),f=fixture([a]);assert.equal(await retireUnavailableOwner({target:a.target,confirmChanged:async()=>{throw Error('same target');}},f.deps),true);
 assert.deepEqual(f.calls,['prepare',['signal',200,'2:1',700],['log','pty-owner-confirmed-sigterm',{pid:200,startIdentity:'2:1',instanceId:'a'.repeat(32),outcome:'signalled'}],'wait','owner-gone',['settle',false],['complete',['pane']]]);
});
test('a changed record before owner signal asks with B and Cancel signals nothing',async()=>{
 const a=inspection(),b=inspection(201,'2:2','c'),f=fixture([a,b]);let questions=0;
 await assert.rejects(retireUnavailableOwner({target:a.target,confirmChanged:async fresh=>{questions++;assert.equal(fresh.owner.pid,201);return false;}},f.deps),/restart cancelled/);
 assert.equal(questions,1);assert.deepEqual(f.calls,['prepare']);
});
test('changed kernel identity, unknown identity and a living reader all refuse even blanket consent',async()=>{
 for(const change of [{state:'changed'},{state:'unknown'},{readerGone:false}]){
  const a=inspection(),f=fixture([{...a,...change}]);let questions=0;
  await assert.rejects(retireUnavailableOwner({target:a.target,confirmChanged:async()=>{questions++;return true;}},f.deps));assert.equal(questions,1);assert.deepEqual(f.calls,[]);
 }
});
test('fallible metadata preparation precedes SIGTERM and preserves the owner on ENOSPC',async()=>{
 const a=inspection(),f=fixture([a]);f.deps.prepare=()=>{throw Object.assign(Error('injected ENOSPC'),{code:'ENOSPC'});};
 await assert.rejects(retireUnavailableOwner({target:a.target,confirmChanged:async()=>true},f.deps),{code:'ENOSPC'});assert.deepEqual(f.calls,[]);
});
test('native signal refusal asks again and never escalates or completes',async()=>{
 const a=inspection(),f=fixture([a]);let questions=0;f.deps.signal=()=>{f.calls.push('unknown-signal');return 'unknown';};
 await assert.rejects(retireUnavailableOwner({target:a.target,confirmChanged:async()=>{questions++;return false;}},f.deps));assert.equal(questions,1);assert.ok(!f.calls.includes('wait'));assert.ok(!f.calls.some(c=>Array.isArray(c)&&c[0]==='complete'));
});
test('a survivor requires its own consent after owner exit; Cancel keeps it and the record',async()=>{
 const a=inspection(),f=fixture([a]);f.deps.survivors=()=>({needed:true,target:a.target});let questions=0;
 await assert.rejects(retireUnavailableOwner({target:a.target,confirmChanged:async()=>true,confirmSurvivors:async()=>{questions++;return false;}},f.deps),/survivor recovery was not confirmed/);
 assert.equal(questions,1);assert.ok(f.calls.includes('owner-gone'));assert.ok(!f.calls.some(c=>Array.isArray(c)&&(c[0]==='settle'||c[0]==='complete')));
});
test('separate survivor yes grants only B2 verified per-process settlement, and shutdown timeout never escalates',async()=>{
 const a=inspection(),f=fixture([a]);f.deps.survivors=()=>({needed:true,target:a.target});
 assert.equal(await retireUnavailableOwner({target:a.target,confirmChanged:async()=>true,confirmSurvivors:async()=>true},f.deps),true);assert.ok(f.calls.some(c=>Array.isArray(c)&&c[0]==='settle'&&c[1]===true));
 const stalled=fixture([a]);stalled.deps.waitGone=async()=>false;
 assert.equal(await retireUnavailableOwner({target:a.target,confirmChanged:async()=>true},stalled.deps),false);assert.equal(stalled.calls.filter(c=>Array.isArray(c)&&c[0]==='signal').length,1);assert.ok(!stalled.calls.includes('owner-gone'));
});
