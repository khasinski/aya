import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {isolateHome} from './helpers/isolate-home.mjs';
fs.mkdirSync('test-results',{recursive:true});
const root=fs.mkdtempSync(path.resolve('test-results/host-exit-boundary-'));isolateHome(root);
const require=createRequire(import.meta.url),{PtyHostClient}=require('../dist-electron/pty-host-client.js');
const {hostCreationProof}=require('../dist-electron/pty-host-start-guard.js');
const {ownerProcessStartIdentity}=require('../dist-electron/pty-owner-client.js');
const {cleanupNativeOwner}=await import('./helpers/pty-host.mjs');
const script=path.resolve(`dist-electron/pty-host-held-exit-${process.pid}.js`);
const marker=path.join(process.env.AYA_HOME,'exit-boundary'),release=path.join(process.env.AYA_HOME,'release-exit');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(f){const end=Date.now()+5000;while(!f()){if(Date.now()>end)throw Error('exit boundary timeout');await sleep(5);}}
test('a host at its final exit boundary remains recorded until kernel death, including the final fork guard',{timeout:15000},async()=>{
 // Hold only process.exit, after all product shutdown work and any attempted
 // registry deletion. No process identity/probe/creation logic is replaced.
 fs.writeFileSync(script,`const fs=require('node:fs'),path=require('node:path');const exit=process.exit;process.exit=code=>{fs.writeFileSync(path.join(process.env.AYA_HOME,'exit-boundary'),'ready');const timer=setInterval(()=>{if(fs.existsSync(path.join(process.env.AYA_HOME,'release-exit'))){clearInterval(timer);exit(code);}},5);};require('./pty-host.js');\n`);
 const old=new PtyHostClient(script),next=new PtyHostClient(path.resolve('dist-electron/pty-host.js'));let shutdown,pending;
 try{
  fs.mkdirSync(process.env.HOME,{recursive:true});fs.mkdirSync(process.env.AYA_HOME,{recursive:true,mode:0o700});
  await old.spawn({ptyId:'old',agent:'custom',command:'cat',cwd:process.env.HOME,cols:80,rows:24});
  const before=await old.hostStatus(),identity=ownerProcessStartIdentity(before.pid);assert.ok(identity);
  shutdown=old.shutdown();await wait(()=>fs.existsSync(marker));
  assert.equal(ownerProcessStartIdentity(before.pid),identity,'old host is still the same kernel process');
  const proof=hostCreationProof();next.hostAuthKey=Buffer.alloc(32,7);
  let forks=0;const childProcess=require('node:child_process'),spawn=childProcess.spawn;
  childProcess.spawn=()=>{forks++;throw Error('fork attempted while old host is alive');};
  try{assert.throws(()=>next.startHost(),{code:'PTY_HOST_START_BLOCKED'});assert.equal(forks,0);}
  finally{childProcess.spawn=spawn;}
  assert.equal(proof.state,'alive',JSON.stringify(proof));assert.ok(proof.hosts.some(host=>host.pid===before.pid&&host.state==='alive'));
  next.hostAuthKey=null;
  const start=next.startHost.bind(next),starts=[];
  next.startHost=(...args)=>{starts.push(ownerProcessStartIdentity(before.pid));return start(...args);};
  pending=next.spawn({ptyId:'next',agent:'custom',command:'cat',cwd:process.env.HOME,cols:80,rows:24});
  await sleep(100);assert.deepEqual(starts,[],'grace cannot turn disappearing records into proof of death');
  fs.writeFileSync(release,'go');await shutdown;await pending;
  assert.deepEqual(starts,[null]);assert.ok(await next.getPid('next'));await next.shutdown();
 }finally{
  if(fs.existsSync(process.env.AYA_HOME))fs.writeFileSync(release,'go');
  await shutdown?.catch(()=>{});await pending?.catch(()=>{});
  await next.shutdown().catch(()=>{});old.dispose();old.dropSocket();next.dispose();next.dropSocket();
  await cleanupNativeOwner(process.env.AYA_HOME);fs.rmSync(script,{force:true});fs.rmSync(root,{recursive:true,force:true});
 }
});
