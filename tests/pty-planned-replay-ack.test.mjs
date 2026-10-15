import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {isolateHome} from './helpers/isolate-home.mjs';
fs.mkdirSync('test-results',{recursive:true});const root=fs.mkdtempSync(path.resolve('test-results/planned-replay-ack-'));isolateHome(root);
const {PtyHostClient}=await import('../dist-electron/pty-host-client.js');
const {cleanupNativeOwner}=await import('./helpers/pty-host.mjs');
const wait=async f=>{const end=Date.now()+8000;while(!await f()){if(Date.now()>end)throw Error('applied replay timeout');await new Promise(r=>setTimeout(r,2));}};
for(const variant of ['reuse','replacement','replacement-twice'])test(`discarded first renderer retains suffix and exit until applied ACK after ${variant}`,{timeout:20000},async()=>{
 fs.mkdirSync(process.env.HOME,{recursive:true});fs.mkdirSync(process.env.AYA_HOME,{recursive:true});
 const hostScript=path.resolve('dist-electron/pty-host.js'),successor=path.resolve(`dist-electron/pty-host-replay-successor-${process.pid}.js`);
 if(variant.startsWith('replacement'))fs.copyFileSync(hostScript,successor);
 const old=new PtyHostClient(hostScript),middle=new PtyHostClient(variant.startsWith('replacement')?successor:hostScript);let next=middle,third;
 const thirdScript=path.resolve(`dist-electron/pty-host-replay-third-${process.pid}.js`);
 try{
  let output='';old.attachWebContents({isDestroyed:()=>false,send:(_c,e)=>{if(e.type==='data')output+=e.chunk;}});
  const req={ptyId:'pane',agent:'custom',command:'stty -echo; echo READY; while [ ! -f "$HOME/replay-release" ]; do sleep 0.01; done; printf LAST_SUFFIX; exit 23',cwd:process.env.HOME,cols:80,rows:24};
  req.command="exec /bin/sh -c '"+req.command.replace(/'/g,"'\"'\"'")+"'";
  await old.spawn(req);await wait(()=>output.includes('READY'));
  const ownerPid=(await old.hostStatus()).owner.pid;
  const state=await old.preparePlannedHandover(Date.now()+20000),origin=state.eligible[0];
  const ticket=await old.announcePlannedHandover(state,null,[],randomBytes(32).toString('hex'));old.hostAsked=true;
  await next.adoptPlannedHandover(ticket,next.expectedHostIdentity('version'),async()=>{});
  const mount=token=>({...req,attachIfReused:true,replayAfter:{generation:origin.generation,offset:origin.outputEnd,token}});
  const dropped={isDestroyed:()=>false,send:()=>{}};next.attachWebContents(dropped);
  await next.spawn(mount('discarded-first-view'));next.detachWebContents(dropped);
  fs.writeFileSync(path.join(process.env.HOME,'replay-release'),'go');await wait(async()=>await next.getPid('pane')===null);
  if(variant==='replacement-twice'){
   // This deliberately exceeds the native owner's200ms idle deadline. A held
   // unapplied exit must retain that owner for another planned lease transfer.
   await new Promise(r=>setTimeout(r,300));
   assert.equal((await next.hostStatus()).owner.pid,ownerPid);
   const secondState=await next.preparePlannedHandover(Date.now()+20000);
   assert.deepEqual(secondState.eligible.map(p=>p.id),['pane']);assert.deepEqual(secondState.ineligible,[]);
   const secondTicket=await next.announcePlannedHandover(secondState,null,[],randomBytes(32).toString('hex'));next.hostAsked=true;
   fs.writeFileSync(thirdScript,"require('./pty-owner-adapter').OwnerPty.attach=async()=>{throw Error('An ended record must not attach a native master');};\n"+fs.readFileSync(hostScript,'utf8'));third=new PtyHostClient(thirdScript);
   await third.adoptPlannedHandover(secondTicket,third.expectedHostIdentity('second-update'),async()=>{});next=third;
   assert.equal(await next.getPid('pane'),null,'an ended record has no native attach or replacement spawn');
  }
  const events=[];next.attachWebContents({isDestroyed:()=>false,send:(_c,e)=>events.push(e)});
  await next.spawn(mount('replacement-view'));
  const suffix=events.filter(e=>e.type==='data'&&e.replay);
  assert.equal(suffix.length,1);assert.equal(suffix[0].replayToken,'replacement-view');assert.equal(suffix[0].reset,false);
  assert.equal(suffix[0].chunk,'LAST_SUFFIX');assert.deepEqual(events.filter(e=>e.type==='exit').map(e=>e.exitCode),[23]);
  assert.equal(await next.acknowledgeHandoverDisplay('pane',origin.generation,'discarded-first-view'),false);
  assert.equal(await next.acknowledgeHandoverDisplay('pane',origin.generation,'replacement-view'),true);
  events.length=0;await next.spawn(mount('already-applied-view'));
  assert.ok(events.some(e=>e.type==='no-session'));assert.ok(!events.some(e=>e.type==='exit'||e.type==='data'));
  assert.equal((await next.hostStatus()).owner.pid,ownerPid);
  await next.shutdown();
 }finally{old.dispose();middle.dispose();third?.dispose();old.dropSocket();middle.dropSocket();third?.dropSocket();await cleanupNativeOwner(process.env.AYA_HOME);fs.rmSync(successor,{force:true});fs.rmSync(thirdScript,{force:true});fs.rmSync(root,{recursive:true,force:true});}
});
