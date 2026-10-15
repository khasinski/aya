import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {isolateHome} from './helpers/isolate-home.mjs';
fs.mkdirSync('test-results',{recursive:true});
const root=fs.mkdtempSync(path.resolve('test-results/planned-natural-exit-'));isolateHome(root);
const {PtyHostClient}=await import('../dist-electron/pty-host-client.js');
const {cleanupNativeOwner}=await import('./helpers/pty-host.mjs');
const wait=async f=>{const end=Date.now()+8000;while(!await f()){if(Date.now()>end)throw Error('natural exit handover timeout');await new Promise(r=>setTimeout(r,2));}};
for(const scenario of ['reuse-published','replace-published','reuse-before-publish','replace-before-publish','reuse-committed'])test(`natural fallback exit cannot respawn across ${scenario}`,{timeout:20000},async()=>{
 fs.mkdirSync(process.env.HOME,{recursive:true});fs.mkdirSync(process.env.AYA_HOME,{recursive:true});
 const wrapper=path.resolve(`dist-electron/pty-host-ineligible-${process.pid}.js`);
 fs.writeFileSync(wrapper,`const {OwnerPty}=require('./pty-owner-adapter');const freeze=OwnerPty.prototype.freezeForHandover;OwnerPty.prototype.freezeForHandover=function(...args){if(this.pane.id==='bad')throw Error('ineligible fixture');return freeze.apply(this,args);};require('./pty-host');`);
 const successor=path.resolve(`dist-electron/pty-host-natural-successor-${process.pid}.js`);
 if(scenario.startsWith('replace'))fs.copyFileSync(path.resolve('dist-electron/pty-host.js'),successor);
 const old=new PtyHostClient(wrapper),next=new PtyHostClient(scenario.startsWith('replace')?successor:wrapper);
 const release=path.join(process.env.HOME,'natural-release');
 try{
  let output='';old.attachWebContents({isDestroyed:()=>false,send:(_c,e)=>{if(e.type==='data')output+=e.chunk;}});
  const req={ptyId:'bad',agent:'custom',command:'stty -echo; echo BAD_READY; while [ ! -f "$HOME/natural-release" ]; do sleep 0.01; done; printf LAST_SUFFIX; exit 23',cwd:process.env.HOME,cols:80,rows:24};
  await old.spawn(req);await wait(()=>output.includes('BAD_READY'));const childPid=await old.getPid('bad');
  await old.spawn({...req,ptyId:'good',command:'stty -echo; echo GOOD_READY; while IFS= read -r line; do echo "$line"; done'});await wait(()=>output.includes('GOOD_READY'));
  const goodPid=await old.getPid('good'),ownerPid=(await old.hostStatus()).owner.pid;
  const state=await old.preparePlannedHandover(Date.now()+20000);
  assert.deepEqual(state.ineligible.map(p=>p.id),['bad']);
  if(scenario.endsWith('before-publish')){fs.writeFileSync(release,'go');await wait(async()=>await old.getPid('bad')===null);}
  const ticket=await old.announcePlannedHandover(state,null,['bad'],randomBytes(32).toString('hex'));
  if(!scenario.endsWith('committed')){fs.writeFileSync(release,'go');await wait(async()=>await old.getPid('bad')===null);}
  old.hostAsked=true;
  const before=await old.hostStatus();
  await next.adoptPlannedHandover(ticket,scenario.startsWith('reuse')?before.identity:next.expectedHostIdentity('changed-version'),async()=>{});
  assert.equal((await next.hostStatus()).pid===before.pid,scenario.startsWith('reuse'));
  if(scenario.endsWith('committed')){fs.writeFileSync(release,'go');await wait(async()=>await next.getPid('bad')===null);}
  assert.equal(next.consentedBootSpawns.has('bad'),false,'a natural exit never grants permission before its first view');
  const events=[];next.attachWebContents({isDestroyed:()=>false,send:(_c,e)=>events.push(e)});
  await next.spawn({...req,attachIfReused:true});
  assert.deepEqual(events.filter(e=>e.type==='exit').map(e=>e.exitCode),[23],JSON.stringify({events,output}));
  assert.equal(next.consentedBootSpawns.has('bad'),false,'natural exit never grants a fresh spawn');
  assert.equal(await next.getPid('bad'),null);assert.equal(await next.getPid('good'),goodPid);
  const status=await next.hostStatus();assert.equal(status.owner.pid,ownerPid);assert.equal(status.owner.inventory.some(p=>p.id==='bad'),false);
  assert.throws(()=>process.kill(childPid,0),/ESRCH/);
  await next.shutdown();
 }finally{
  old.dispose();next.dispose();old.dropSocket();next.dropSocket();await cleanupNativeOwner(process.env.AYA_HOME);
  fs.rmSync(wrapper,{force:true});fs.rmSync(successor,{force:true});fs.rmSync(root,{recursive:true,force:true});
 }
});
