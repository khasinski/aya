import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
fs.mkdirSync('test-results',{recursive:true});const home=fs.mkdtempSync(path.resolve('test-results/owner-retirement-real-'));
process.env.AYA_HOME=home;process.env.HOME=home;process.env.SHELL='/bin/sh';
const {PtyHostClient}=require('../dist-electron/pty-host-client.js');
const native=require('../dist-electron/pty-owner-client.js'),registry=require('../dist-electron/pty-owner-registry.js');
const {createPtyHostHealth,probeSocketPid}=require('../dist-electron/pty-host-health.js');
const {waitFor,fakeWebContents,ptyEventsFor,cleanupNativeOwner}=await import('./helpers/pty-host.mjs');
const script=path.resolve('dist-electron/pty-host.js'),alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
async function setup(command){
 fs.mkdirSync(home,{recursive:true});
 const first=new PtyHostClient(script),sink=fakeWebContents();first.attachWebContents(sink);
 const request={ptyId:'kept',agent:'custom',command:command??'stty -echo; echo OWNER_RETIRE_READY; while IFS= read -r line; do printf "R:%s\\n" "$line"; done',cwd:home,cols:80,rows:24};
 await first.spawn(request);await waitFor(()=>ptyEventsFor(sink,'kept').some(e=>e.type==='data'&&e.chunk.includes(command?'SURVIVOR_READY':'OWNER_RETIRE_READY')));
 const before=await first.hostStatus(),pid=await first.getPid('kept'),second=new PtyHostClient(script),send=second.sendRequest.bind(second),events=[],logs=[];
 second.hostAuthKey=Buffer.from(first.hostAuthKey); // Component authority, manifest intentionally unavailable.
 second.enableCrashRecovery({log:(event,fields)=>logs.push({event,...fields})});second.attachWebContents({isDestroyed:()=>false,send:(_c,e)=>events.push(e)});
 second.sendRequest=(socket,req)=>req.type==='owner-continuity'?Promise.reject(Object.assign(Error('unsupported continuity'),{code:'PTY_HOST_REMOTE_ERROR'})):send(socket,req);
 await second.hostStatus();assert.equal(second.ownsOwnerKey,false);assert.equal(second.live.size,0);
 first.dispose();first.dropSocket();process.kill(before.pid,'SIGKILL');await waitFor(()=>!alive(before.pid)&&second.crashBlocked);
 let starts=0;const start=second.startHost.bind(second);second.startHost=(...args)=>{starts++;return start(...args);};
 const questions=[];let primary=false,survivors=false,afterQuestion=()=>{};
 const actions=createPtyHostHealth({app:{getVersion:()=>"0.12.0"},mainDirname:path.resolve('dist-electron'),ptyHost:second,
  relaunchDeps:{file:path.join(home,'notes.json'),panes:async()=>[{id:'kept',name:'Retained work'}],agentOf:async()=>"custom",screen:async()=>"",pid:async()=>pid,command:async()=>request.command,busy:async()=>false,foreground:async()=>null},
  askRestart:async(yes,detail)=>{questions.push({yes,detail});afterQuestion(yes);return yes==='Stop surviving processes'?survivors:primary;},confirmLosingWork:async()=>{throw Error('owner stop needs explicit inventory question');},
  focusedAyaWindow:()=>null,dialog:{showMessageBox:async()=>({response:1})},Menu:{getApplicationMenu:()=>null},nativeImage:{createEmpty:()=>null},setStaleMenuIcon:()=>{},
  socketExists:async()=>fs.existsSync(path.join(home,'pty-host.sock')),probeSocket:()=>probeSocketPid(path.join(home,'pty-host.sock')),liveRecords:()=>[],kill:()=>{throw Error('no numeric fixture signal');},waitForExit:async()=>false});
 return {first,second,before,pid,request,events,logs,actions,questions,get starts(){return starts;},set primary(v){primary=v;},set survivors(v){survivors=v;},set afterQuestion(v){afterQuestion=v;}};
}
async function cleanup(f){
 try{if(f.second.isConnected()){const pid=f.second.lastHostPid;await f.second.shutdown();if(pid)await waitFor(()=>!alive(pid));}}
 finally{f.first.dispose();f.second.dispose();await cleanupNativeOwner(home);fs.rmSync(home,{recursive:true,force:true});}
}
function requirePidfd(t){if(process.platform==='linux'&&!native.ownerRecoverySupported()){assert.notEqual(process.env.AYA_OWNER_EXPECT_PIDFD,'1','native Linux CI requires pidfd');t.skip('pidfd unavailable here; explicit refusal is covered by native contracts');return false;}return true;}
test('Diagnostics Cancel keeps an unavailable owner; identity changes stop nothing; yes retires it before a fresh host',{timeout:25000},async t=>{
 if(!requirePidfd(t))return;
 const f=await setup(),terminate=native.terminateVerifiedProcess;let signals=0;
 native.terminateVerifiedProcess=(...args)=>{signals++;return terminate(...args);};
 try{
  const retained=await f.second.hostStatus();assert.equal(retained.ownerUnavailable,true);assert.equal(retained.owner.startIdentity,native.ownerProcessStartIdentity(retained.owner.pid));
  await f.second.spawn({...f.request,attachOnly:true}).catch(()=>{}); // a real late view gets the blocked notice
  await assert.rejects(f.actions.restartHostFromWindow(),/restart cancelled/);assert.equal(signals,0);assert.equal(f.starts,0);assert.equal(f.second.ownerContinuityUnavailable,true);assert.equal(alive(f.pid),true);
  assert.match(f.questions[0].detail,/Stopping the terminal owner/);assert.match(f.questions[0].detail,new RegExp(`PID ${f.before.owner.pid}`));assert.match(f.questions[0].detail,new RegExp(`Retained work \\(PID ${f.pid}\\)`));
  const original=registry.readOwnerRecord();let changed=false;f.primary=true;
  f.afterQuestion=yes=>{if(yes==='Stop terminal owner'&&!changed){changed=true;registry.writeOwnerRecord({...original,startIdentity:'0:0'});}};
  await assert.rejects(f.actions.restartHostFromWindow(),/identity changed|cannot be verified/);assert.equal(signals,0);assert.equal(f.starts,0);assert.equal(alive(f.pid),true);assert.ok(f.questions.length>=3,'changed identity gets a fresh question');
  registry.writeOwnerRecord(original);f.afterQuestion=()=>{};
  await f.actions.restartHostFromWindow();assert.equal(signals,1);assert.equal(alive(f.before.owner.pid),false);assert.equal(alive(f.pid),false);assert.equal(f.second.ownerContinuityUnavailable,false);assert.equal(f.second.crashBlocked,false);
  assert.deepEqual(f.logs.filter(e=>e.event==='pty-owner-confirmed-sigterm').map(e=>[e.pid,e.startIdentity,e.instanceId,e.outcome]),[[f.before.owner.pid,original.startIdentity,original.instanceId,'signalled']]);
  await f.second.spawn(f.request);const next=await f.second.hostStatus();assert.notEqual(next.pid,f.before.pid);assert.notEqual(next.owner.pid,f.before.owner.pid);assert.notEqual(await f.second.getPid('kept'),f.pid);assert.equal(f.starts,1);
 }finally{native.terminateVerifiedProcess=terminate;await cleanup(f);}
});
test('an older retained owner without kernel identity is unknown and its notice never promises Restart',{timeout:15000},async t=>{
 if(!requirePidfd(t))return;
 const f=await setup(),terminate=native.terminateVerifiedProcess;let signals=0;
 native.terminateVerifiedProcess=()=>{signals++;return 'unknown';};
 try{
  const record=registry.readOwnerRecord();delete record.startIdentity;registry.writeOwnerRecord(record);
  f.second.blockUnavailableOwner();await assert.rejects(f.second.spawn({...f.request,attachOnly:true}),/disconnected or recovering/);
  const notice=f.events.filter(e=>e.type==='disconnected').at(-1);assert.match(notice.reason,/kernel start identity was not recorded/);assert.ok(!notice.reason.includes('Restart'));
  f.primary=true;await assert.rejects(f.actions.restartHostFromWindow(),/no recorded kernel start identity/);assert.equal(signals,0);assert.equal(f.starts,0);assert.equal(alive(f.before.owner.pid),true);assert.equal(alive(f.pid),true);assert.equal(f.second.ownerContinuityUnavailable,true);
 }finally{native.terminateVerifiedProcess=terminate;await cleanup(f);}
});
test('a survivor needs separate consent after owner death; Cancel keeps it and yes settles it before a fresh host',{timeout:25000},async t=>{
 if(!requirePidfd(t))return;
 const command=`exec env ELECTRON_RUN_AS_NODE=1 '${process.execPath}' '${path.resolve('e2e/helpers/pty-owner-survivor.cjs')}'`;
 const f=await setup(command),terminate=native.terminateVerifiedProcess;let signals=0;
 // Model a failure during the owner's normal SIGTERM cleanup, leaving a real
 // HUP-ignoring child. Main still requests exactly one individual SIGTERM.
 native.terminateVerifiedProcess=(identity,group)=>{
  if(identity.pid!==f.before.owner.pid)return terminate(identity,group);
  signals++;assert.equal(native.ownerProcessStartIdentity(identity.pid),identity.startIdentity);
  process.kill(identity.pid,'SIGKILL');return 'signalled';
 };
 try{
  f.primary=true;
  await assert.rejects(f.actions.restartHostFromWindow(),/survivor recovery was not confirmed/);
  assert.equal(signals,1);assert.equal(alive(f.before.owner.pid),false);assert.equal(alive(f.pid),true);
  assert.equal(f.starts,0);assert.equal(f.second.ownerContinuityUnavailable,true);
  assert.ok(registry.readOwnerRecord().panes.some(p=>p.pid===f.pid));
  const question=f.questions.find(q=>q.yes==='Stop surviving processes');
  assert.ok(question);assert.match(question.detail,new RegExp(`PID ${f.pid}`));
  f.survivors=true;
  await f.actions.restartHostFromWindow();
  assert.equal(signals,1,'a gone owner is never signalled again');
  assert.equal(alive(f.pid),false);
  assert.notEqual(registry.readOwnerRecord()?.instanceId,f.before.owner.instanceId);
  assert.equal(f.second.ownerContinuityUnavailable,false);
  await f.second.spawn({...f.request,command:'echo OWNER_RETIRE_READY; sleep 300'});
  assert.equal(f.starts,1);assert.notEqual((await f.second.hostStatus()).owner.pid,f.before.owner.pid);
 }finally{native.terminateVerifiedProcess=terminate;await cleanup(f);}
});
