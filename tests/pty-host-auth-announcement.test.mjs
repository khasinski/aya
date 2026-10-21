import {test} from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {OrdinaryAuthAnnouncement} from '../dist-electron/pty-host-auth-announcement.js';
import {HostAuthTransfer,AUTH_QUIT_PUBLICATION_MS} from '../dist-electron/pty-host-auth-transfer.js';
const issuer={pid:100,startIdentity:'1:2'},recipient={pid:200,startIdentity:'2:3'};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function setup(overrides={}){
 let mono=0;const transfer=new HostAuthTransfer(Buffer.alloc(32,7),{wall:Date.now,monotonic:()=>mono}),calls=[],published=[],removed=[],logs=[];
 const deps={home:'/unused-private-test-home',connected:()=>true,peer:()=>issuer,now:()=>mono,
  control:async req=>{calls.push(req);if(req.type==='auth-transfer-reserve')return {...transfer.reserve(issuer,req.purpose,req.nonce,req.deadline),hostPid:issuer.pid,hostStartIdentity:issuer.startIdentity};if(req.type==='auth-transfer-activate'){transfer.activate(issuer,req.attempt);return true;}if(req.type==='auth-transfer-cancel')return transfer.cancel(issuer,req.attempt);throw Error('unexpected control');},
  publish:async(_file,ticket,budget)=>{published.push({ticket,budget});},cancelFile:async(...args)=>{removed.push(args);},log:(event,fields)=>logs.push({event,...fields}),...overrides};
 return{transfer,calls,published,removed,logs,deps,setMono:value=>mono=value,announcement:new OrdinaryAuthAnnouncement(deps)};
}
test('ordinary quit reserves before publication then activates once under one parent2s budget',async()=>{
 const f=setup();const first=f.announcement.prepare();assert.equal(first,f.announcement.prepare());assert.equal(await first,true);
 assert.equal(AUTH_QUIT_PUBLICATION_MS,2000);assert.deepEqual(f.calls.map(r=>r.type),['auth-transfer-reserve','auth-transfer-activate']);assert.equal(f.published.length,1);assert.equal(f.published[0].budget.deadline,2000);
 const ticket=f.published[0].ticket;assert.equal(ticket.format,2);assert.equal(ticket.hostPid,issuer.pid);assert.equal(ticket.hostStartIdentity,issuer.startIdentity);assert.equal(ticket.purpose,'ordinary-quit');assert.equal(ticket.deadline,null);assert.equal(ticket.replacedBuild,false);assert.deepEqual(f.transfer.redeem(ticket.attempt,ticket.nonce,recipient),Buffer.alloc(32,7));
 await f.announcement.abort();assert.equal(f.transfer.phase,'claimed','old-main cleanup cannot undo committed recipient');assert.ok(!JSON.stringify(f.logs).includes(ticket.nonce));assert.equal(f.removed[0][2],ticket.nonce);
});
test('a hand-installed replacement is recorded on its ordinary-quit ticket',async()=>{
 const f=setup({replacedBuild:true});assert.equal(await f.announcement.prepare(),true);assert.equal(f.published[0].ticket.purpose,'ordinary-quit');assert.equal(f.published[0].ticket.deadline,null);assert.equal(f.published[0].ticket.replacedBuild,true);
});
test('missing existing connection does no peer/RPC/file work and cannot start anything',async()=>{
 const f=setup({connected:()=>false,peer:()=>{throw Error('must not inspect peer');}});assert.equal(await f.announcement.prepare(),false);assert.deepEqual(f.calls,[]);assert.deepEqual(f.published,[]);assert.deepEqual(f.removed,[]);
});
test('losing ordinary reservation cannot publish or cancel an existing planned winner',async()=>{
 const f=setup();const winner=f.transfer.reserve(issuer,'planned-update','a'.repeat(64),Date.now()+120000);
 assert.equal(await f.announcement.prepare(),false);await f.announcement.abort();assert.deepEqual(f.calls.map(r=>r.type),['auth-transfer-reserve']);assert.deepEqual(f.published,[]);assert.equal(f.transfer.reservedBy(issuer,winner.attempt).purpose,'planned-update');
});
test('late valid reservation reply and late peer observation cannot start publication or activation',async()=>{
 const f=setup({budgetMs:100});const control=f.deps.control;f.deps.control=async req=>{const result=await control(req);f.setMono(100);return result;};assert.equal(await f.announcement.prepare(),false);assert.equal(f.published.length,0);assert.deepEqual(f.calls.map(r=>r.type),['auth-transfer-reserve']);
 const g=setup({budgetMs:100});g.deps.peer=()=>{g.setMono(100);return issuer;};assert.equal(await g.announcement.prepare(),false);assert.deepEqual(g.calls,[]);
});
test('late publication cannot activate; late activation completion is revoked without rearm',async()=>{
 for(const step of ['publication','activation']){
  const f=setup({budgetMs:100});const publish=f.deps.publish,control=f.deps.control;
  if(step==='publication')f.deps.publish=async(...args)=>{await publish(...args);f.setMono(100);};
  else f.deps.control=async req=>{const result=await control(req);if(req.type==='auth-transfer-activate')f.setMono(100);return result;};
  assert.equal(await f.announcement.prepare(),false);await f.announcement.abort();assert.equal(f.transfer.phase,'sealed');assert.equal(f.calls.filter(r=>r.type==='auth-transfer-activate').length,step==='publication'?0:1);assert.equal(f.calls.filter(r=>r.type==='auth-transfer-cancel').length,1);assert.equal(f.removed.length,1);
 }
});
test('stalled publication returns by parent budget and abort prevents its late continuation',async()=>{
 let release,entered=false;const blocked=new Promise(resolve=>release=resolve),f=setup({now:()=>performance.now(),budgetMs:40,publish:async()=>{entered=true;await blocked;}});
 const began=performance.now();assert.equal(await f.announcement.prepare(),false);assert.equal(entered,true);assert.ok(performance.now()-began<500);release();await f.announcement.abort();await pause(0);assert.equal(f.calls.filter(r=>r.type==='auth-transfer-activate').length,0);assert.equal(f.transfer.phase,'sealed');
});
test('cancel wins while publication is pending without waiting for its I/O',async()=>{
 let release,entered=false;const blocked=new Promise(resolve=>release=resolve),f=setup({publish:async()=>{entered=true;await blocked;}});
 const prepared=f.announcement.prepare();while(!entered)await pause(1);const began=performance.now();await f.announcement.abort();assert.ok(performance.now()-began<500);assert.equal(await prepared,false);release();await pause(0);assert.equal(f.transfer.phase,'sealed');assert.equal(f.calls.filter(r=>r.type==='auth-transfer-activate').length,0);
});
