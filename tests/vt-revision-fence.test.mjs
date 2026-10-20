import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {openVtPane,closeAllVtPanes,closeVtPane,writeVtPane,resizeVtPane,vtSnapshot,snapshotOf,panes,
 markComposerSeen,markComposerSeenChecked,vtSnapshotMatches,validVtSnapshotFence,beginVtRecovery,checkpointVtPane,restoreVtPane} from '../dist-electron/vt-mirror.js';
import {asVtSnapshot,isPtyHostRequest} from '../dist-electron/pty-host-protocol.js';
afterEach(()=>closeAllVtPanes());
const open=()=>openVtPane('p',80,24,()=>{},'claude');
const fence=s=>({generation:s.generation,revision:s.revision});

test('applied output invalidates the same-generation decision even without snapshot broadcasts',async()=>{
 open();writeVtPane('p','old composer');const old=await vtSnapshot('p');
 assert.ok(validVtSnapshotFence(fence(old)));assert.equal(vtSnapshotMatches('p',fence(old)),true);
 let broadcasts=0;panes.get('p').onSnapshot=()=>broadcasts++;
 writeVtPane('p','\r\nDo you want to proceed?');
 assert.equal(broadcasts,0);
 assert.equal(vtSnapshotMatches('p',fence(old)),false);
 assert.equal(markComposerSeenChecked('p',fence(old)),false);
 const next=await vtSnapshot('p');
 assert.equal(next.generation,old.generation);assert.notEqual(next.revision,old.revision);
 assert.equal(vtSnapshotMatches('p',fence(next)),true);assert.equal(next.composerSeen,false);
});

test('output-time metadata changes invalidate even cleaned OSC-only chunks',async()=>{
 open();const old=await vtSnapshot('p');writeVtPane('p','');
 assert.equal(vtSnapshotMatches('p',fence(old)),false);
 assert.notEqual((await vtSnapshot('p')).revision,old.revision);
});

test('received but deliberately unapplied output has no usable revision or composer ACK',async()=>{
 open();const old=await vtSnapshot('p'),pane=panes.get('p'),write=pane.terminal.write.bind(pane.terminal);
 let apply;
 pane.terminal.write=(data,callback)=>{apply=()=>write(data,callback);};
 writeVtPane('p','new approval');
 assert.equal(snapshotOf(pane).revision,undefined);assert.equal(vtSnapshotMatches('p',fence(old)),false);
 assert.equal(markComposerSeenChecked('p',fence(old)),false);assert.equal(pane.composerSeen,false);
 pane.terminal.write=write;apply();const current=await vtSnapshot('p');
 assert.ok(current.revision);assert.notEqual(current.revision,old.revision);
});

test('resize and composer mutations advance revision, checked ACK rejects the old snapshot',async()=>{
 open();const old=await vtSnapshot('p');resizeVtPane('p',100,30);
 assert.equal(vtSnapshotMatches('p',fence(old)),false);assert.equal(markComposerSeenChecked('p',fence(old)),false);
 const resized=await vtSnapshot('p');assert.equal(markComposerSeenChecked('p',fence(resized)),true);
 assert.equal(vtSnapshotMatches('p',fence(resized)),false);
 const seen=await vtSnapshot('p');assert.equal(seen.composerSeen,true);
 assert.equal(markComposerSeenChecked('p',fence(seen)),true);assert.equal((await vtSnapshot('p')).revision,seen.revision);
});

test('legacy generation-only composer ACK also invalidates asynchronous decisions',async()=>{
 open();const old=await vtSnapshot('p');markComposerSeen('p',old.generation);
 assert.equal(vtSnapshotMatches('p',fence(old)),false);assert.equal((await vtSnapshot('p')).composerSeen,true);
});

test('recovery state invalidates the old screen and cannot ACK an unknown composer',async()=>{
 open();const old=await vtSnapshot('p');beginVtRecovery('p');
 assert.equal(vtSnapshotMatches('p',fence(old)),false);
 const unknown=await vtSnapshot('p');assert.equal(unknown.recoveryUnknown,true);
 assert.equal(markComposerSeenChecked('p',fence(unknown)),false);
});

test('close/reopen rejects old generation and a planned restore rejects the old revision epoch',async()=>{
 open();writeVtPane('p','retained display');const old=await vtSnapshot('p'),checkpoint=await checkpointVtPane('p');
 closeVtPane('p');await restoreVtPane('p',checkpoint,()=>{});
 const restored=await vtSnapshot('p');assert.equal(restored.generation,old.generation);assert.notEqual(restored.revision,old.revision);
 assert.equal(vtSnapshotMatches('p',fence(old)),false);assert.equal(vtSnapshotMatches('p',fence(restored)),true);
 closeVtPane('p');open();assert.equal(markComposerSeenChecked('p',fence(restored)),false);
 assert.notEqual((await vtSnapshot('p')).generation,restored.generation);
});

test('fenced protocol verbs are distinct and closed; legacy snapshots remain readable without permission to fence',async()=>{
 open();const current=await vtSnapshot('p'),f=fence(current);
 for(const type of ['write-fenced','snapshot-check','composer-seen-checked']){
  const request={id:1,type,ptyId:'p',fence:f,...(type==='write-fenced'?{data:'yes\r',policyEpoch:'a'.repeat(32)+':1'}:{})};
  assert.equal(isPtyHostRequest(request),true);
  for(const invalid of [undefined,null,{}, {...f,extra:true},Object.assign(Object.create(f),{a:1,b:2}),{...f,revision:'bad'}, {...f,generation:''}])
   assert.equal(isPtyHostRequest({...request,fence:invalid}),false);
  assert.equal(isPtyHostRequest({...request,extra:true}),false);
 }
 assert.equal(isPtyHostRequest({id:2,type:'rule-policy-epoch',epoch:'b'.repeat(32)+':4'}),true);
 for(const epoch of [4,'bad','b'.repeat(32)+':01:2'])assert.equal(isPtyHostRequest({id:2,type:'rule-policy-epoch',epoch}),false);
 assert.equal(isPtyHostRequest({id:3,type:'write-fenced',ptyId:'p',data:'x',fence:f,policyEpoch:'b'.repeat(32)+':4'}),true);
 assert.equal(isPtyHostRequest({id:3,type:'write-fenced',ptyId:'p',data:'x',fence:f,policyEpoch:'stale'}),false);
 const {revision,...legacy}=current;assert.ok(revision);assert.equal(asVtSnapshot(legacy),legacy);
 assert.equal(validVtSnapshotFence(fence(legacy)),false);assert.equal(asVtSnapshot({...current,revision:'bad'}),null);
});
