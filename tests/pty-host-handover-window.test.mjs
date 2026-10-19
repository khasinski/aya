import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import path from 'node:path';
import {readdir} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {isolateHome} from './helpers/isolate-home.mjs';
mkdirSync('test-results',{recursive:true});
const root=mkdtempSync(path.resolve('test-results/host-handover-'));isolateHome(root);
mkdirSync(process.env.HOME,{recursive:true});mkdirSync(process.env.AYA_HOME,{recursive:true});
const {PtyHostClient}=await import('../dist-electron/pty-host-client.js');
const {cleanupNativeOwner}=await import('./helpers/pty-host.mjs');
const {readCheckpoint}=await import('../dist-electron/pty-checkpoint-store.js');
const {decodeCheckpointPayload}=await import('../dist-electron/pty-checkpoint-payload.js');
after(async()=>{await cleanupNativeOwner(process.env.AYA_HOME);rmSync(root,{recursive:true,force:true});});
const hostScript=path.resolve('dist-electron/pty-host.js');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function host(fn){const client=new PtyHostClient(hostScript);try{await client.request({id:0,type:'version'});await fn(client);}finally{await client.shutdown().catch(()=>{});client.dispose();}}
test('real host refuses unannounced transfer; announced transfer returns its inherited key exactly once without logging it',()=>host(async(client)=>{
 const nonce=randomBytes(32).toString('hex');
 await assert.rejects(client.request({id:0,type:'handover-claim',nonce}),/refused/);
 const announcement=await client.request({id:0,type:'handover-announce',nonce,deadline:Date.now()+10000});
 assert.ok(announcement.hostPid>1);assert.match(announcement.hostStartIdentity,/^\d+:\d+$/);
 const result=await client.request({id:0,type:'handover-claim',nonce});
 assert.equal(digest(Buffer.from(result.credential,'base64')),digest(client.ownerSecret));
 await assert.rejects(client.request({id:0,type:'handover-claim',nonce}),/refused/);
 const log=path.join(process.env.AYA_HOME,'pty-events.log');assert.equal(readFileSync(log,'utf8').includes(result.credential),false);
}));
test('real host closes an announced window on a wrong nonce',()=>host(async(client)=>{
 const nonce=randomBytes(32).toString('hex');await client.request({id:0,type:'handover-announce',nonce,deadline:Date.now()+10000});
 await assert.rejects(client.request({id:0,type:'handover-claim',nonce:'b'.repeat(64)}),/refused/);
 await assert.rejects(client.request({id:0,type:'handover-claim',nonce}),/refused/);
}));
test('real host refuses a transfer after its deadline',()=>host(async(client)=>{
 const nonce=randomBytes(32).toString('hex');await client.request({id:0,type:'handover-announce',nonce,deadline:Date.now()+100});
 await new Promise(resolve=>setTimeout(resolve,150));await assert.rejects(client.request({id:0,type:'handover-claim',nonce}),/refused/);
}));
async function until(predicate){const end=Date.now()+6000;while(!predicate()){if(Date.now()>end)throw Error('handover socket test readiness timeout');await new Promise(r=>setTimeout(r,2));}}
test('real host preparation fences output, gates producers, publishes opaque state and resumes on Cancel',()=>host(async(client)=>{
 let output='';client.attachWebContents({isDestroyed:()=>false,send:(_channel,e)=>{if(e.type==='data'&&e.ptyId==='fence')output+=e.chunk;}});
 await client.spawn({ptyId:'fence',agent:'custom',command:"stty -echo; echo READY; while IFS= read -r line; do printf 'R:%s\\n' \"$line\"; done",cwd:process.env.HOME,cols:80,rows:24});
 await until(()=>output.includes('READY'));const pid=await client.getPid('fence');
 const deadline=Date.now()+10000,state=await client.request({id:0,type:'handover-prepare',deadline});
 assert.deepEqual(state.ineligible,[]);assert.equal(state.eligible[0].id,'fence');
 let checkpoint;for await(const part of readCheckpoint(path.join(process.env.AYA_HOME,'pty-handover-core'),state.core))checkpoint=JSON.parse(decodeCheckpointPayload(part.data));
 assert.equal(output,checkpoint.output.chunks.join(''),'the response must not overtake buffered output to main');
 await assert.rejects(client.write('fence','not-delivered\n'),/handover/);
 await assert.rejects(client.kill('fence'),/handover/);
 await assert.rejects(client.request({id:0,type:'composer-seen',ptyId:'fence',generation:state.eligible[0].generation}),/metadata is paused/);
 await assert.rejects(client.request({id:0,type:'handover-announce',nonce:randomBytes(32).toString('hex'),deadline}),/not published/);
 await client.request({id:0,type:'handover-publish',display:null});
 const nonce=randomBytes(32).toString('hex');await client.request({id:0,type:'handover-announce',nonce,deadline});
 const claimed=await client.request({id:0,type:'handover-claim',nonce});assert.deepEqual(claimed.checkpoint.core,state.core);
 await client.request({id:0,type:'handover-cancel'});
 assert.equal(await client.getPid('fence'),pid);await client.write('fence','after-cancel\n');await until(()=>output.includes('R:after-cancel'));
 assert.equal(output.includes('not-delivered'),false);
 assert.deepEqual(await readdir(path.join(process.env.AYA_HOME,'pty-handover-core')),[]);
}));
test('a wrong nonce on a prepared real host cleans escrow and immediately resumes its original pane',()=>host(async(client)=>{
 let output='';client.attachWebContents({isDestroyed:()=>false,send:(_channel,e)=>{if(e.type==='data'&&e.ptyId==='wrong')output+=e.chunk;}});
 await client.spawn({ptyId:'wrong',agent:'custom',command:"stty -echo; echo READY; while IFS= read -r line; do printf 'R:%s\\n' \"$line\"; done",cwd:process.env.HOME,cols:80,rows:24});
 await until(()=>output.includes('READY'));const pid=await client.getPid('wrong'),deadline=Date.now()+10000,nonce=randomBytes(32).toString('hex');
 await client.request({id:0,type:'handover-prepare',deadline});await client.request({id:0,type:'handover-publish',display:null});await client.request({id:0,type:'handover-announce',nonce,deadline});
 await assert.rejects(client.request({id:0,type:'handover-claim',nonce:'b'.repeat(64)}),/refused/);
 await client.write('wrong','after-refusal\n');await until(()=>output.includes('R:after-refusal'));
 assert.equal(await client.getPid('wrong'),pid);await assert.rejects(client.request({id:0,type:'handover-claim',nonce}),/refused/);
}));


