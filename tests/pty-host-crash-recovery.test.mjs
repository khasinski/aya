import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {isolateHome} from './helpers/isolate-home.mjs';
fs.mkdirSync('test-results',{recursive:true});const root=fs.mkdtempSync(path.resolve('test-results/host-crash-'));isolateHome(root);
const require=createRequire(import.meta.url);
const {PtyHostClient}=require('../dist-electron/pty-host-client.js');
const registry=require('../dist-electron/pty-owner-registry.js');
const {cleanupNativeOwner}=await import('./helpers/pty-host.mjs');
const script=path.resolve('dist-electron/pty-host.js');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(f,message='crash recovery timeout'){const end=Date.now()+12000;while(!await f()){if(Date.now()>end)throw Error(message);await sleep(5);}}
function request(){return {ptyId:'shell',agent:'custom',command:`exec /bin/sh -c 'stty -echo; echo READY; while [ ! -f "$HOME/release" ]; do sleep .01; done; echo UNREAD_DURING_GAP; touch "$HOME/produced"; while IFS= read -r line; do case "$line" in quit) exit 23 ;; *) printf "R:%s:%s\\n" "$$" "$line" ;; esac; done'`,cwd:process.env.HOME,cols:80,rows:24};}
async function setup(command){fs.mkdirSync(process.env.HOME,{recursive:true});fs.mkdirSync(process.env.AYA_HOME,{recursive:true});const events=[],logs=[],client=new PtyHostClient(script);client.enableCrashRecovery({log:(event,fields)=>logs.push({event,...fields})});client.attachWebContents({isDestroyed:()=>false,send:(_c,e)=>events.push(e)});await client.spawn({...request(),...(command?{command}:{})});await wait(async()=>(await client.getBuffer('shell')).includes('READY'));const status=await client.hostStatus(),pid=await client.getPid('shell');return{client,events,logs,status,pid};}
async function cleanup(...clients){for(const c of clients){c?.dispose();c?.dropSocket();}await cleanupNativeOwner(process.env.AYA_HOME);fs.rmSync(process.env.AYA_HOME,{recursive:true,force:true});fs.rmSync(process.env.HOME,{recursive:true,force:true});}
test('main restarts a SIGKILLed JS host and attaches the same owner/child with unread output and new I/O',{timeout:20000},async()=>{
 const {client,events,logs,status,pid}=await setup();
 let release;const gate=new Promise(resolve=>{release=resolve;}),attempt=client.recoverCrashedHost.bind(client);
 client.recoverCrashedHost=async signal=>{await gate;return signal.aborted?'blocked':attempt(signal);};
 try{
  await client.preparePlannedHandover(Date.now()+20000); // actual native readStop
  process.kill(status.pid,'SIGKILL');fs.writeFileSync(path.join(process.env.HOME,'release'),'go');
  await wait(()=>fs.existsSync(path.join(process.env.HOME,'produced')));
  assert.equal(registry.readOwnerRecord().jsPid,status.pid,'known unread reply exists before any successor starts');release();
  await wait(()=>logs.some(e=>e.state==='recovered'),JSON.stringify(logs));
  const after=await client.hostStatus();assert.notEqual(after.pid,status.pid);assert.equal(after.owner.pid,status.owner.pid);assert.equal(after.owner.instanceId,status.owner.instanceId);assert.equal(await client.getPid('shell'),pid);
  assert.throws(()=>process.kill(status.pid,0),/ESRCH/);
  const replay=events.filter(e=>e.type==='data'&&e.replay).map(e=>e.chunk).join('');assert.equal(replay.split('UNREAD_DURING_GAP').length-1,1);assert.ok(!replay.includes('READY'));
  const restored=events.find(e=>e.type==='recovered');assert.ok(restored);assert.match(restored.notice,/history were lost/);assert.equal(await client.acknowledgeHandoverDisplay('shell',restored.generation,restored.replayToken),true);
  assert.equal(await client.write('shell','AFTER\n'),true);await wait(async()=>(await client.getBuffer('shell')).includes(`R:${pid}:AFTER`));
  await client.resize('shell',101,39);assert.deepEqual(await client.getSize('shell').then(s=>[s.cols,s.rows]),[101,39]);
  assert.equal(fs.readFileSync(path.join(process.env.AYA_HOME,'pty-events.log'),'utf8').split('\n').filter(line=>{try{return JSON.parse(line).ev==='spawn';}catch{return false;}}).length,1);
  await client.write('shell','quit\n');await wait(()=>events.some(e=>e.type==='exit'&&e.exitCode===23));await client.shutdown();
 }finally{release();await cleanup(client);}
});
test('repeated real JS crashes exhaust one budget while preserving native inventory and processes',{timeout:25000},async()=>{
 const {client,events,logs,status,pid}=await setup();
 try{
  for(let attempt=0;attempt<3;attempt++){
   const before=await client.hostStatus();process.kill(before.pid,'SIGKILL');
   await wait(()=>logs.filter(e=>e.state==='recovered').length===attempt+1,JSON.stringify(logs));
   assert.equal((await client.hostStatus()).owner.pid,status.owner.pid);assert.equal(await client.getPid('shell'),pid);
  }
  process.kill((await client.hostStatus()).pid,'SIGKILL');await wait(()=>logs.some(e=>e.state==='exhausted'));
  assert.match(events.filter(e=>e.type==='disconnected').at(-1).reason,/recovery budget/);assert.doesNotThrow(()=>process.kill(pid,0));assert.doesNotThrow(()=>process.kill(status.owner.pid,0));assert.equal(registry.readOwnerRecord().panes[0].pid,pid);
 }finally{await cleanup(client);}
});
test('unknown-key reused host death does not probe owner, request a key or start a new JS/native owner',{timeout:15000},async()=>{
 const first=await setup(),second=new PtyHostClient(script),events=[];second.enableCrashRecovery();second.attachWebContents({isDestroyed:()=>false,send:(_c,e)=>events.push(e)});
 const read=registry.readOwnerRecord;let probes=0,starts=0;
 try{
  await second.spawn({...request(),attachIfReused:true});assert.equal(await second.getPid('shell'),first.pid);
  first.client.dispose();first.client.dropSocket();
  registry.readOwnerRecord=()=>{probes++;return read();};second.startHost=()=>{starts++;throw Error('unknown-key recovery must not start');};
  process.kill(first.status.pid,'SIGKILL');await wait(()=>events.some(e=>e.type==='disconnected'&&e.reason));
  assert.match(events.filter(e=>e.type==='disconnected').at(-1).reason,/Aya restarted since this terminal host started/);
  assert.equal(probes,0);assert.equal(starts,0);assert.equal(second.crashTask,null);assert.doesNotThrow(()=>process.kill(first.pid,0));assert.doesNotThrow(()=>process.kill(first.status.owner.pid,0));assert.equal(await second.getPid('shell'),undefined);
 }finally{registry.readOwnerRecord=read;await cleanup(first.client,second);}
});
test('app quit during backoff prevents any replacement and leaves the owner/child alive',{timeout:15000},async()=>{
 const {client,status,pid}=await setup();let starts=0,entered=false;
 const start=client.startHost.bind(client);client.startHost=(...args)=>{starts++;return start(...args);};
 client.recoveryHooks.log=(event,fields)=>{if(event==='pty-crash-recovery'&&fields.state==='recovering'){entered=true;client.dispose();}};
 try{process.kill(status.pid,'SIGKILL');await wait(()=>entered);await client.crashTask;assert.equal(starts,0);assert.doesNotThrow(()=>process.kill(pid,0));assert.doesNotThrow(()=>process.kill(status.owner.pid,0));}
 finally{await cleanup(client);}
});


