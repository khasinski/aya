import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
fs.mkdirSync('test-results',{recursive:true});const home=fs.mkdtempSync(path.resolve('test-results/auth-restart-real-'));
process.env.AYA_HOME=home;process.env.HOME=home;process.env.SHELL='/bin/sh';
const {PtyHostClient}=require('../dist-electron/pty-host-client.js');
const {ownerProcessStartIdentity}=require('../dist-electron/pty-owner-client.js');
const {waitFor,fakeWebContents,ptyEventsFor}=await import('./helpers/pty-host.mjs');
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
test('missing-key refusal cannot restart without consent; exact consent sends one verified host SIGTERM and no replacement', {timeout:20000},async()=>{
 const first=new PtyHostClient(path.resolve('dist-electron/pty-host.js')),next=new PtyHostClient(path.resolve('dist-electron/pty-host.js')),sink=fakeWebContents();first.attachWebContents(sink);const logs=[];next.enableCrashRecovery({log:(...args)=>logs.push(args)},undefined,2);
 let nativeOwner,pane;
 try{
  await first.spawn({ptyId:'retained',command:'stty -echo; printf READY_RESTART; cat',cwd:home,cols:80,rows:24});
  await waitFor(()=>ptyEventsFor(sink,'retained').some(e=>e.type==='data'&&e.chunk.includes('READY_RESTART')));
  const original=await first.hostStatus();nativeOwner=original.owner.pid;pane=await first.getPid('retained');const start=ownerProcessStartIdentity(original.pid);
  fs.unlinkSync(path.join(home,'pty-host-auth/key'));let starts=0;next.startHost=()=>{starts++;throw Error('no replacement allowed');};
  await assert.rejects(next.restart(),error=>error.code==='PTY_HOST_AUTH_UNAVAILABLE');assert.equal(starts,0);assert.equal(alive(original.pid),true);assert.equal(alive(pane),true);
  const status=await next.hostStatus();assert.equal(status.pid,original.pid);assert.equal(status.authentication.inventoryKnown,true);
  assert.deepEqual(status.owner.inventory.map(p=>p.pid),[pane]);
  const supervisor=next.crashSupervisor;let questions=0;
  await assert.rejects(next.restart({target:{pid:status.pid,startTime:'0:0',owner:status.owner},confirmChanged:async fresh=>{questions++;assert.equal(fresh.pid,original.pid);assert.deepEqual(fresh.owner.inventory.map(p=>p.pid),[pane]);return false;}}),/restart cancelled/);
  assert.equal(questions,1);assert.equal(next.crashSupervisor,supervisor);assert.equal(supervisor.used,2);assert.equal(supervisor.suspended,false);assert.equal(next.hostAsked,false);
  assert.equal(alive(original.pid),true);assert.equal(alive(pane),true);assert.equal(logs.some(([event])=>event==='pty-host-auth-confirmed-sigterm'),false);
  const consent={target:{pid:status.pid,startTime:status.startTime,owner:status.owner},confirmChanged:async()=>{throw Error('same host does not need another question');}};
  let stopped;
  try{stopped=await next.restart(consent);}catch(error){
   if(process.platform==='linux'&&process.env.AYA_OWNER_EXPECT_PIDFD!=='1'&&logs.some(([,fields])=>fields.outcome==='unknown')){
    assert.equal(alive(pane),true);assert.equal(starts,0);return;
   }
   throw error;
  }
  assert.equal(stopped,true);assert.equal(starts,0);await waitFor(()=>!alive(pane)&&!alive(nativeOwner));
  assert.equal(alive(original.pid),false);assert.equal(fs.existsSync(path.join(home,'pty-host.sock')),false);
  assert.deepEqual(logs.filter(([event])=>event==='pty-host-auth-confirmed-sigterm'),[['pty-host-auth-confirmed-sigterm',{pid:original.pid,startIdentity:start,ownerInstance:original.owner.instanceId,outcome:'signalled'}]]);
 }finally{
  next.dispose();try{if(first.isConnected())await first.restart();}finally{first.dispose();fs.rmSync(home,{recursive:true,force:true});}
 }
});
