import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {isolateHome} from './helpers/isolate-home.mjs';
fs.mkdirSync('test-results',{recursive:true});const root=fs.mkdtempSync(path.resolve('test-results/planned-auth-producer-'));isolateHome(root);
const require=createRequire(import.meta.url),{PtyHostClient}=require('../dist-electron/pty-host-client.js'),{isPtyHostRequest}=require('../dist-electron/pty-host-protocol.js');
const {cleanupNativeOwner}=await import('./helpers/pty-host.mjs');
after(()=>fs.rmSync(root,{recursive:true,force:true}));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(f){const end=Date.now()+5000;while(!await f()){if(Date.now()>end)throw Error('planned producer readiness timeout');await sleep(5);}}
test('production planned operations bind publish and cleanup to the reserved core attempt', {timeout:15000},async()=>{
 fs.mkdirSync(process.env.HOME,{recursive:true});fs.mkdirSync(process.env.AYA_HOME,{recursive:true});
 const c=new PtyHostClient(path.resolve('dist-electron/pty-host.js'));let ticket;
 try{
  await c.spawn({ptyId:'kept',agent:'custom',command:"exec /bin/sh -c 'stty -echo; printf PRODUCER_READY; cat'",cwd:process.env.HOME,cols:80,rows:24});
  await wait(async()=>(await c.getBuffer('kept')).includes('PRODUCER_READY'));const before=await c.hostStatus(),pid=await c.getPid('kept');
  ticket=await c.reservePlannedHandover(Date.now()+120000);assert.equal(ticket.purpose,'planned-update');assert.equal(ticket.hostPid,before.pid);
  const state=await c.preparePlannedHandover(ticket.deadline,ticket.attempt);
  await assert.rejects(c.cancelPlannedHandover('0'.repeat(64)),/attempt changed/);
  await assert.rejects(c.request({id:0,type:'handover-publish',display:null,consented:[],transferAttempt:'0'.repeat(64)}),/attempt changed/);
  await assert.rejects(c.write('kept','MUST_NOT_SEND\n'),/paused|handover|update/);
  const announcement=await c.announcePlannedHandover(state,null,[],ticket.nonce,ticket.attempt);assert.equal(announcement.hostPid,before.pid);await c.activatePlannedHandover(ticket.attempt);
  assert.equal(await c.cancelPlannedAuth(ticket.attempt),'cancelled');await c.cancelPlannedHandover(ticket.attempt);
  // Authoritative abort/expiry may already have cleaned the core before the
  // issuer receives a late renderer result and retries its scoped cleanup.
  await c.cancelPlannedHandover(ticket.attempt);
  await c.write('kept','AFTER_MATCHING_ABORT\n');await wait(async()=>(await c.getBuffer('kept')).includes('AFTER_MATCHING_ABORT'));
  assert.ok(!(await c.getBuffer('kept')).includes('MUST_NOT_SEND'));assert.equal(await c.getPid('kept'),pid);assert.equal((await c.hostStatus()).owner.pid,before.owner.pid);
  await c.shutdown();
 }finally{await c.shutdown().catch(()=>{});c.dispose();c.dropSocket();await cleanupNativeOwner(process.env.AYA_HOME);}
});
test('tagged producer verbs have closed envelopes and cannot smuggle a different attempt',()=>{
 const transferAttempt='a'.repeat(64),nonce='b'.repeat(64),requests=[{id:1,type:'handover-prepare',deadline:Date.now()+1000,transferAttempt},{id:1,type:'handover-publish',display:null,consented:[],transferAttempt},{id:1,type:'handover-cancel',transferAttempt},{id:1,type:'handover-announce',nonce,deadline:Date.now()+1000,transferAttempt}];
 for(const r of requests){assert.equal(isPtyHostRequest(r),true);assert.equal(isPtyHostRequest({...r,extra:true}),false);assert.equal(isPtyHostRequest({...r,transferAttempt:''}),false);assert.equal(isPtyHostRequest({...r,id:NaN}),false);}
});