test('a child exiting completely during the no-host gap keeps exit23 without a replacement spawn',{timeout:20000},async()=>{
 const {client,events,logs,status,pid}=await setup(`exec /bin/sh -c 'echo READY; while [ ! -f "$HOME/release" ]; do sleep .01; done; touch "$HOME/produced"; exit 23'`);
 let release;const gate=new Promise(resolve=>{release=resolve;}),attempt=client.recoverCrashedHost.bind(client);client.recoverCrashedHost=async signal=>{await gate;return signal.aborted?'blocked':attempt(signal);};
 try{
  process.kill(status.pid,'SIGKILL');fs.writeFileSync(path.join(process.env.HOME,'release'),'go');
  await wait(()=>{try{process.kill(pid,0);return false;}catch{return true;}});assert.equal(registry.readOwnerRecord().jsPid,status.pid);release();
  await wait(()=>logs.some(e=>e.state==='recovered'));
  assert.equal((await client.hostStatus()).owner.pid,status.owner.pid);assert.equal(await client.getPid('shell'),null);assert.deepEqual(events.filter(e=>e.type==='exit').map(e=>e.exitCode),[23]);
  const restored=events.find(e=>e.type==='recovered');assert.ok(restored);await client.acknowledgeHandoverDisplay('shell',restored.generation,restored.replayToken);
  await wait(async()=>(await client.hostStatus()).owner.inventory.length===0);await client.shutdown();
 }finally{release();await cleanup(client);}
});
test('failed successor starts consume bounded attempts without killing owner or duplicating the pane',{timeout:20000},async()=>{
 const {client,events,logs,status,pid}=await setup();const broken=path.resolve(`dist-electron/pty-host-broken-${process.pid}.js`);fs.writeFileSync(broken,'process.exit(1);\n');
 try{client.hostScript=broken;process.kill(status.pid,'SIGKILL');await wait(()=>logs.some(e=>e.state==='exhausted'));assert.equal(logs.filter(e=>e.event==='pty-crash-recovery-attempt-failed').length,3);assert.doesNotThrow(()=>process.kill(pid,0));assert.doesNotThrow(()=>process.kill(status.owner.pid,0));assert.equal(registry.readOwnerRecord().panes[0].pid,pid);assert.match(events.filter(e=>e.type==='disconnected').at(-1).reason,/recovery budget/);}
 finally{await cleanup(client);fs.rmSync(broken,{force:true});}
});
test('owner identity mismatch blocks recovery without starting any JS/native replacement',{timeout:15000},async()=>{
 const {client,logs,status,pid}=await setup();let starts=0;const start=client.startHost.bind(client);client.startHost=(...args)=>{starts++;return start(...args);};
 try{const record=registry.readOwnerRecord();registry.writeOwnerRecord({...record,binaryHash:'0'.repeat(64)});process.kill(status.pid,'SIGKILL');await wait(()=>logs.some(e=>e.state==='exhausted'));assert.equal(starts,0);assert.doesNotThrow(()=>process.kill(pid,0));assert.doesNotThrow(()=>process.kill(status.owner.pid,0));registry.writeOwnerRecord(record);}
 finally{await cleanup(client);}
});

