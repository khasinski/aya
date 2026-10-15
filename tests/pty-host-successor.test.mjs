import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {isolateHome} from './helpers/isolate-home.mjs';
fs.mkdirSync('test-results',{recursive:true});const root=fs.mkdtempSync(path.resolve('test-results/host-successor-'));isolateHome(root);
fs.mkdirSync(process.env.HOME,{recursive:true});fs.mkdirSync(process.env.AYA_HOME,{recursive:true});
const {PtyHostClient,waitForExit}=await import('../dist-electron/pty-host-client.js');
const {cleanupNativeOwner}=await import('./helpers/pty-host.mjs');
const hostScript=path.resolve('dist-electron/pty-host.js');
const wait=async predicate=>{const end=Date.now()+8000;while(!await predicate()){if(Date.now()>end)throw Error('successor readiness timeout');await new Promise(r=>setTimeout(r,2));}};
for(const interrupted of [false,true])test(`a separate successor survives committed shutdown=${interrupted} and reads before renderer mount`,{timeout:25000},async()=>{
 fs.mkdirSync(process.env.HOME,{recursive:true});fs.mkdirSync(process.env.AYA_HOME,{recursive:true});
 let oldScript=hostScript;
 if(interrupted){
  oldScript=path.join(root,'interrupt-host.cjs');
  const runtime=path.resolve('dist-electron/pty-owner-runtime.js');
  const source=`const fs=require('fs'),Module=require('module'),path=require('path');const runtime=require(${JSON.stringify(runtime)});const original=runtime.OwnerRuntime.prototype.detachForHandover;runtime.OwnerRuntime.prototype.detachForHandover=function(commit){return original.call(this,()=>{commit();globalThis.testCommittedShutdown('injected quit at commit');});};const file=${JSON.stringify(hostScript)},m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));m._compile(fs.readFileSync(file,'utf8')+'\\nglobalThis.testCommittedShutdown=beginShutdown;',file);`;
  fs.writeFileSync(oldScript,source);
 }
 const old=new PtyHostClient(oldScript);let next,child;
 try{
  let original='';old.attachWebContents({isDestroyed:()=>false,send:(_channel,e)=>{if(e.type==='data')original+=e.chunk;}});
  const command="stty -echo; echo READY; while [ ! -f \"$HOME/release\" ]; do sleep .01; done; echo BETWEEN; while IFS= read -r line; do case \"$line\" in quit) exit 23 ;; *) printf 'R:%s\\n' \"$line\" ;; esac; done";
  const request={ptyId:'pane',agent:'custom',command,cwd:process.env.HOME,cols:80,rows:24};
  await old.spawn(request);await wait(()=>original.includes('READY'));
  const status=await old.hostStatus(),pid=await old.getPid('pane');
  const deadline=Date.now()+20000,state=await old.request({id:0,type:'handover-prepare',deadline});
  await old.request({id:0,type:'handover-publish',display:null});
  const nonce=randomBytes(32).toString('hex');await old.request({id:0,type:'handover-announce',nonce,deadline});
  const claim=await old.request({id:0,type:'handover-claim',nonce});
  old.hostAsked=true;
  const detach=old.request({id:0,type:'handover-detach',consented:[]});
  if(interrupted)await assert.rejects(detach);else await detach;
  assert.equal(await waitForExit(status.pid,8000),true,'old JS must be gone before successor starts');old.dispose();
  assert.doesNotThrow(()=>process.kill(pid,0));fs.writeFileSync(path.join(process.env.HOME,'release'),'go');
  child=spawn(process.execPath,[hostScript],{detached:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',AYA_PTY_OWNER_FD:'3',AYA_PTY_CHECKPOINT_FD:'4'},stdio:['ignore','ignore','pipe','pipe','pipe']});
  let stderr='';child.stderr.on('data',b=>{stderr+=b;});
  for(const fd of [3,4])child.stdio[fd].on('error',()=>{});
  child.stdio[3].end(Buffer.from(claim.credential,'base64'));
  child.stdio[4].end(JSON.stringify({format:1,core:claim.checkpoint.core}));
  await wait(()=>{if(child.exitCode!==null)throw Error(`successor failed: ${stderr}`);return fs.existsSync(path.join(process.env.AYA_HOME,'pty-host.sock'));});
  next=new PtyHostClient(hostScript);
  assert.equal((await next.hostStatus()).pid,child.pid);
  assert.equal(await next.getPid('pane'),pid);
  assert.equal((await next.hostStatus()).owner.pid,status.owner.pid);
  // No renderer exists yet. The new host must already have consumed the bytes.
  await wait(async()=>String(await next.request({id:0,type:'buffer',ptyId:'pane'})).includes('BETWEEN'));
  const events=[];next.attachWebContents({isDestroyed:()=>false,send:(_channel,e)=>events.push(e)});
  await next.spawn({...request,attachIfReused:true,replayAfter:{generation:state.eligible[0].generation,offset:state.eligible[0].outputEnd}});
  const replay=events.filter(e=>e.type==='data'&&e.replay);
  assert.equal(replay.length,1);assert.equal(replay[0].reset,false);
  assert.equal(replay[0].chunk.split('BETWEEN').length-1,1);assert.ok(!replay[0].chunk.includes('READY'));
  assert.equal(next.reusedHost,true);
  await next.write('pane','after\n');await wait(()=>events.some(e=>e.type==='data'&&e.chunk.includes('R:after')));
  await next.write('pane','quit\n');await wait(()=>events.some(e=>e.type==='exit'&&e.exitCode===23));
  assert.deepEqual(fs.readdirSync(path.join(process.env.AYA_HOME,'pty-handover-core')),[]);
  await next.shutdown();if(child.exitCode===null&&child.signalCode===null)await once(child,'exit');
 }finally{
  old.dispose();next?.dispose();
  if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit').catch(()=>{});}
  await cleanupNativeOwner(process.env.AYA_HOME);fs.rmSync(root,{recursive:true,force:true});
 }
});
