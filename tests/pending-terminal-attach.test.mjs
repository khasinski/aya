import test from 'node:test';
import assert from 'node:assert/strict';
import {registerPendingTerminalAttach, cancelPendingTerminalAttach} from '../dist-test/pending-terminal-attach.js';
import {createSpawnGate} from '../dist-electron/spawn-gate.js';

test('close during display lookup cancels the view before any spawn can reach main',async()=>{
 let release, cancelled=false, sent=0;
 const display=new Promise(resolve=>{release=resolve;});
 const remove=registerPendingTerminalAttach('lookup',()=>{cancelled=true;});
 const attach=(async()=>{await display;if(!cancelled){remove();sent++;}})();
 const closed=cancelPendingTerminalAttach('lookup');release();await attach;closed();
 assert.equal(sent,0);remove();
});

test('close releases and cancels a hidden view, and old cleanup preserves a successor hook',async()=>{
 let release,cancelled=false,sent=0;
 const hidden=new Promise(resolve=>{release=resolve;});
 const old=registerPendingTerminalAttach('hidden',()=>{cancelled=true;release();});
 const attach=(async()=>{await hidden;if(!cancelled)sent++;})();
 const closed=cancelPendingTerminalAttach('hidden');await attach;assert.equal(sent,0);old();closed();
 let successorCancelled=false;
 const next=registerPendingTerminalAttach('hidden',()=>{successorCancelled=true;});
 old();const nextClosed=cancelPendingTerminalAttach('hidden');assert.equal(successorCancelled,true);next();nextClosed();
});

test('after sending, cancellation belongs to the existing main spawn flight',async()=>{
 let cancelCalls=0,release,sent=0;
 const remove=registerPendingTerminalAttach('sent',()=>{cancelCalls++;});
 const gate=createSpawnGate(), preparation=new Promise(resolve=>{release=resolve;});
 remove();const spawn=gate.spawn('sent',()=>preparation,async()=>{sent++;});
 const closed=cancelPendingTerminalAttach('sent');assert.equal(gate.cancel('sent'),true);
 release();await spawn;assert.equal(cancelCalls,0);assert.equal(sent,0);closed();
});

test('a replacement view remains cancelled until all outstanding close attempts settle',()=>{
 const first=cancelPendingTerminalAttach('remount'),second=cancelPendingTerminalAttach('remount');
 let cancelled=0;
 const old=registerPendingTerminalAttach('remount',()=>cancelled++);assert.equal(cancelled,1);old();first();
 const current=registerPendingTerminalAttach('remount',()=>cancelled++);assert.equal(cancelled,2);old();current();second();
 const fresh=registerPendingTerminalAttach('remount',()=>cancelled++);assert.equal(cancelled,2);fresh();
});