test('write consumed before a lost ACK is uncertain and never resubmitted during real crash recovery',{timeout:20000},async()=>{
 fs.mkdirSync(process.env.HOME,{recursive:true});fs.mkdirSync(process.env.AYA_HOME,{recursive:true});
 const wrapper=path.resolve(`dist-electron/pty-host-input-crash-${process.pid}.js`);
 fs.writeFileSync(wrapper,`const core=require('./pty-core'),write=core.writePty;core.writePty=async(...args)=>{const answer=await write(...args);if(args[1]==='ONE_ENTER\\n')await new Promise(()=>{});return answer;};require('./pty-host');\n`);
 const client=new PtyHostClient(wrapper),events=[],logs=[];client.enableCrashRecovery({log:(event,fields)=>logs.push({event,...fields})});client.attachWebContents({isDestroyed:()=>false,send:(_c,e)=>events.push(e)});
 const req={...request(),command:`exec /bin/sh -c 'stty -echo; echo READY; while IFS= read -r line; do printf "%s\\n" "$line" >> "$HOME/input-lines"; echo RECEIVED; done'`};
 try{
  await client.spawn(req);await wait(async()=>(await client.getBuffer('shell')).includes('READY'));const before=await client.hostStatus(),pid=await client.getPid('shell');
  const write=client.write('shell','ONE_ENTER\n'),uncertain=assert.rejects(write,/Some bytes may have reached.*did not resend/);
  await wait(()=>fs.existsSync(path.join(process.env.HOME,'input-lines')));assert.equal(fs.readFileSync(path.join(process.env.HOME,'input-lines'),'utf8'),'ONE_ENTER\n');process.kill(before.pid,'SIGKILL');await uncertain;
  await wait(()=>logs.some(e=>e.state==='recovered'));assert.equal(await client.getPid('shell'),pid);assert.equal((await client.hostStatus()).owner.pid,before.owner.pid);
  const notice=events.find(e=>e.type==='recovered').notice;assert.match(notice,/Input acknowledgement was lost/);assert.match(notice,/did not resend/);
  assert.equal(fs.readFileSync(path.join(process.env.HOME,'input-lines'),'utf8'),'ONE_ENTER\n');await client.write('shell','EXPLICIT_SECOND\n');await wait(()=>fs.readFileSync(path.join(process.env.HOME,'input-lines'),'utf8').includes('EXPLICIT_SECOND'));
  assert.equal(fs.readFileSync(path.join(process.env.HOME,'input-lines'),'utf8'),'ONE_ENTER\nEXPLICIT_SECOND\n');await client.shutdown();
 }finally{await cleanup(client);fs.rmSync(wrapper,{force:true});}
});
test('owner identity follows a new spawn after the empty owner idles out, without an extra status probe',{timeout:20000},async()=>{
 const {client,logs,status}=await setup();
 try{
  fs.writeFileSync(path.join(process.env.HOME,'release'),'go');await wait(async()=>(await client.getBuffer('shell')).includes('UNREAD_DURING_GAP'));
  await client.write('shell','quit\n');await wait(()=>client.observedExits.get('shell')?.acknowledged===true);await wait(()=>registry.readOwnerRecord()===null);
  await client.spawn({...request(),ptyId:'next'});const current=registry.readOwnerRecord();assert.notEqual(current.pid,status.owner.pid);assert.equal(client.recoveryOwner.instanceId,current.instanceId);
  process.kill(status.pid,'SIGKILL');await wait(()=>logs.some(e=>e.state==='recovered'));assert.equal(await client.getPid('next'),current.panes[0].pid);assert.equal((await client.hostStatus()).owner.pid,current.pid);await client.shutdown();
 }finally{await cleanup(client);}
});
