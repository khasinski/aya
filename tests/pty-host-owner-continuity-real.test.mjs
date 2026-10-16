import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
fs.mkdirSync('test-results',{recursive:true});const home=fs.mkdtempSync(path.resolve('test-results/owner-continuity-real-'));
process.env.AYA_HOME=home;process.env.HOME=home;process.env.SHELL='/bin/sh';
const {PtyHostClient}=require('../dist-electron/pty-host-client.js');
const {ownerProcessStartIdentity}=require('../dist-electron/pty-owner-client.js');
const {waitFor,fakeWebContents,ptyEventsFor,cleanupNativeOwner}=await import('./helpers/pty-host.mjs');
test('a new main authenticates to a surviving host and recovers its same owner/child after a later JS crash', {timeout:25000},async()=>{
 const oldMain=spawn(process.execPath,['tests/helpers/pty-owner-continuity-main.cjs'],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore','pipe','pipe']});
 let output='',errors='';oldMain.stdout.on('data',chunk=>output+=chunk);oldMain.stderr.on('data',chunk=>errors+=chunk);
 const next=new PtyHostClient(path.resolve('dist-electron/pty-host.js')),sink=fakeWebContents(),logs=[];next.attachWebContents(sink);next.enableCrashRecovery({log:(event,fields)=>logs.push({event,...fields})});
 const exited=once(oldMain,'exit');
 try{
  const [code]=await exited;assert.equal(code,0,errors);const before=JSON.parse(output.trim());
  assert.throws(()=>process.kill(oldMain.pid,0),/ESRCH/);
  for(const variant of ['partial','duplicate','generation','host']){
   const rejected=new PtyHostClient(path.resolve('dist-electron/pty-host.js')),send=rejected.sendRequest.bind(rejected),originalSecret=rejected.ownerSecret.toString('hex');let starts=0;
   rejected.startHost=()=>{starts++;throw Error('no owner or host replacement allowed');};
   rejected.sendRequest=async(socket,request)=>{
    const reply=await send(socket,request);if(request.type!=='owner-continuity')return reply;
    if(variant==='partial')reply.bootstrap.panes.pop();
    if(variant==='duplicate')reply.bootstrap.panes[1]=structuredClone(reply.bootstrap.panes[0]);
    if(variant==='generation')reply.bootstrap.panes[0].generation++;
    if(variant==='host')reply.host.startIdentity='0:0';
    return reply;
   };
   try{
    const status=await rejected.hostStatus();assert.equal(status.pid,before.status.pid);assert.equal(rejected.ownsOwnerKey,false,variant);assert.equal(rejected.ownerSecret.toString('hex'),originalSecret,variant);
    await rejected.spawn({...before.request,attachIfReused:true});assert.equal(await rejected.getPid('continued'),before.pid);assert.equal(await rejected.getPid('hidden'),before.hiddenPid);assert.equal(starts,0);
   }finally{rejected.dispose();}
  }
  const discovered=await next.hostStatus();assert.equal(discovered.pid,before.status.pid);
  assert.equal(next.ownsOwnerKey,true,JSON.stringify(logs));
  await next.spawn({...before.request,attachIfReused:true});assert.equal(await next.getPid('continued'),before.pid);
  const attached=await next.hostStatus();assert.equal(attached.pid,before.status.pid);assert.equal(attached.owner.pid,before.status.owner.pid);assert.equal(attached.owner.instanceId,before.status.owner.instanceId);
  assert.equal(attached.owner.startIdentity,ownerProcessStartIdentity(attached.owner.pid));
  assert.equal(JSON.parse(fs.readFileSync(path.join(home,'pty-owner/record.json'),'utf8')).startIdentity,attached.owner.startIdentity);
  const secret=next.ownerSecret.toString('hex');assert.ok(!fs.readFileSync(path.join(home,'pty-owner/record.json'),'utf8').includes(secret));
  assert.equal(fs.existsSync(path.join(home,'pty-handover.json')),false);
  process.kill(attached.pid,'SIGKILL');await waitFor(()=>logs.some(e=>e.event==='pty-crash-recovery'&&e.state==='recovered'));
  const recovered=await next.hostStatus();assert.notEqual(recovered.pid,attached.pid);assert.equal(recovered.owner.pid,attached.owner.pid);assert.equal(recovered.owner.instanceId,attached.owner.instanceId);assert.equal(await next.getPid('continued'),before.pid);assert.equal(await next.getPid('hidden'),before.hiddenPid);
  const restoration=ptyEventsFor(sink,'continued').find(e=>e.type==='recovered');assert.ok(restoration);assert.equal(await next.acknowledgeHandoverDisplay('continued',restoration.generation,restoration.replayToken),true);
  await next.write('continued','AFTER_RELAUNCH_CRASH\n');await waitFor(async()=>(await next.getBuffer('continued')).includes(`R:${before.pid}:AFTER_RELAUNCH_CRASH`));
  await next.resize('continued',101,39);assert.deepEqual(await next.getSize('continued').then(s=>[s.cols,s.rows]),[101,39]);
  assert.ok(!JSON.stringify(logs).includes(secret));assert.ok(!fs.readFileSync(path.join(home,'pty-host.stderr.log'),'utf8').includes(secret));
  const events=fs.readFileSync(path.join(home,'pty-events.log'),'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));assert.equal(events.filter(e=>e.ev==='spawn').length,2);assert.ok(!events.some(e=>/handover-announce|handover-claim/.test(e.ev)));
  await next.write('continued','quit\n');await waitFor(()=>ptyEventsFor(sink,'continued').some(e=>e.type==='exit'&&e.exitCode===23));
  await next.kill('hidden');await waitFor(async()=>(await next.hostStatus()).owner.inventory.length===0);
  await next.shutdown();await waitFor(()=>{try{process.kill(recovered.pid,0);return false;}catch{return true;}});
 }finally{
  if(oldMain.exitCode===null&&oldMain.signalCode===null){oldMain.kill('SIGKILL');await exited;}
  try{await next.restart().catch(()=>{});}finally{next.dispose();await cleanupNativeOwner(home);fs.rmSync(home,{recursive:true,force:true});}
 }
});
