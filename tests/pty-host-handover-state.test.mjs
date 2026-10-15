import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
fs.mkdirSync('test-results',{recursive:true});
const home=fs.mkdtempSync(path.resolve('test-results/host-handover-state-'));process.env.AYA_HOME=home;
const require=createRequire(import.meta.url);
const core=require('../dist-electron/pty-core.js');
const {HostHandover}=require('../dist-electron/pty-host-handover.js');
const {shutdownOwnerRuntime,getOwnerRuntime}=require('../dist-electron/pty-owner-runtime.js');
const {ownerProcessStartIdentity}=require('../dist-electron/pty-owner-client.js');
const store=require('../dist-electron/pty-checkpoint-store.js');
const {writeCheckpoint}=store;
const {encodeCheckpointPayload}=require('../dist-electron/pty-checkpoint-payload.js');
const roots=[path.join(home,'core'),path.join(home,'display')],handover=new HostHandover(...roots);
const peer={pid:process.pid,startIdentity:ownerProcessStartIdentity(process.pid)};
const successor={pid:process.ppid,startIdentity:ownerProcessStartIdentity(process.ppid)};
const outputs=new Map();
const sink={isDestroyed:()=>false,sendPtyEvent:e=>{if(e.type==='data')outputs.set(e.ptyId,(outputs.get(e.ptyId)||'')+e.chunk);}};
const wait=async predicate=>{const end=Date.now()+6000;while(!predicate()){if(Date.now()>end)throw Error('host handover state timeout');await new Promise(r=>setTimeout(r,2));}};
async function spawn(id){
 const script="stty -echo; echo READY; while IFS= read -r line; do printf 'R:%s\\n' \"$line\"; done";
 await core.spawnPty({ptyId:id,command:script,cwd:home,cols:80,rows:24},sink,{prepare:async()=>({argv:['/bin/sh','-c',script],command:script,env:{PATH:'/usr/bin:/bin',HOME:home},launch:{command:script,cwd:home},ownSessionId:null,spawnedAt:Date.now()})});
 await wait(()=>(outputs.get(id)||'').includes('READY'));return core.getPtyPid(id);
}
test('host escrow lifecycle keeps peers, cancellation, reuse, expiry and raw caps nondestructive',{timeout:20000},async()=>{
 try{
  const pid=await spawn('one');
  let state=await handover.prepare(peer,Date.now()+120000);
  assert.equal(state.eligible.length,1);assert.deepEqual(state.ineligible,[]);
  assert.equal(fs.statSync(roots[0]).mode&0o777,0o700);
  assert.equal(fs.statSync(path.join(roots[0],state.core.nonce,'0.json')).mode&0o777,0o600);
  await assert.rejects(handover.abort(successor),/peer refused/);
  await assert.rejects(core.writePty('one','blocked\n'),/handover/);
  await handover.abort(peer);assert.deepEqual(fs.readdirSync(roots[0]),[]);
  await core.writePty('one','after-cancel\n');await wait(()=>(outputs.get('one')||'').includes('R:after-cancel'));
  assert.equal(core.getPtyPid('one'),pid);

  state=await handover.prepare(peer,Date.now()+120000);await handover.publish(peer,null);
  handover.adopt(successor);assert.throws(()=>handover.adopt(peer),/recipient refused/);
  handover.reuse(successor);assert.ok(fs.existsSync(path.join(roots[0],state.core.nonce)));
  await core.writePty('one','reused\n');await wait(()=>(outputs.get('one')||'').includes('R:reused'));
  await handover.acknowledgeReuse(successor);assert.deepEqual(fs.readdirSync(roots[0]),[]);assert.equal(core.getPtyPid('one'),pid);

  await handover.prepare(peer,Date.now()+2000);
  // This deliberate deadline wait is not a shell-readiness sleep. Only the
  // first successfully ungated operation is delivered, never uncertain retry.
  const deadline=Date.now()+6000;
  for(;;){try{await core.writePty('one','after-expiry\n');break;}catch(e){if(!/handover/.test(e.message))throw e;}if(Date.now()>deadline)throw Error('expiry did not resume old host');await new Promise(r=>setTimeout(r,5));}
  await wait(()=>(outputs.get('one')||'').includes('R:after-expiry'));
  await wait(()=>fs.readdirSync(roots[0]).length===0);
  assert.equal(core.getPtyPid('one'),pid);

  state=await handover.prepare(peer,Date.now()+120000);
  const first=await writeCheckpoint(roots[1],[{id:'one',generation:state.eligible[0].generation,data:encodeCheckpointPayload(Buffer.from('first'))}]);
  const second=await writeCheckpoint(roots[1],[{id:'one',generation:state.eligible[0].generation,data:encodeCheckpointPayload(Buffer.alloc(1000,120))}]);
  const read=store.readCheckpoint;let publicationEntered=false,releasePublication,reads=0;
  store.readCheckpoint=async function*(...args){reads++;publicationEntered=true;await new Promise(r=>{releasePublication=r;});yield*read(...args);};
  try{
   const publishing=handover.publish(peer,first);await wait(()=>publicationEntered);
   await assert.rejects(handover.publish(peer,second),/publication refused/);
   assert.throws(()=>handover.adopt(successor),/recipient refused/);
   assert.equal(reads,1,'duplicate must not begin reading another receipt');
   releasePublication();const published=await publishing;
   assert.deepEqual(published.display,first);assert.equal(published.displayRawBytes,5);
   handover.adopt(successor);await handover.abort(successor);
   assert.ok(fs.existsSync(path.join(roots[1],second.nonce)),'rejected receipt remains owned by caller');
  }finally{store.readCheckpoint=read;await store.discardCheckpoint(roots[1],second);}
  assert.deepEqual(fs.readdirSync(roots[1]),[]);

  for(const fault of ['writeFileSync','renameSync']){
   state=await handover.prepare(peer,Date.now()+120000);await handover.publish(peer,null);handover.adopt(successor);
   const owner=await getOwnerRuntime(),operation=fs[fault];let injected=false;
   fs[fault]=function(...args){if(String(args[0]).includes('record.json')){injected=true;throw Object.assign(Error('injected owner record ENOSPC'),{code:'ENOSPC'});}return operation.apply(this,args);};
   try{await assert.rejects(handover.detach(successor,[]),/ENOSPC/);}finally{fs[fault]=operation;}
   assert.equal(injected,true);assert.equal(owner.client.isConnected(),true);
   assert.ok(fs.existsSync(path.join(roots[0],state.core.nonce)));
   await handover.abort(successor);assert.deepEqual(fs.readdirSync(roots[0]),[]);
   await core.writePty('one',`after-${fault}\n`);await wait(()=>(outputs.get('one')||'').includes(`R:after-${fault}`));
  }

  for(const cancellation of ['abort','expiry']){
   state=await handover.prepare(peer,Date.now()+(cancellation==='expiry'?500:120000));await handover.publish(peer,null);handover.adopt(successor);
   const owner=await getOwnerRuntime(),list=owner.client.list.bind(owner.client);
   let entered=false,release;
   owner.client.list=async()=>{entered=true;await new Promise(r=>{release=r;});return list();};
   const detaching=handover.detach(successor,[]);const rejected=assert.rejects(detaching,/cancelled|no longer ready/);
   await wait(()=>entered);
   if(cancellation==='expiry'){
    await wait(()=>!core.ptyCoreHandoverInProgress() && fs.readdirSync(roots[0]).length===0);
   }else await handover.abort(successor);
   release();await rejected;owner.client.list=list;
   assert.equal(owner.client.isConnected(),true,'cancel must preserve control lease');
   assert.deepEqual(fs.readdirSync(roots[0]),[]);
   await core.writePty('one',`after-${cancellation}-during-list\n`);
   await wait(()=>(outputs.get('one')||'').includes(`R:after-${cancellation}-during-list`));
   assert.equal(core.getPtyPid('one'),pid);
  }

  await spawn('two');await spawn('three');
  state=await handover.prepare(peer,Date.now()+120000);
  const parts=state.eligible.map(p=>{const data=encodeCheckpointPayload(Buffer.from('opaque'));data.writeUInt32BE(64*1024*1024,8);return{id:p.id,generation:p.generation,data};});
  const receipt=await writeCheckpoint(roots[1],parts);
  await assert.rejects(handover.publish(peer,receipt),/aggregate decoded-byte limit/);
  await handover.abort(peer);assert.deepEqual(fs.readdirSync(roots[0]),[]);assert.deepEqual(fs.readdirSync(roots[1]),[]);
  assert.equal(core.getPtyPid('one'),pid);

  fs.writeFileSync(path.join(roots[0],'unknown'),'kept',{mode:0o600});
  await assert.rejects(handover.prepare(peer,Date.now()+120000),/earlier terminal checkpoint/);
  assert.equal(fs.readFileSync(path.join(roots[0],'unknown'),'utf8'),'kept');
  await core.writePty('one','still-live\n');await wait(()=>(outputs.get('one')||'').includes('R:still-live'));
 }finally{
  await handover.abort().catch(()=>{});
  for(const id of ['one','two','three'])if(typeof core.getPtyPid(id)==='number')await core.killPty(id);
  await shutdownOwnerRuntime();fs.rmSync(home,{recursive:true,force:true});
 }
});
