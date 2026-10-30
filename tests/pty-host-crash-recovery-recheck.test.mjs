// Crash recovery probes the previous host and the owner off the event loop, then re-checks spawn-free, with no await,
// right before the replacement host is forked.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
fs.mkdirSync('test-results',{recursive:true});const home=fs.mkdtempSync(path.resolve('test-results/crash-recheck-'));
process.env.AYA_HOME=home;process.env.HOME=home;after(()=>fs.rmSync(home,{recursive:true,force:true}));
const registry=require('../dist-electron/pty-owner-registry.js');
const ownerClient=require('../dist-electron/pty-owner-client.js');
const guard=require('../dist-electron/pty-host-start-guard.js');
const {PtyHostClient}=require('../dist-electron/pty-host-client.js');

const expected={pid:4242,startTime:'owner-start',instanceId:'a'.repeat(32),binaryHash:'b'.repeat(64)};
const ownerRecord=()=>({...expected,startIdentity:'5:5',executable:'/owner',jsPid:4243,jsStartTime:'reader',panes:[],uncertain:[]});
function setup(t,{duringPermit=()=>{}}={}){
 const saved={read:registry.readOwnerRecord,live:registry.ownerRecordIsLiveAsync,reader:registry.ownerReaderIsLiveAsync,hash:registry.ownerBinaryHash,
  identity:ownerClient.ownerProcessStartIdentity,permit:guard.hostCreationPermit,execSync:childProcess.execFileSync};
 const state={record:ownerRecord(),identity:'reused-1:1',ticks:0,starts:[],permits:0};
 const timer=setInterval(()=>state.ticks++,1);
 registry.readOwnerRecord=()=>state.record&&structuredClone(state.record);
 registry.ownerRecordIsLiveAsync=async()=>{await new Promise(resolve=>setTimeout(resolve,5));return true;};
 registry.ownerReaderIsLiveAsync=async()=>{await new Promise(resolve=>setTimeout(resolve,5));return false;};
 registry.ownerBinaryHash=()=>expected.binaryHash;
 // process.pid is alive; the previous host's recorded instance is 'old-host' and the pid now runs 'reused-1:1'.
 ownerClient.ownerProcessStartIdentity=pid=>pid===process.pid?state.identity:saved.identity(pid);
 guard.hostCreationPermit=async()=>{state.permits++;await new Promise(resolve=>setTimeout(resolve,5));duringPermit(state);const proof={state:'gone',hosts:[]};return {...proof,confirm:()=>proof};};
 childProcess.execFileSync=()=>{throw Error('crash recovery must not block on ps');};
 const client=new PtyHostClient(path.resolve('dist-electron/pty-host.js'));
 client.crashContext={pid:process.pid,start:'old-host',owner:{...expected}};
 client.startHost=(bootstrap,permit)=>{state.starts.push({bootstrap,permit});throw Error('stop after the fork point');};
 t.after(()=>{clearInterval(timer);Object.assign(registry,{readOwnerRecord:saved.read,ownerRecordIsLiveAsync:saved.live,ownerReaderIsLiveAsync:saved.reader,ownerBinaryHash:saved.hash});
  ownerClient.ownerProcessStartIdentity=saved.identity;guard.hostCreationPermit=saved.permit;childProcess.execFileSync=saved.execSync;client.dispose();});
 return {client,state};
}

test('unchanged previous host and owner record reach startHost with the async permit, the event loop running meanwhile',async t=>{
 const {client,state}=setup(t);
 assert.equal(await client.recoverCrashedHost(new AbortController().signal),'retry');
 assert.equal(state.starts.length,1);assert.equal(state.starts[0].permit.state,'gone');assert.equal(state.starts[0].bootstrap.kind,'crash');
 assert.ok(state.ticks>0,'timers ran while the probes were outstanding');
});
test('a previous host instance that is back under its recorded identity when the probes finish blocks the fork',async t=>{
 const {client,state}=setup(t,{duringPermit:s=>{s.identity='old-host';}});
 assert.equal(await client.recoverCrashedHost(new AbortController().signal),'blocked');assert.equal(state.permits,1);assert.deepEqual(state.starts,[]);
});
test('a previous host whose identity became unknown while probing blocks the fork',async t=>{
 const {client,state}=setup(t,{duringPermit:s=>{s.identity=null;}});
 assert.equal(await client.recoverCrashedHost(new AbortController().signal),'blocked');assert.deepEqual(state.starts,[]);
});
test('an owner record replaced or removed while probing blocks the fork',async t=>{
 for(const change of [s=>{s.record={...s.record,jsPid:5555};},s=>{s.record={...s.record,instanceId:'c'.repeat(32)};},s=>{s.record=null;}]){
  const {client,state}=setup(t,{duringPermit:change});
  assert.equal(await client.recoverCrashedHost(new AbortController().signal),'blocked');assert.deepEqual(state.starts,[]);
 }
});
test('a live previous host under its recorded identity is refused before any permit or start',async t=>{
 const {client,state}=setup(t);state.identity='old-host';
 assert.equal(await client.recoverCrashedHost(new AbortController().signal),'blocked');assert.equal(state.permits,0);assert.deepEqual(state.starts,[]);
});

// An announced host that is missing hands recovery to the retained owner only when its reader is verifiably gone.
const {HostAuthError}=require('../dist-electron/pty-host-auth.js');
function announced(t,hostPid){
 const client=new PtyHostClient(path.resolve('dist-electron/pty-host.js')),owner={pid:200,startTime:'owner-start',instanceId:'a'.repeat(32),binaryHash:'b'.repeat(64)};
 const transfer={ticket:{hostPid,hostStartIdentity:'1:2'},retirementOwner:owner};client.receivedAuthTransfer=transfer;
 const execSync=childProcess.execFileSync;childProcess.execFileSync=()=>{throw Error('the hand-over probe must not block on ps');};
 t.after(()=>{childProcess.execFileSync=execSync;client.dispose();});
 return {client,transfer,owner};
}
const endedPid=()=>childProcess.spawnSync(process.execPath,['-e',''],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}}).pid;
test('a verifiably gone announced reader hands recovery to the retained owner, the event loop running during the probe',async t=>{
 const {client,owner}=announced(t,endedPid());let ticks=0;const timer=setInterval(()=>ticks++,1);t.after(()=>clearInterval(timer));
 const error=await client.refuseMissingAnnouncedHost();
 assert.ok(!(error instanceof HostAuthError));assert.equal(client.ownerContinuityUnavailable,true);assert.deepEqual(client.recoveryOwner,owner);assert.ok(ticks>0);
});
test('a live reader, or a transfer replaced while ps ran, keeps the owner and only refuses authentication',async t=>{
 const live=announced(t,process.pid);
 assert.ok(await live.client.refuseMissingAnnouncedHost() instanceof HostAuthError);assert.notEqual(live.client.ownerContinuityUnavailable,true);
 const swapped=announced(t,endedPid()),execFile=childProcess.execFile;
 childProcess.execFile=(...args)=>{swapped.client.receivedAuthTransfer={...swapped.transfer};return execFile(...args);};
 t.after(()=>{childProcess.execFile=execFile;});
 assert.ok(await swapped.client.refuseMissingAnnouncedHost() instanceof HostAuthError);assert.notEqual(swapped.client.ownerContinuityUnavailable,true);
});
