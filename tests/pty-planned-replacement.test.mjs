import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
import {isolateHome} from './helpers/isolate-home.mjs';
fs.mkdirSync('test-results',{recursive:true});const root=fs.mkdtempSync(path.resolve('test-results/planned-replacement-'));isolateHome(root);
const require=createRequire(import.meta.url),{PtyHostClient}=require('../dist-electron/pty-host-client.js');
const registry=require('../dist-electron/pty-owner-registry.js');
const {cleanupNativeOwner}=await import('./helpers/pty-host.mjs');
const hostScript=path.resolve('dist-electron/pty-host.js');
const wait=async f=>{const end=Date.now()+8000;while(!await f()){if(Date.now()>end)throw Error('planned replacement timeout');await new Promise(r=>setTimeout(r,2));}};
for(const scenario of ['reuse','replace','inspect-refusal','unknown-hash','owner-change','socket-timeout'])test(`main client planned handover ${scenario}`,{timeout:25000},async()=>{
 fs.mkdirSync(process.env.HOME,{recursive:true});fs.mkdirSync(process.env.AYA_HOME,{recursive:true});
 const newScript=['replace','socket-timeout'].includes(scenario)?path.resolve(`dist-electron/pty-host-successor-${process.pid}.js`):hostScript;
 if(newScript!==hostScript)fs.copyFileSync(hostScript,newScript);
 const old=new PtyHostClient(hostScript),next=new PtyHostClient(newScript);const binaryHash=registry.ownerBinaryHash;
 try{
  let output='';old.attachWebContents({isDestroyed:()=>false,send:(_channel,e)=>{if(e.type==='data')output+=e.chunk;}});
  const req={ptyId:'pane',agent:'custom',command:"stty -echo; echo READY; while IFS= read -r line; do case \"$line\" in quit) exit 23 ;; *) printf 'R:%s\\n' \"$line\" ;; esac; done",cwd:process.env.HOME,cols:80,rows:24};
  await old.spawn(req);await wait(()=>output.includes('READY'));
  const status=await old.hostStatus(),pid=await old.getPid('pane'),deadline=Date.now()+20000;
  const state=await old.preparePlannedHandover(deadline),ticket=await old.announcePlannedHandover(state,null,[],randomBytes(32).toString('hex'));
  const expected=next.expectedHostIdentity('different app version');
  if(scenario==='unknown-hash')expected.scriptHash='unknown';
  if(scenario==='owner-change')registry.ownerBinaryHash=()=> '0'.repeat(64);
  old.hostAsked=true;
  const open=next.openStartedHostSocket;let successor;
  if(scenario==='socket-timeout'){const start=next.startHost.bind(next);next.startHost=(...args)=>{successor=start(...args);return successor;};next.openStartedHostSocket=async()=>{throw Error('injected successor socket timeout');};}
  const adopting=next.adoptPlannedHandover(ticket,expected,async current=>{
   assert.equal(current.eligible[0].id,'pane');assert.doesNotThrow(()=>process.kill(pid,0));
   if(scenario==='inspect-refusal')throw Error('injected display validation refusal');
  });
  if(scenario==='socket-timeout'){
   await assert.rejects(adopting,/injected successor socket timeout/);next.openStartedHostSocket=open;
   assert.ok(successor);assert.ok(successor.exitCode!==null||successor.signalCode!==null,'socketless successor must have exited');
   assert.doesNotThrow(()=>process.kill(pid,0));assert.doesNotThrow(()=>process.kill(status.owner.pid,0));
   const events=[];next.attachWebContents({isDestroyed:()=>false,send:(_channel,e)=>events.push(e)});
   await next.spawn({...req,ptyId:'ended-before-update',attachIfReused:true});
   assert.ok(events.some(e=>e.type==='no-session'&&e.ptyId==='ended-before-update'));
   assert.equal((await next.hostStatus()).owner.inventory.length,1);assert.equal(next.reusedHost,true);
   await next.shutdown();return;
  }
  if(['inspect-refusal','unknown-hash','owner-change'].includes(scenario)){
   await assert.rejects(adopting,/refusal|identity could not|native PTY owner/);
   registry.ownerBinaryHash=binaryHash;
   assert.equal((await old.hostStatus()).pid,status.pid);
   await old.write('pane','after-refusal\n');await wait(()=>output.includes('R:after-refusal'));
   assert.deepEqual(fs.readdirSync(path.join(process.env.AYA_HOME,'pty-handover-core')),[]);
   await old.shutdown();return;
  }
  await adopting;const after=await next.hostStatus();
  assert.equal(after.owner.pid,status.owner.pid);assert.equal(await next.getPid('pane'),pid);assert.equal(next.reusedHost,true);
  assert.equal(after.pid===status.pid,scenario==='reuse');
  if(scenario==='replace'){assert.equal(next.sessionWatches.has('pane'),true);assert.equal(next.live.has('pane'),true);assert.equal(next.ownerBacked,true);}
  const events=[];next.attachWebContents({isDestroyed:()=>false,send:(_channel,e)=>events.push(e)});
  await next.spawn({...req,attachIfReused:true,replayAfter:{generation:state.eligible[0].generation,offset:state.eligible[0].outputEnd}});
  await next.acknowledgeHandoverDisplay('pane',state.eligible[0].generation);
  const fence=events.find(e=>e.type==='data'&&e.replay);assert.ok(fence);assert.equal(fence.reset,false);assert.equal(fence.chunk,'');
  await next.spawn({...req,ptyId:'ended-before-update',attachIfReused:true});
  assert.ok(events.some(e=>e.type==='no-session'&&e.ptyId==='ended-before-update'));
  assert.equal((await next.hostStatus()).owner.inventory.length,1);
  await next.write('pane','after\n');await wait(()=>events.some(e=>e.type==='data'&&e.chunk.includes('R:after')));
  await next.write('pane','quit\n');await wait(()=>events.some(e=>e.type==='exit'&&e.exitCode===23));
  await next.shutdown();
 }finally{
  registry.ownerBinaryHash=binaryHash;
  old.dispose();next.dispose();old.dropSocket();next.dropSocket();
  await cleanupNativeOwner(process.env.AYA_HOME);fs.rmSync(root,{recursive:true,force:true});if(newScript!==hostScript)fs.rmSync(newScript,{force:true});
 }
});