test('unchanged-host reuse transfers no owner key and can announce the next update after ACK',()=>host(async(client)=>{
 let output='';client.attachWebContents({isDestroyed:()=>false,send:(_channel,e)=>{if(e.type==='data')output+=e.chunk;}});
 await client.spawn({ptyId:'reuse',agent:'custom',command:"stty -echo; echo READY; while IFS= read -r line; do printf 'R:%s\\n' \"$line\"; done",cwd:process.env.HOME,cols:80,rows:24});
 await until(()=>output.includes('READY'));const pid=await client.getPid('reuse');
 for(let attempt=0;attempt<2;attempt++){
  const deadline=Date.now()+10000,nonce=randomBytes(32).toString('hex');
  await client.request({id:0,type:'handover-prepare',deadline});await client.request({id:0,type:'handover-publish',display:null});await client.request({id:0,type:'handover-announce',nonce,deadline});
  const result=await client.request({id:0,type:'handover-claim',nonce,reuse:true});
  assert.equal(Object.hasOwn(result,'credential'),false);assert.ok(result.checkpoint);
  await client.request({id:0,type:'handover-reuse'});
  await client.request({id:0,type:'handover-ack-reuse'});
  await client.write('reuse',`attempt-${attempt}\n`);await until(()=>output.includes(`R:attempt-${attempt}`));
  assert.equal(await client.getPid('reuse'),pid);
 }
}));
