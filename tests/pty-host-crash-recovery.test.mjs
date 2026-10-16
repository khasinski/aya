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
async function wait(f,message='crash recovery timeout'){const end=Date.now()+12000;while(!await f()){if(Date.now()>end)throw Error(typeof message==='function'?message():message);await sleep(5);}}
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
   await wait(()=>logs.filter(e=>e.state==='recovered').length===attempt+1,()=>JSON.stringify({logs,live:[...client.live],lost:[...client.lostOwned],blocked:client.crashBlocked,context:client.crashContext,supervisor:client.crashSupervisor,stderr:fs.existsSync(path.join(process.env.AYA_HOME,'pty-host.stderr.log'))?fs.readFileSync(path.join(process.env.AYA_HOME,'pty-host.stderr.log'),'utf8'):''}));
   assert.equal((await client.hostStatus()).owner.pid,status.owner.pid);assert.equal(await client.getPid('shell'),pid);
  }
  process.kill((await client.hostStatus()).pid,'SIGKILL');await wait(()=>logs.some(e=>e.state==='exhausted'));
  assert.match(events.filter(e=>e.type==='disconnected').at(-1).reason,/recovery budget/);assert.doesNotThrow(()=>process.kill(pid,0));assert.doesNotThrow(()=>process.kill(status.owner.pid,0));assert.equal(registry.readOwnerRecord().panes[0].pid,pid);
 }finally{await cleanup(client);}
});
test('unavailable authenticated continuity leaves reused host death disconnected without post-death key requests or new owners',{timeout:15000},async()=>{
 const first=await setup(),second=new PtyHostClient(script),events=[];second.enableCrashRecovery();second.attachWebContents({isDestroyed:()=>false,send:(_c,e)=>events.push(e)});
 const read=registry.readOwnerRecord,send=second.sendRequest.bind(second);let probes=0,starts=0,keyRequests=0;
 second.sendRequest=(socket,req)=>{if(req.type==='owner-continuity'){keyRequests++;return Promise.reject(Object.assign(Error('unsupported continuity'),{code:'PTY_HOST_REMOTE_ERROR'}));}return send(socket,req);};
 try{
  await second.spawn({...request(),attachIfReused:true});assert.equal(await second.getPid('shell'),first.pid);assert.equal(second.ownsOwnerKey,false);assert.equal(keyRequests,1);
  first.client.dispose();first.client.dropSocket();
  registry.readOwnerRecord=()=>{probes++;return read();};second.startHost=()=>{starts++;throw Error('unknown-key recovery must not start');};
  process.kill(first.status.pid,'SIGKILL');await wait(()=>events.some(e=>e.type==='disconnected'&&e.reason));
  assert.match(events.filter(e=>e.type==='disconnected').at(-1).reason,/could not verify recovery data/);assert.equal(keyRequests,1);
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

test('quit during the prior-child exit wait starts no successor',{timeout:15000},async()=>{
 const {client,status}=await setup();let starts=0,waited=false;
 const attempt=client.recoverCrashedHost.bind(client),start=client.startHost.bind(client);
 client.startHost=(...args)=>{starts++;return start(...args);};
 client.recoverCrashedHost=async signal=>{
  const prior={exitCode:null,signalCode:null,once:(_name,callback)=>{waited=true;client.dispose();prior.exitCode=0;callback();}};
  client.pendingPlannedHost=prior;return attempt(signal);
 };
 try{process.kill(status.pid,'SIGKILL');await wait(()=>waited);await wait(()=>client.crashTask===null);assert.equal(starts,0);assert.equal(registry.readOwnerRecord().pid,status.owner.pid);}
 finally{await cleanup(client);}
});

test('recovery refreshes the PID/start pair and socket loss of the live successor cannot replace it',{timeout:20000},async()=>{
 const {client,status,logs,pid}=await setup();const {ownerProcessStartIdentity}=require('../dist-electron/pty-owner-client.js');
 try{
  process.kill(status.pid,'SIGKILL');await wait(()=>logs.some(e=>e.state==='recovered'));
  const successor=await client.hostStatus();assert.equal(client.lastHostPid,successor.pid);assert.equal(client.lastHostStart,ownerProcessStartIdentity(successor.pid));
  let starts=0;const start=client.startHost.bind(client);client.startHost=(...args)=>{starts++;return start(...args);};
  client.socket.destroy();await wait(()=>logs.some(e=>e.state==='exhausted'));
  assert.equal(starts,0);assert.doesNotThrow(()=>process.kill(successor.pid,0));assert.doesNotThrow(()=>process.kill(pid,0));assert.equal(registry.readOwnerRecord().jsPid,successor.pid);
 }finally{await cleanup(client);}
});

for(const variant of ['partial','empty','duplicate'])test(`two-pane ${variant} recovery manifest never becomes a successful recovery`,{timeout:20000},async()=>{
 const {client,status,logs}=await setup();const peer={...request(),ptyId:'peer'};
 const wrapper=path.resolve(`dist-electron/pty-host-manifest-${variant}-${process.pid}.js`);
 const replacement=variant==='partial'?'panes.slice(0,1)':variant==='empty'?'[]':'[panes[0],panes[0]]';
 fs.writeFileSync(wrapper,`const core=require('./pty-core'),states=core.ptyRecoveryStates;core.ptyRecoveryStates=()=>{const panes=states();return ${replacement};};require('./pty-host');\n`);
 try{
  await client.spawn(peer);const before=registry.readOwnerRecord().panes.map(p=>p.pid);client.hostScript=wrapper;
  process.kill(status.pid,'SIGKILL');await wait(()=>logs.some(e=>e.state==='exhausted'));
  assert.ok(!logs.some(e=>e.state==='recovered'));assert.equal(client.crashBlocked,true);assert.ok(logs.some(e=>/manifest/.test(e.reason??'')));
  for(const pid of before)assert.doesNotThrow(()=>process.kill(pid,0));assert.deepEqual([...client.lostOwned].sort(),['peer','shell']);
 }finally{await cleanup(client);fs.rmSync(wrapper,{force:true});}
});

test('a native exit already observed by main is explicitly reconciled and may be omitted from recovery',{timeout:20000},async()=>{
 const {client,status,logs,events}=await setup();const observe=client.observeExit.bind(client);
 try{
  await client.spawn({...request(),ptyId:'peer'});
  client.observeExit=(id,...args)=>{if(id!=='shell')return observe(id,...args);};
  fs.writeFileSync(path.join(process.env.HOME,'release'),'go');await wait(async()=>(await client.getBuffer('shell')).includes('UNREAD_DURING_GAP'));
  await client.write('shell','quit\n');await wait(()=>events.some(e=>e.type==='exit'&&e.ptyId==='shell'&&e.exitCode===23));
  assert.ok(registry.readOwnerRecord().panes.some(p=>p.id==='shell'&&p.exited));process.kill(status.pid,'SIGKILL');
  await wait(()=>logs.some(e=>e.state==='recovered'));assert.deepEqual(events.filter(e=>e.type==='recovered').map(e=>e.ptyId),['peer']);
  assert.ok(!registry.readOwnerRecord().panes.some(p=>p.id==='shell'));assert.equal(await client.getPid('peer')>1,true);await client.shutdown();
 }finally{await cleanup(client);}
});

test('native-owner death with a JS master duplicate never authorizes a new owner or silent child spawn',{timeout:15000},async()=>{
 const {client,status,logs,pid}=await setup(`exec /bin/sh -c 'trap "" HUP; echo READY; while :; do sleep .1; done'`);
 let starts=0;const start=client.startHost.bind(client);client.startHost=(...args)=>{starts++;return start(...args);};
 try{
  process.kill(status.owner.pid,'SIGKILL');await wait(()=>{try{process.kill(status.owner.pid,0);return false;}catch{return true;}});
  assert.doesNotThrow(()=>process.kill(pid,0),'JS reader still holds a master duplicate');
  process.kill(status.pid,'SIGKILL');await wait(()=>logs.some(e=>e.state==='exhausted'));
  assert.equal(starts,0);assert.equal(registry.readOwnerRecord().pid,status.owner.pid);assert.ok(registry.readOwnerRecord().panes.some(p=>p.pid===pid));
  assert.equal(await client.getPid('shell'),undefined);assert.equal(client.crashBlocked,true);
 }finally{try{process.kill(-pid,'SIGKILL');}catch{}await cleanup(client);}
});

test('an early pane applied ACK succeeds while later recovery replay fences are still pending',{timeout:15000},async()=>{
 const {client,status,logs}=await setup();const replies=[];let release;
 try{
  await client.spawn({...request(),ptyId:'peer'});const send=client.sendRequest.bind(client),gate=new Promise(r=>{release=r;});
  client.sendRequest=async(socket,req)=>{if(req.type==='spawn'&&req.req.ptyId==='peer'&&req.req.replayAfter){await gate;}return send(socket,req);};
  // ACK must follow the shell's replay fence, as an actual view does.
  client.sinks.clear();client.attachWebContents({isDestroyed:()=>false,send:(_c,e)=>{if(e.type==='data'&&e.replayToken){if(e.ptyId==='shell')replies.push(client.acknowledgeHandoverDisplay('shell',client.testGeneration,e.replayToken));}if(e.type==='recovered')client.testGeneration=e.generation;}});
  process.kill(status.pid,'SIGKILL');await wait(()=>replies.length===1);assert.equal(await replies[0],true);assert.equal(client.crashBlocked,true,'later pane still gated');release();await wait(()=>logs.some(e=>e.state==='recovered'));await client.shutdown();
 }finally{release?.();await cleanup(client);}
});

for(const outcome of ['success','failure','quit'])test(`manual Try again makes one supervised attempt: ${outcome}`,{timeout:15000},async()=>{
 const {client,status,logs,pid}=await setup();const real=client.recoverCrashedHost.bind(client);let calls=0;
 client.recoverCrashedHost=async signal=>{calls++;if(calls===1||outcome==='failure'){client.recoveryFailure='Controlled manual refusal';return 'blocked';}return real(signal);};
 try{
  process.kill(status.pid,'SIGKILL');await wait(()=>logs.some(e=>e.state==='exhausted'));assert.equal(client.recoveryRetryable,true);
  const retry=client.retryCrashRecovery();if(outcome==='quit')client.dispose();const result=await retry;
  assert.equal(result,outcome==='success');assert.equal(calls,outcome==='quit'?1:2);
  if(outcome==='success'){assert.equal(await client.getPid('shell'),pid);assert.equal((await client.hostStatus()).owner.pid,status.owner.pid);assert.equal(client.recoveryRetryable,false);await client.shutdown();}
  else{assert.doesNotThrow(()=>process.kill(pid,0));assert.equal(registry.readOwnerRecord().pid,status.owner.pid);if(outcome==='failure'){assert.equal(client.recoveryRetryable,true);assert.match(client.recoveryReason,/Controlled manual refusal/);}}
 }finally{await cleanup(client);}
});

test('manual success restores the normal three-attempt policy only after120s stability',{timeout:15000},async()=>{
 const {client,status,logs}=await setup();const attempt=client.recoverCrashedHost.bind(client);let calls=0;
 client.recoverCrashedHost=async signal=>{calls++;if(calls===1)return 'blocked';return attempt(signal);};
 try{
  process.kill(status.pid,'SIGKILL');await wait(()=>logs.some(e=>e.state==='exhausted'));assert.equal(await client.retryCrashRecovery(),true);
  assert.deepEqual(client.crashSupervisor.policy.delays,[100,500,1500]);assert.equal(client.crashSupervisor.used,3);
  const successor=await client.hostStatus(),before=calls;client.crashSupervisor.now=()=>Date.now()+121000;client.recoverCrashedHost=async()=>{calls++;return 'retry';};
  process.kill(successor.pid,'SIGKILL');await wait(()=>logs.filter(e=>e.state==='exhausted').length===2);assert.equal(calls-before,3);
 }finally{await cleanup(client);}
});

test('timeout after a partial replay preserves the retry notice after the successor socket closes',{timeout:15000},async()=>{
 const {client,status,logs,events}=await setup();const timer=globalThis.setTimeout;let expire;
 try{
  globalThis.setTimeout=(callback,ms,...args)=>{if(ms===5678)expire=callback;return timer(callback,ms,...args);};
  client.crashSupervisor.dispose();client.crashSupervisor=null;
  client.enableCrashRecovery({log:(event,fields)=>logs.push({event,...fields}),restored:()=>{assert.equal(typeof expire,'function');setImmediate(()=>expire());}},{delays:[1],attemptTimeoutMs:5678,stableMs:120000});
  const send=client.sendRequest.bind(client);
  client.sendRequest=async(socket,req)=>{if(req.type==='spawn'&&req.req.replayAfter)await sleep(700);return send(socket,req);};
  process.kill(status.pid,'SIGKILL');await wait(()=>logs.some(e=>e.state==='exhausted'));await wait(()=>!client.crashAttempt&&!client.socket);
  assert.ok(events.some(e=>e.type==='recovered'),'timeout occurs after the validated inventory was published');
  const notice=events.filter(e=>e.type==='disconnected').at(-1);assert.match(notice.reason,/recovery budget/);assert.equal(notice.retryable,true);assert.equal(client.recoveryRetryable,true);assert.equal(client.crashBlocked,true);
 }finally{globalThis.setTimeout=timer;await cleanup(client);}
});

test('exit after recovery version capture is delivered again after the recovered-view fence',{timeout:15000},async()=>{
 const {client,status,logs,events,pid}=await setup(`exec /bin/sh -c 'echo READY; while [ ! -f "$HOME/release" ]; do sleep .01; done; exit 23'`);
 const response=client.onResponse.bind(client),observe=client.observeExit.bind(client),send=client.sendRequest.bind(client);let released=false,replayRequest;
 client.sendRequest=(socket,req)=>{if(req.type==='spawn'&&req.req.replayAfter)replayRequest=req.req.replayAfter;return send(socket,req);};
 client.observeExit=()=>{}; // main received it, native ACK has not yet succeeded
 client.onResponse=message=>{
  if(!released&&message.ok&&Array.isArray(message.result?.recovery)){
   released=true;fs.writeFileSync(path.join(process.env.HOME,'release'),'go');
   // Core intentionally holds the exit until the first attach. Establish kernel
   // exit after version capture and before releasing that captured live manifest.
   void wait(()=>{try{process.kill(pid,0);return false;}catch{return true;}}).then(()=>response(message));return;
  }
  response(message);
 };
 try{
  process.kill(status.pid,'SIGKILL');await wait(()=>logs.some(e=>e.state==='recovered'));
  const lifecycle=events.filter(e=>e.ptyId==='shell'&&(e.type==='exit'||e.type==='recovered'||(e.type==='data'&&e.replayToken)));
  const recovered=lifecycle.find(e=>e.type==='recovered');
  assert.ok(recovered);
  assert.deepEqual(lifecycle.map(e=>e.type),['recovered','data','exit'],'matching fence must precede exit');
  assert.equal(lifecycle[1].replayToken,recovered.replayToken);
  assert.equal(replayRequest.generation,recovered.generation);assert.equal(replayRequest.token,lifecycle[1].replayToken);
  assert.ok(lifecycle.some(e=>e.type==='recovered'),JSON.stringify({logs,lifecycle}));
  assert.equal(logs.filter(e=>e.event==='pty-crash-recovery-attempt-failed').length,0);
  assert.deepEqual(lifecycle.filter(e=>e.type==='exit').map(e=>e.exitCode),[23]);
  assert.equal(lifecycle.at(-1).type,'exit','recovered cannot erase an exit already observed while the version reply was pending');assert.equal(lifecycle.at(-1).exitCode,23);assert.equal(await client.getPid('shell'),null);
  client.observeExit=observe;observe('shell',client.observedExits.get('shell'));await wait(()=>client.observedExits.get('shell').acknowledged);await client.shutdown();
 }finally{await cleanup(client);}
});

 test('unavailable exit ACK stays pending until recovery retires the exact native receipt',{timeout:20000},async()=>{
 const {client,status,logs,events}=await setup();const send=client.sendRequest.bind(client);let refused=false,acks=0;
 client.sendRequest=async(socket,req)=>{if(req.type==='exit-observed'){acks++;if(!refused){refused=true;return 'unavailable';}}return send(socket,req);};
 try{
  await client.spawn({...request(),ptyId:'peer'});fs.writeFileSync(path.join(process.env.HOME,'release'),'go');
  await client.write('shell','quit\n');await wait(()=>logs.some(e=>e.event==='pty-exit-ack-unavailable'));
  const receipt=client.observedExits.get('shell');assert.notEqual(receipt.acknowledged,true);
  await sleep(180);assert.equal(acks,1,'no same-socket retry for unavailable');
  assert.ok(registry.readOwnerRecord().panes.some(p=>p.id==='shell'&&p.exited));
  process.kill(status.pid,'SIGKILL');await wait(()=>logs.some(e=>e.state==='recovered'));await wait(()=>receipt.acknowledged===true);
  assert.equal(acks,2);assert.ok(!registry.readOwnerRecord().panes.some(p=>p.id==='shell'));
  assert.deepEqual(events.filter(e=>e.type==='exit'&&e.ptyId==='shell').map(e=>e.exitCode),[23]);await client.shutdown();
 }finally{await cleanup(client);}
});

test('blocked known-key status retains matching owner PIDs without owner probes or a host start',async()=>{
 const client=new PtyHostClient('unused'),saved={read:registry.readOwnerRecord,live:registry.ownerRecordIsLive,reader:registry.ownerReaderIsLive};let reads=0;
 const identity={pid:800,startTime:'start',instanceId:'a'.repeat(32),binaryHash:'b'.repeat(64)};
 const record={...identity,panes:[{id:'survivor',pid:900,startIdentity:'10:20'}],uncertain:['uncertain'],spawnIntents:[{id:'preparing',generation:'c'.repeat(32)}]};
 registry.readOwnerRecord=()=>{reads++;return record;};registry.ownerRecordIsLive=registry.ownerReaderIsLive=()=>{throw Error('status must not probe owner');};
 client.startHost=()=>{throw Error('status must not start a host');};client.crashBlocked=true;client.ownsOwnerKey=true;client.recoveryOwner=identity;client.recoveryReason='Owner unavailable';
 try{
  const result=await client.hostStatus();assert.ok(result.owner,'blocked status must keep retained owner inventory');assert.deepEqual(result.owner.inventory,[{id:'survivor',pid:900,startIdentity:'10:20'}]);assert.equal(result.ptyCount,1);assert.deepEqual(result.owner.disconnected,['survivor','uncertain','preparing']);assert.equal(result.recoveryReason,'Owner unavailable');assert.equal(reads,1);
  client.crashContext={owner:identity};client.recoveryOwner=null;assert.equal((await client.hostStatus()).owner.inventory[0].pid,900,'cancelled incompatible recovery keeps original crash inventory');
  client.recoveryOwner={...identity,instanceId:'d'.repeat(32)};assert.equal((await client.hostStatus()).owner,undefined);
  client.ownsOwnerKey=false;const before=reads;assert.equal((await client.hostStatus()).owner,undefined);assert.equal(reads,before,'unknown-key reuse performs no record lookup');
 }finally{registry.readOwnerRecord=saved.read;registry.ownerRecordIsLive=saved.live;registry.ownerReaderIsLive=saved.reader;client.dispose();}
});

test('host refuses a shutdown bound to another owner instance without stopping any child',{timeout:15000},async()=>{
 const {client,status,pid}=await setup();
 try{
  await assert.rejects(client.request({id:0,type:'shutdown',target:{pid:status.pid,startTime:status.startTime,ownerInstance:'f'.repeat(32)}}),/changed/);
  assert.doesNotThrow(()=>process.kill(status.pid,0));assert.doesNotThrow(()=>process.kill(pid,0));assert.equal(await client.getPid('shell'),pid);await client.shutdown();
 }finally{await cleanup(client);}
});

test('Cancel keeps the same two-spent budget and a later real crash recovers once without respawn',{timeout:20000},async()=>{
 const {client,status,logs,pid}=await setup();
 try{
  for(let i=0;i<2;i++){const current=await client.hostStatus();process.kill(current.pid,'SIGKILL');await wait(()=>logs.filter(e=>e.state==='recovered').length===i+1);}
  const current=await client.hostStatus(),supervisor=client.crashSupervisor;assert.equal(supervisor.used,2);
  await assert.rejects(client.restart({target:{pid:current.pid,startTime:'changed',owner:current.owner},confirmChanged:async()=>false}),/restart cancelled/);
  assert.equal(client.hostAsked,false);assert.equal(client.crashSupervisor,supervisor);assert.equal(supervisor.used,2);assert.equal(supervisor.disposed,false);
  process.kill(current.pid,'SIGKILL');await wait(()=>logs.filter(e=>e.state==='recovered').length===3);assert.equal(await client.getPid('shell'),pid);assert.equal((await client.hostStatus()).owner.pid,status.owner.pid);assert.equal(supervisor.used,3);
  const last=await client.hostStatus();process.kill(last.pid,'SIGKILL');await wait(()=>logs.some(e=>e.state==='exhausted'));assert.doesNotThrow(()=>process.kill(pid,0));assert.equal(logs.filter(e=>e.state==='recovered').length,3);
 }finally{await cleanup(client);}
});
