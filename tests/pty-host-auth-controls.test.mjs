import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
import {isolateHome} from './helpers/isolate-home.mjs';
fs.mkdirSync('test-results',{recursive:true});const root=fs.mkdtempSync(path.resolve('test-results/auth-control-'));isolateHome(root);
const {PtyHostClient}=await import('../dist-electron/pty-host-client.js');
const {readAuthTransferTicket}=await import('../dist-electron/pty-host-auth-ticket.js');
const {redeemHostCapability}=await import('../dist-electron/pty-host-auth-redemption.js');
const {ownerProcessStartIdentity}=await import('../dist-electron/pty-owner-client.js');
const {validateOwnerContinuity,validateTransferredOwnerContinuity}=await import('../dist-electron/pty-host-owner-continuity.js');
const {cleanupNativeOwner}=await import('./helpers/pty-host.mjs');
async function fixture(mode){
 const child=spawn(process.execPath,['tests/helpers/pty-host-auth-controls.cjs',mode],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',AYA_TEST_CONTINUITY_CAUSE:mode.replace('publish-refusal-','')},stdio:['ignore','ignore','pipe','ipc']});let stderr='',message;child.stderr.on('data',b=>stderr+=b);child.on('message',m=>message=m);
 await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>code===0&&message?resolve():reject(Error(`controls:${mode}:${code}/${signal}:${stderr}`)));});return message;
}
after(async()=>{await cleanupNativeOwner(process.env.AYA_HOME);fs.rmSync(root,{recursive:true,force:true});});
// A failed assertion must not leave this recipient's principal serving the
// shared disposable home and turn later cases into PRINCIPAL_BUSY failures.
async function cleanupPlannedFixture(c,ticket,primaryError){
 try{await retirePlannedFixture(c,ticket);}catch(error){
  if(!primaryError)throw error;
  console.error('PLANNED_FIXTURE_SECONDARY_CLEANUP_FAILURE',error); // preserve the original failed assertion
 }
}
function probeIdentity(pid,identify=ownerProcessStartIdentity){
 try{return {known:true,value:identify(pid)};}catch(error){
  // The native lookup deliberately fails closed if /proc (or the platform's
  // process table) is transiently unreadable while a child is exiting. Retry
  // that observation; never treat an unverifiable PID as safe to signal.
  if(error?.message==='Cannot verify process identity')return {known:false,value:null};
  throw error;
 }
}
async function waitForKnownIdentity(pid,identify,timeoutMs=5000){
 const end=Date.now()+timeoutMs;let last;
 do{last=probeIdentity(pid,identify);if(last.known)return last.value;await new Promise(resolve=>setTimeout(resolve,5));}while(Date.now()<end);
 throw Error('fixture cannot verify process identity after retries');
}
async function waitForTargetsRetired(targets,identify,timeoutMs=5000){
 const end=Date.now()+timeoutMs;let states;
 do{
  states=targets.map(target=>probeIdentity(target.pid,identify));
  if(states.every((state,index)=>state.known&&state.value!==targets[index].startIdentity))return;
  await new Promise(resolve=>setTimeout(resolve,5));
 }while(Date.now()<end);
 if(states.some(state=>!state.known))throw Error('fixture cannot verify host retirement after repeated identity probes');
 throw Error('fixture host outlived cleanup');
}
function fixtureRetirementTargets(c,ticket,identify=ownerProcessStartIdentity){
 const child=c.pendingPlannedHost,targets=[{pid:ticket.hostPid,startIdentity:ticket.hostStartIdentity}];
 if(c.lastHostPid&&c.lastHostStart)targets.push({pid:c.lastHostPid,startIdentity:c.lastHostStart});
 if(child&&child.exitCode===null&&child.signalCode===null){const status=probeIdentity(child.pid,identify);if(status.known&&status.value)targets.push({pid:child.pid,startIdentity:status.value});}
 return [...new Map(targets.map(target=>[`${target.pid}:${target.startIdentity}`,target])).values()];
}
async function retirePlannedFixture(c,ticket,overrides={}){
 const native=require('../dist-electron/pty-owner-client.js'),child=c.pendingPlannedHost,identify=overrides.identity??ownerProcessStartIdentity;
 const targets=fixtureRetirementTargets(c,ticket,identify);
 c.hostAsked=true;c.crashSupervisor?.dispose();
 try{
  if(targets.some(t=>{const status=probeIdentity(t.pid,identify);return !status.known||status.value===t.startIdentity;})){
   if(!c.isConnected())await c.openSocket().catch(()=>{}); // existing only; never starts a host
   if(c.isConnected()){
    const peer=require('../dist-electron/pty-handover-window.js').handoverPeer(c.socket);
    if(!targets.some(t=>t.pid===peer.pid&&t.startIdentity===peer.startIdentity))throw Error('fixture cleanup socket target changed');
    let timer;try{await Promise.race([PtyHostClient.prototype.sendRequest.call(c,c.socket,{id:0,type:'shutdown'}),new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('fixture shutdown response timeout')),2000);})]).catch(()=>{});}finally{clearTimeout(timer);}
    const end=Date.now()+5000;while(targets.some(t=>{const status=probeIdentity(t.pid,identify);return !status.known||status.value===t.startIdentity;})&&Date.now()<end)await new Promise(r=>setTimeout(r,5));
   }
  }
 }finally{
  c.dispose();c.dropSocket();
  for(const target of targets){
   const current=await waitForKnownIdentity(target.pid,identify);
   if(current!==target.startIdentity)continue;
   // One verified individual TERM only; no process groups or unknown targets.
   if(child?.pid===target.pid&&child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
   else{const result=(overrides.terminate??native.terminateVerifiedProcess)(target,target.pid);if(!['signalled','absent','mismatch'].includes(result))throw Error('fixture cleanup cannot verify host retirement: '+result);}
  }
  await waitForTargetsRetired(targets,identify);
  await (overrides.cleanupOwner??cleanupNativeOwner)(process.env.AYA_HOME);
 }
}

test('real host transfers once after old main exit and rearms only after validated continuity',{timeout:20000},async()=>{
 const old=await fixture('publish'),ticket=await readAuthTransferTicket(old.file);assert.ok(ticket);assert.equal(fs.existsSync(old.file),false);
 const socket=net.createConnection(path.join(process.env.AYA_HOME,'pty-host.sock'));await once(socket,'connect');
 const key=await redeemHostCapability(socket,ticket,{pid:process.pid,startIdentity:ownerProcessStartIdentity(process.pid)}),c=new PtyHostClient(path.resolve('dist-electron/pty-host.js'));c.hostAuthKey=key;
 try{
  const status=await c.hostStatus();assert.equal(status.pid,old.hostPid);assert.equal(status.owner.pid,old.ownerPid);assert.equal(await c.getPid('kept'),old.pid);
  await assert.rejects(c.request({id:0,type:'auth-transfer-complete',attempt:ticket.attempt,receipt:'b'.repeat(64)}));
  const result=await c.request({id:0,type:'owner-continuity',transferAttempt:ticket.attempt}),{transferReceipt,...body}=result;
  assert.match(transferReceipt,/^[a-f0-9]{64}$/);assert.equal(transferReceipt,createHash('sha256').update(JSON.stringify(body.bootstrap)).digest('hex'));
  const continuity=validateOwnerContinuity(body,{pid:ticket.hostPid,startIdentity:ticket.hostStartIdentity},status);continuity.credential.fill(0);
  assert.equal(await c.request({id:0,type:'auth-transfer-complete',attempt:ticket.attempt,receipt:transferReceipt}),true);assert.equal(await c.request({id:0,type:'auth-transfer-complete',attempt:ticket.attempt,receipt:transferReceipt}),true);
  const next=await c.request({id:0,type:'auth-transfer-reserve',purpose:'ordinary-quit',nonce:'c'.repeat(64),deadline:null});assert.notEqual(next.attempt,ticket.attempt);assert.equal(await c.request({id:0,type:'auth-transfer-cancel',attempt:next.attempt}),'cancelled');
  assert.equal(await c.getPid('kept'),old.pid);assert.equal((await c.hostStatus()).owner.pid,old.ownerPid);await c.shutdown();
 }finally{c.dispose();c.dropSocket();key.fill(0);await cleanupNativeOwner(process.env.AYA_HOME);}
});
for(const mode of ['ordinary-wins','core-wins','planned-reserved'])test(`real host ${mode} excludes competing transfer/freeze without stopping the pane`,{timeout:20000},async()=>{
 assert.deepEqual(await fixture(mode),{ok:true});await cleanupNativeOwner(process.env.AYA_HOME);
});
test('authenticated transfer verbs and receipt requests have closed bounded envelopes',async()=>{
 const {isPtyHostRequest}=await import('../dist-electron/pty-host-protocol.js'),attempt='a'.repeat(64),receipt='b'.repeat(64);
 const requests=[{id:1,type:'auth-transfer-reserve',purpose:'ordinary-quit',nonce:attempt,deadline:null},{id:1,type:'auth-transfer-activate',attempt},{id:1,type:'auth-transfer-cancel',attempt},{id:1,type:'auth-transfer-complete',attempt,receipt},{id:1,type:'owner-continuity',transferAttempt:attempt}];
 for(const request of requests){
  assert.equal(isPtyHostRequest(request),true);assert.equal(isPtyHostRequest({...request,extra:true}),false);assert.equal(isPtyHostRequest({...request,id:NaN}),false);
  const inherited=Object.create(request);Object.assign(inherited,Object.fromEntries(Object.entries(request).filter(([key])=>key!=='type')));inherited.extra=true;assert.equal(isPtyHostRequest(inherited),false);
  const key=request.type==='auth-transfer-reserve'?'nonce':request.type==='owner-continuity'?'transferAttempt':'attempt';
  for(const invalid of ['', 'a'.repeat(63),'g'.repeat(64),{},undefined])assert.equal(isPtyHostRequest({...request,[key]:invalid}),false);
 }
 assert.equal(isPtyHostRequest({id:1,type:'auth-transfer-unknown',attempt}),false);
 assert.equal(isPtyHostRequest({...requests[0],purpose:'other'}),false);
 assert.equal(isPtyHostRequest({...requests[0],purpose:'planned-update'}),false);
 assert.equal(isPtyHostRequest({...requests[0],deadline:Date.now()+120000}),false);
 assert.equal(isPtyHostRequest({...requests[0],purpose:'planned-update',deadline:Date.now()+120000}),true);assert.equal(isPtyHostRequest({...requests[3],receipt:'not-a-receipt'}),false);
});

test('existing B3 cancel alone revokes planned credential release and resumes the same pane',{timeout:20000},async()=>{
 const child=spawn(process.execPath,['tests/helpers/pty-host-auth-controls.cjs','planned-cancel'],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore','ignore','pipe','ipc']});let error='';child.stderr.on('data',b=>error+=b);const exit=once(child,'exit');
 try{
  const [old]=await once(child,'message'),ticket=await readAuthTransferTicket(old.file);
  const socket=net.createConnection(path.join(process.env.AYA_HOME,'pty-host.sock'));await once(socket,'connect');
  await assert.rejects(redeemHostCapability(socket,ticket,{pid:process.pid,startIdentity:ownerProcessStartIdentity(process.pid)}));
  const verified=once(child,'message');child.send('verify-original-main');const [after]=await verified;
  assert.deepEqual(after,{verifiedAfterRejectedRedemption:true,pid:old.pid,ownerPid:old.ownerPid});assert.equal((await exit)[0],0,error);
 }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await exit;}await cleanupNativeOwner(process.env.AYA_HOME);}

});

for(const mode of ['publish-empty','publish-empty-recovered'])test(`announced ${mode} validates empty continuity and permits later fresh pane I/O`,{timeout:20000},async()=>{
 const old=await fixture(mode);assert.equal(old.ownerPid,null);
 const ticket=await readAuthTransferTicket(old.file),socket=net.createConnection(path.join(process.env.AYA_HOME,'pty-host.sock'));await once(socket,'connect');
 const key=await redeemHostCapability(socket,ticket,{pid:process.pid,startIdentity:ownerProcessStartIdentity(process.pid)}),c=new PtyHostClient(path.resolve('dist-electron/pty-host.js'));c.hostAuthKey=key;
 try{
  const status=await c.request({id:0,type:'version'});assert.equal(status.pid,old.hostPid);assert.equal(status.owner,null);assert.equal(status.ptyCount,0);
  const retained=path.join(process.env.AYA_HOME,'pty-owner/record.json');fs.writeFileSync(retained,'unreadable retained inventory',{mode:0o600});
  await assert.rejects(c.request({id:0,type:'owner-continuity',transferAttempt:ticket.attempt}));fs.unlinkSync(retained);
  const result=await c.request({id:0,type:'owner-continuity',transferAttempt:ticket.attempt});
  const continuity=validateTransferredOwnerContinuity(result,{pid:ticket.hostPid,startIdentity:ticket.hostStartIdentity},status);assert.equal(continuity.bootstrap,null);continuity.credential.fill(0);
  assert.equal(await c.request({id:0,type:'auth-transfer-complete',attempt:ticket.attempt,receipt:continuity.receipt}),true);
  const next=await c.request({id:0,type:'auth-transfer-reserve',purpose:'ordinary-quit',nonce:'c'.repeat(64),deadline:null});await c.request({id:0,type:'auth-transfer-cancel',attempt:next.attempt});
  assert.equal((await c.request({id:0,type:'version'})).owner,null);assert.equal(fs.existsSync(path.join(process.env.AYA_HOME,'pty-owner/record.json')),false);
  const events=[];c.attachWebContents({isDestroyed:()=>false,send:(_channel,event)=>events.push(event)});
  const freshOutput=()=>events.filter(e=>e.ptyId==='fresh-after-empty'&&e.type==='data').map(e=>e.chunk).join('');
  await c.spawn({ptyId:'fresh-after-empty',agent:'custom',command:'stty -echo; printf READY_FRESH; read line; printf "FRESH:%s\\n" "$line"; exit 23',cwd:process.env.HOME,cols:80,rows:24});
  const until=Date.now()+5000;while(!freshOutput().includes('READY_FRESH')){if(Date.now()>until)throw Error('fresh empty-owner spawn failed');await new Promise(resolve=>setTimeout(resolve,5));}
  assert.ok(await c.getPid('fresh-after-empty'));await c.write('fresh-after-empty','AFTER_EMPTY\n');
  while(!freshOutput().includes('FRESH:AFTER_EMPTY')){if(Date.now()>until)throw Error('fresh empty-owner input failed');await new Promise(resolve=>setTimeout(resolve,5));}
  while(!c.endedBootPanes.has('fresh-after-empty')){if(Date.now()>until)throw Error('fresh empty-owner exit missing');await new Promise(resolve=>setTimeout(resolve,5));}
  assert.equal(c.endedBootPanes.get('fresh-after-empty'),23);await c.shutdown();
 }finally{c.dispose();c.dropSocket();key.fill(0);await cleanupNativeOwner(process.env.AYA_HOME);}
});

for(const mode of ['publish','publish-public','publish-empty'])test(`public announced client ${mode} keeps keys in memory and completes validated continuity`,{timeout:20000},async()=>{
 const old=await fixture(mode),ticket=await readAuthTransferTicket(old.file),c=new PtyHostClient(path.resolve('dist-electron/pty-host.js'));let starts=0;
 c.startHost=()=>{starts++;throw Error('announced reuse must not start a host');};
 // An unrelated development disk key must not override the announced proof.
 fs.mkdirSync(path.join(process.env.AYA_HOME,'pty-host-auth'),{mode:0o700,recursive:true});fs.writeFileSync(path.join(process.env.AYA_HOME,'pty-host-auth/key'),Buffer.alloc(32,91),{mode:0o600});
 try{
  await c.redeemAnnouncedCapability(ticket);assert.equal(c.isConnected(),false,'redemption does not wait for principal ownership');
  const status=await c.hostStatus();assert.equal(status.pid,old.hostPid);assert.equal(c.ownsOwnerKey,true);assert.equal(c.receivedAuthTransfer,null);assert.equal(starts,0);
  if(mode!=='publish-empty'){assert.equal(status.owner.pid,old.ownerPid);assert.equal(await c.getPid('kept'),old.pid);c.dropSocket();assert.equal(typeof (await c.paneState('kept')).generation,'string','observer borrows announced memory authority despite wrong disk key');}
  else assert.equal(status.owner,undefined);
  const next=await c.request({id:0,type:'auth-transfer-reserve',purpose:'ordinary-quit',nonce:'c'.repeat(64),deadline:null});await c.request({id:0,type:'auth-transfer-cancel',attempt:next.attempt});
  await c.shutdown();
 }finally{c.dispose();c.dropSocket();await cleanupNativeOwner(process.env.AYA_HOME);}
});
test('local post-response completion failure retries the exact receipt on next connection without a second credential redemption',{timeout:20000},async()=>{
 const old=await fixture('publish'),ticket=await readAuthTransferTicket(old.file),c=new PtyHostClient(path.resolve('dist-electron/pty-host.js')),send=c.sendRequest.bind(c);let completions=0,manifests=0;const receipts=[];
 c.sendRequest=async(socket,request)=>{if(request.type==='owner-continuity')manifests++;const result=await send(socket,request);if(request.type==='auth-transfer-complete'){receipts.push(request.receipt);if(++completions===1)throw Error('lost successful completion reply');}return result;};
 try{
  await c.redeemAnnouncedCapability(ticket);assert.ok((await c.hostStatus()).identity);assert.ok(c.receivedAuthTransfer?.receipt);c.dropSocket();
  assert.equal((await c.hostStatus()).pid,old.hostPid);assert.equal(c.receivedAuthTransfer,null);assert.equal(completions,2);assert.equal(manifests,1);assert.equal(receipts[0],receipts[1]);assert.equal(await c.getPid('kept'),old.pid);await c.shutdown();
 }finally{c.dispose();c.dropSocket();await cleanupNativeOwner(process.env.AYA_HOME);}
});

test('announced client does not evict a still-live old main and completes continuity after it exits',{timeout:20000},async()=>{
 const child=spawn(process.execPath,['tests/helpers/pty-host-auth-controls.cjs','publish-alive'],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore','ignore','pipe','ipc']});
 let stderr='';child.stderr.on('data',b=>stderr+=b);const old=await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.once('exit',()=>reject(Error(stderr)));});
 const c=new PtyHostClient(path.resolve('dist-electron/pty-host.js'));let starts=0;c.startHost=()=>{starts++;throw Error('no replacement allowed');};
 try{
  const ticket=await readAuthTransferTicket(old.file);await c.redeemAnnouncedCapability(ticket);
  const busy=await c.hostStatus();assert.equal(busy.principalBusy,true);assert.equal(c.ownsOwnerKey,false);assert.ok(c.receivedAuthTransfer);assert.equal(starts,0);
  const exited=once(child,'exit');child.send('exit');assert.equal((await exited)[0],0,stderr);
  const ready=await c.hostStatus();assert.equal(ready.pid,old.hostPid);assert.equal(ready.owner.pid,old.ownerPid);assert.equal(c.ownsOwnerKey,true);assert.equal(c.receivedAuthTransfer,null);assert.equal(await c.getPid('kept'),old.pid);assert.equal(starts,0);await c.shutdown();
 }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');c.dispose();c.dropSocket();await cleanupNativeOwner(process.env.AYA_HOME);}
});

test('an announced recipient cannot enter host creation grace if its expected socket disappears before continuity',{timeout:20000},async()=>{
 const old=await fixture('publish'),ticket=await readAuthTransferTicket(old.file),c=new PtyHostClient(path.resolve('dist-electron/pty-host.js'));
 const guard=require('../dist-electron/pty-host-start-guard.js'),wait=guard.waitForHostShutdown;let grace=0,starts=0;const open=c.openSocket;
 try{
  await c.redeemAnnouncedCapability(ticket);c.openSocket=async()=>{throw Object.assign(Error('absent'),{code:'ENOENT'});};guard.waitForHostShutdown=async()=>{grace++;throw Error('creation grace must not run');};c.startHost=()=>{starts++;throw Error('no host may start');};
  await assert.rejects(c.spawn({ptyId:'forbidden',command:'cat',cwd:process.env.HOME,cols:80,rows:24}),/This request was not sent/);assert.equal(grace,0);assert.equal(starts,0);
 }finally{guard.waitForHostShutdown=wait;c.openSocket=open;await c.shutdown().catch(()=>{});c.dispose();c.dropSocket();await cleanupNativeOwner(process.env.AYA_HOME);}
});

test('real lost completion RPC reply reconnects with identical receipt before onResponse can settle it',{timeout:20000},async()=>{
 const old=await fixture('publish-lost-completion'),ticket=await readAuthTransferTicket(old.file),c=new PtyHostClient(old.script),send=c.sendRequest.bind(c),onResponse=c.onResponse.bind(c),ids=[];let manifests=0,completedResponses=0;
 c.sendRequest=(socket,request)=>{if(request.type==='owner-continuity')manifests++;if(request.type==='auth-transfer-complete')ids.push(c.nextId);return send(socket,request);};
 c.onResponse=message=>{if(ids.includes(message.id))completedResponses++;return onResponse(message);};
 try{
  await c.redeemAnnouncedCapability(ticket);assert.equal((await c.hostStatus()).identity,null);assert.equal(c.isConnected(),false);assert.equal(completedResponses,0,'socket closed before first ACK reached pending response');assert.ok(c.receivedAuthTransfer?.receipt);
  assert.equal((await c.hostStatus()).pid,old.hostPid);assert.equal(c.receivedAuthTransfer,null);assert.equal(manifests,1);assert.equal(completedResponses,1);assert.equal(ids.length,2);
  const receipts=fs.readFileSync(old.completions,'utf8').trim().split('\n').map(JSON.parse);assert.equal(receipts.length,2);assert.deepEqual(receipts[0],receipts[1]);assert.equal(receipts[0].attempt,ticket.attempt);
  assert.equal(await c.getPid('kept'),old.pid);assert.equal((await c.hostStatus()).owner.pid,old.ownerPid);await c.shutdown();
 }finally{c.dispose();c.dropSocket();await cleanupNativeOwner(process.env.AYA_HOME);if(old.script)fs.rmSync(old.script,{force:true});}
});
test('pending announced read-only observer pins target before any capability proof or RPC',{timeout:20000},async()=>{
 const old=await fixture('publish'),ticket=await readAuthTransferTicket(old.file),c=new PtyHostClient(path.resolve('dist-electron/pty-host.js'));
 const windowModule=require('../dist-electron/pty-handover-window.js'),auth=require('../dist-electron/pty-host-auth-transport.js'),readPeer=windowModule.handoverPeer,authenticate=auth.authenticateHostSocket,send=PtyHostClient.prototype.sendRequest;let proofs=0,rpcs=0;
 try{
  await c.redeemAnnouncedCapability(ticket);
  windowModule.handoverPeer=socket=>({...readPeer(socket),pid:ticket.hostPid+1});auth.authenticateHostSocket=(...args)=>{proofs++;return authenticate(...args);};PtyHostClient.prototype.sendRequest=function(...args){rpcs++;return send.apply(this,args);};
  assert.equal((await c.paneState('kept')).state,'unknown');assert.equal(proofs,0);assert.equal(rpcs,0);assert.ok(c.receivedAuthTransfer);
 }finally{windowModule.handoverPeer=readPeer;auth.authenticateHostSocket=authenticate;PtyHostClient.prototype.sendRequest=send;await c.shutdown().catch(()=>{});c.dispose();c.dropSocket();await cleanupNativeOwner(process.env.AYA_HOME);}
});

for(const variant of ['invalid','unavailable','refused-key','dead-reader'])test(`failed announced ${variant} continuity keeps Cancel usable and permits a consented real replacement`,{timeout:25000},async t=>{
 const native=require('../dist-electron/pty-owner-client.js');if((variant==='refused-key'||variant==='dead-reader')&&process.platform==='linux'&&!native.ownerRecoverySupported()){assert.notEqual(process.env.AYA_OWNER_EXPECT_PIDFD,'1');t.skip('pidfd unavailable; native CI requires successful verified retirement');return;}
 const old=await fixture('publish'),ticket=await readAuthTransferTicket(old.file),c=new PtyHostClient(path.resolve('dist-electron/pty-host.js')),send=c.sendRequest.bind(c),start=c.startHost.bind(c);let starts=0,shutdowns=0,yes=false;const questions=[],events=[];
 c.startHost=(...args)=>{starts++;return start(...args);};c.attachWebContents({isDestroyed:()=>false,send:(_channel,event)=>events.push(event)});
 c.sendRequest=async(socket,request)=>{if(request.type==='shutdown')shutdowns++;if(request.type==='owner-continuity'&&variant==='unavailable')throw Object.assign(Error('unavailable continuity'),{code:'PTY_HOST_REMOTE_ERROR'});const result=await send(socket,request);if(request.type==='owner-continuity')result.bootstrap.panes=[];return result;};
 const {createPtyHostHealth,probeSocketPid}=require('../dist-electron/pty-host-health.js');
 const actions=createPtyHostHealth({app:{getVersion:()=>"0.12.0"},mainDirname:path.resolve('dist-electron'),ptyHost:c,
  relaunchDeps:{file:path.join(process.env.AYA_HOME,'notes.json'),panes:async()=>[{id:'kept',name:'Retained work'}],agentOf:async()=>"custom",screen:async()=>"",pid:async()=>old.pid,command:async()=>"cat",busy:async()=>false,foreground:async()=>null},
  askRestart:async(label,detail)=>{questions.push({label,detail});return yes;},confirmLosingWork:async()=>{throw Error('continuity fallback needs its own inventory question');},
  focusedAyaWindow:()=>null,dialog:{showMessageBox:async()=>({response:1})},Menu:{getApplicationMenu:()=>null},nativeImage:{createEmpty:()=>null},setStaleMenuIcon:()=>{},
  socketExists:async()=>fs.existsSync(path.join(process.env.AYA_HOME,'pty-host.sock')),probeSocket:()=>probeSocketPid(path.join(process.env.AYA_HOME,'pty-host.sock')),liveRecords:()=>[],kill:()=>{throw Error('no numeric signal');},waitForExit:async()=>false});
 try{
  await c.redeemAnnouncedCapability(ticket);const failed=await c.hostStatus();assert.ok(failed.identity);assert.equal(failed.authentication,undefined);assert.equal(failed.continuityUnavailable,true);assert.equal(failed.owner.inventory[0].pid,old.pid);const pending=c.receivedAuthTransfer;assert.ok(pending);
  await assert.rejects(actions.restartHostFromWindow(),/restart cancelled/);assert.equal(c.receivedAuthTransfer,pending);assert.equal(starts,0);assert.equal(shutdowns,0);process.kill(old.pid,0);process.kill(old.ownerPid,0);assert.ok(questions[0].detail.includes(`Retained work (PID ${old.pid})`));
  if(variant==='refused-key'){c.hostAuthKey=Buffer.alloc(32,99);c.dropSocket();}
  if(variant==='dead-reader'){
   assert.equal(ownerProcessStartIdentity(old.hostPid),ticket.hostStartIdentity);process.kill(old.hostPid,'SIGKILL');
   const end=Date.now()+5000;while(ownerProcessStartIdentity(old.hostPid)){if(Date.now()>end)throw Error('old reader did not exit');await new Promise(resolve=>setTimeout(resolve,5));}
  }
  if(variant==='refused-key'||variant==='dead-reader'){await assert.rejects(actions.restartHostFromWindow(),/restart cancelled/);assert.equal(c.receivedAuthTransfer,pending);assert.equal(starts,0);process.kill(old.ownerPid,0);process.kill(old.pid,0);}
  yes=true;await actions.restartHostFromWindow();assert.equal(c.receivedAuthTransfer,null);assert.equal(shutdowns,variant==='invalid'||variant==='unavailable'?1:0);assert.throws(()=>process.kill(old.pid,0),/ESRCH/);assert.throws(()=>process.kill(old.hostPid,0),/ESRCH/);
  await c.spawn({ptyId:'fresh-after-fallback',agent:'custom',command:'stty -echo; printf READY_FALLBACK; read line; printf "FALLBACK:%s\\n" "$line"; exit 23',cwd:process.env.HOME,cols:80,rows:24});
  const output=()=>events.filter(e=>e.ptyId==='fresh-after-fallback'&&e.type==='data').map(e=>e.chunk).join(''),until=Date.now()+5000;
  while(!output().includes('READY_FALLBACK')){if(Date.now()>until)throw Error('fresh fallback spawn failed');await new Promise(resolve=>setTimeout(resolve,5));}
  assert.equal(starts,1);const fresh=await c.getPid('fresh-after-fallback');assert.ok(fresh);assert.notEqual(fresh,old.pid);await c.write('fresh-after-fallback','NEW_INPUT\n');
  while(!events.some(e=>e.type==='exit'&&e.ptyId==='fresh-after-fallback')){if(Date.now()>until)throw Error('fresh fallback exit missing');await new Promise(resolve=>setTimeout(resolve,5));}
  assert.match(output(),/FALLBACK:NEW_INPUT/);assert.equal(events.find(e=>e.type==='exit'&&e.ptyId==='fresh-after-fallback').exitCode,23);await c.shutdown();
 }finally{await c.request({id:0,type:'shutdown'},undefined,true).catch(()=>{});c.dispose();c.dropSocket();await cleanupNativeOwner(process.env.AYA_HOME);}
});

test('retirement cleanup requires the same pending attempt and exact stopped host or owner identity',()=>{
 const c=new PtyHostClient(path.resolve('dist-electron/pty-host.js'));
 const owner={pid:200,startTime:'owner-start',instanceId:'a'.repeat(32),binaryHash:'b'.repeat(64)},pending={ticket:{hostPid:100,hostStartIdentity:'1:2'},retirementOwner:owner},newer={ticket:{hostPid:101,hostStartIdentity:'1:3'},retirementOwner:owner};
 c.receivedAuthTransfer=newer;c.retireReceivedTransfer(pending,{pid:100,startIdentity:'1:2'});assert.equal(c.receivedAuthTransfer,newer);
 c.receivedAuthTransfer=pending;c.retireReceivedTransfer(pending,{pid:100,startIdentity:'1:9'});assert.equal(c.receivedAuthTransfer,pending);
 c.retireReceivedTransfer(pending,undefined,{...owner,instanceId:'c'.repeat(32)});assert.equal(c.receivedAuthTransfer,pending);
 c.retireReceivedTransfer(pending,undefined,owner);assert.equal(c.receivedAuthTransfer,null);
 c.receivedAuthTransfer=pending;c.retireReceivedTransfer(pending,{pid:100,startIdentity:'1:2'});assert.equal(c.receivedAuthTransfer,null);c.dispose();
});

test('planned replacement retires only old pending auth target after its confirmed exit before successor attach',{timeout:25000},async()=>{
 const old=await fixture('publish-planned'),ticket=await readAuthTransferTicket(old.file),c=new PtyHostClient(path.resolve('dist-electron/pty-host.js'));
 try{
  await c.redeemAnnouncedCapability(ticket);assert.ok(c.receivedAuthTransfer);
  const identity=c.expectedHostIdentity('0.12.0');identity.scriptHash='0'.repeat(64);
  await c.adoptPlannedHandover(ticket,identity,async()=>{});assert.equal(c.receivedAuthTransfer,null);
  const status=await c.hostStatus();assert.notEqual(status.pid,old.hostPid);assert.equal(status.owner.pid,old.ownerPid);assert.equal(await c.getPid('kept'),old.pid);assert.throws(()=>process.kill(old.hostPid,0),/ESRCH/);
  await c.write('kept','AFTER_PLANNED_AUTH_RETIREMENT\n');const until=Date.now()+5000;while(!(await c.getBuffer('kept')).includes('AFTER_PLANNED_AUTH_RETIREMENT')){if(Date.now()>until)throw Error('planned successor input failed');await new Promise(resolve=>setTimeout(resolve,5));}await c.shutdown();
 }finally{await c.request({id:0,type:'shutdown'},undefined,true).catch(()=>{});c.dispose();c.dropSocket();await cleanupNativeOwner(process.env.AYA_HOME);}
});

for(const cause of ['pending','uncertain','incompatible','ended'])test(`redeemed capability keeps a serving authenticated socket when real owner continuity guard refuses ${cause}`,{timeout:20000},async()=>{
 const old=await fixture(cause==='ended'?'publish-ended':'publish-refusal-'+cause),ticket=await readAuthTransferTicket(old.file),c=new PtyHostClient(old.script??path.resolve('dist-electron/pty-host.js')),events=[];let starts=0;
 c.startHost=()=>{starts++;throw Error('No replacement authorized');};c.attachWebContents({isDestroyed:()=>false,send:(_channel,event)=>events.push(event)});
 try{
  await c.redeemAnnouncedCapability(ticket);const status=await c.hostStatus();assert.ok(status.identity);assert.equal(status.pid,old.hostPid);assert.equal(status.authentication,undefined);assert.equal(status.continuityUnavailable,true);assert.equal(c.isConnected(),true);assert.equal(c.authRefusalPeer,undefined);assert.equal(c.ownsOwnerKey,false);assert.equal(c.ownerContinuityUnavailable,true);assert.ok(c.receivedAuthTransfer);assert.equal(starts,0);
  await c.spawn({ptyId:'kept',agent:'custom',command:'never respawn',cwd:process.env.HOME,cols:80,rows:24,attachIfReused:true});assert.equal(await c.getPid('kept'),old.pid);
  assert.ok(events.some(e=>e.type==='recovery-unavailable'&&/Automatic terminal host recovery is off/.test(e.reason)));
  await c.write('kept','AFTER_UNAVAILABLE_CONTINUITY\n');const until=Date.now()+5000;while(!(await c.getBuffer('kept')).includes('AFTER_UNAVAILABLE_CONTINUITY')){if(Date.now()>until)throw Error('serving socket lost');await new Promise(r=>setTimeout(r,5));}
  const hydration=[];c.attachWebContents({isDestroyed:()=>false,send:(_channel,event)=>hydration.push(event)});assert.ok(hydration.some(e=>e.type==='recovery-unavailable'));
  assert.equal(starts,0);await c.shutdown();
 }finally{c.dispose();c.dropSocket();await cleanupNativeOwner(process.env.AYA_HOME);if(old.script)fs.rmSync(old.script,{force:true});}
});

test('ordinary authenticated reused host without a received ticket hydrates a nonempty recovery-off reason on manifest failure',{timeout:20000},async()=>{
 const first=new PtyHostClient(path.resolve('dist-electron/pty-host.js')),second=new PtyHostClient(path.resolve('dist-electron/pty-host.js')),events=[];
 try{
  fs.mkdirSync(process.env.HOME,{recursive:true});fs.mkdirSync(process.env.AYA_HOME,{recursive:true,mode:0o700});
  await first.spawn({ptyId:'ordinary',agent:'custom',command:'stty -echo; printf ORDINARY_READY; cat',cwd:process.env.HOME,cols:80,rows:24});
  const until=Date.now()+5000;while(!(await first.getBuffer('ordinary')).includes('ORDINARY_READY')){if(Date.now()>until)throw Error('ordinary fixture readiness');await new Promise(r=>setTimeout(r,5));}
  const pid=await first.getPid('ordinary'),before=await first.hostStatus(),send=second.sendRequest.bind(second);
  // Explicit test authority loan between objects in the SAME principal PID;
  // no disk lookup or announced-recipient bypass is under test here.
  second.hostAuthKey=Buffer.from(first.hostAuthKey);second.sendRequest=(socket,req)=>req.type==='owner-continuity'?Promise.reject(Error('manifest unavailable')):send(socket,req);
  second.attachWebContents({isDestroyed:()=>false,send:(_channel,event)=>events.push(event)});
  const status=await second.hostStatus();assert.equal(status.pid,before.pid);assert.equal(status.authentication,undefined);assert.equal(status.continuityUnavailable,true);assert.match(status.recoveryReason,/Automatic terminal host recovery is off/);assert.equal(second.receivedAuthTransfer,null);assert.equal(second.isConnected(),true);assert.equal(second.ownsOwnerKey,false);
  await second.spawn({ptyId:'ordinary',agent:'custom',command:'never respawn',cwd:process.env.HOME,cols:80,rows:24,attachIfReused:true});assert.equal(await second.getPid('ordinary'),pid);
  const late=[];second.attachWebContents({isDestroyed:()=>false,send:(_channel,event)=>late.push(event)});
  for(const list of [events,late])assert.ok(list.some(e=>e.type==='recovery-unavailable'&&e.reason===status.recoveryReason));
  await second.write('ordinary','STILL_SERVING\n');while(!(await second.getBuffer('ordinary')).includes('STILL_SERVING')){if(Date.now()>until)throw Error('ordinary reuse lost serving socket');await new Promise(r=>setTimeout(r,5));}
  await second.shutdown();
 }finally{first.dispose();first.dropSocket();second.dispose();second.dropSocket();await cleanupNativeOwner(process.env.AYA_HOME);}
});

for(const mode of ['publish-planned','publish-planned-ended'])test(`planned credential ownership ${mode} follows full checkpoint validation, with no reader detach on reuse`,{timeout:25000},async()=>{
 const old=await fixture(mode),ticket=await readAuthTransferTicket(old.file),c=new PtyHostClient(path.resolve('dist-electron/pty-host.js'));let starts=0,inspected=false,completions=0,primaryError;
 const send=c.sendRequest.bind(c);c.startHost=()=>{starts++;throw Error('reuse cannot create a host');};
 c.sendRequest=(socket,req)=>{if(req.type==='auth-transfer-complete'){assert.equal(inspected,true,'full checkpoint/display inspection precedes credential ACK');completions++;}return send(socket,req);};
 try{
  await c.redeemAnnouncedCapability(ticket);
  await c.adoptPlannedHandover(ticket,c.expectedHostIdentity('reuse'),async state=>{
   assert.deepEqual(state.eligible.map(p=>p.id),['kept']);
   await assert.rejects(c.sendRequest(c.socket,{id:0,type:'auth-transfer-reserve',purpose:'ordinary-quit',nonce:'c'.repeat(64),deadline:null}),'recipient cannot rearm before validated continuity ACK');
   inspected=true;
  });
  assert.equal(completions,1);assert.equal(c.receivedAuthTransfer,null);assert.equal(c.ownsOwnerKey,true);assert.equal(starts,0);
  const status=await c.hostStatus();assert.equal(status.pid,old.hostPid);assert.equal(status.owner.pid,old.ownerPid);
  // A second changed-host preparation before the first display ACK must carry
  // ended suffix/outcome as well. Neither credential completion ACKs that pane.
  const next=await c.request({id:0,type:'auth-transfer-reserve',purpose:'planned-update',nonce:'e'.repeat(64),deadline:Date.now()+120000});
  const second=await c.request({id:0,type:'handover-prepare',deadline:next.deadline,transferAttempt:next.attempt});
  assert.deepEqual(second.eligible.map(p=>p.id),['kept']);await c.cancelPlannedHandover();
  if(mode==='publish-planned-ended'){
   const events=[];c.attachWebContents({isDestroyed:()=>false,send:(_channel,event)=>events.push(event)});
   const req={ptyId:'kept',agent:'custom',command:'must-not-spawn',cwd:process.env.HOME,cols:80,rows:24,attachIfReused:true,replayAfter:{generation:old.endedOrigin.generation,offset:old.endedOrigin.outputEnd,token:'applied-after-auth'}};
   await c.spawn(req);assert.equal(await c.getPid('kept'),null);
   assert.equal(events.filter(e=>e.type==='data'&&e.replay).map(e=>e.chunk).join(''),'LAST_SUFFIX');assert.deepEqual(events.filter(e=>e.type==='exit').map(e=>e.exitCode),[23]);
   assert.equal(await c.acknowledgeHandoverDisplay('kept',old.endedOrigin.generation,'stale-view'),false);
   assert.equal(await c.acknowledgeHandoverDisplay('kept',old.endedOrigin.generation,'applied-after-auth'),true);
  }else{assert.equal(await c.getPid('kept'),old.pid);assert.equal(c.recoveryLaunches.get('kept').pid,old.pid);assert.equal(c.live.has('kept'),true);await c.write('kept','AFTER_RECEIPT\n');}
  await c.shutdown();
 }catch(error){primaryError=error;throw error;}finally{await cleanupPlannedFixture(c,ticket,primaryError);}
});

test('failed planned display validation cannot complete or rearm credentials and resumes the usable old pane',{timeout:20000},async()=>{
 const old=await fixture('publish-planned'),ticket=await readAuthTransferTicket(old.file),c=new PtyHostClient(path.resolve('dist-electron/pty-host.js')),send=c.sendRequest.bind(c);let completions=0,primaryError;
 c.sendRequest=(socket,req)=>{if(req.type==='auth-transfer-complete')completions++;return send(socket,req);};
 try{
  await c.redeemAnnouncedCapability(ticket);
  await assert.rejects(c.adoptPlannedHandover(ticket,c.expectedHostIdentity('reuse'),async()=>{throw Error('display validation refused');}),/display validation refused/);
  assert.equal(completions,0);assert.ok(c.receivedAuthTransfer);assert.equal(c.receivedAuthTransfer.receipt,undefined);
  await assert.rejects(send(c.socket,{id:0,type:'auth-transfer-reserve',purpose:'ordinary-quit',nonce:'f'.repeat(64),deadline:null}));
  await send(c.socket,{id:0,type:'write',ptyId:'kept',data:'AFTER_VALIDATION_ABORT\n'});
  const until=Date.now()+5000;while(!(await send(c.socket,{id:0,type:'buffer',ptyId:'kept'})).includes('AFTER_VALIDATION_ABORT')){if(Date.now()>until)throw Error('old reader did not resume');await new Promise(r=>setTimeout(r,5));}
  assert.equal(await send(c.socket,{id:0,type:'pid',ptyId:'kept'}),old.pid);
 }catch(error){primaryError=error;throw error;}finally{await cleanupPlannedFixture(c,ticket,primaryError);}
});

test('planned lost-success ACK keeps validated live and ended authority for exact retry and real B4 recovery',{timeout:30000},async()=>{
 const old=await fixture('publish-planned-mixed-lost'),ticket=await readAuthTransferTicket(old.file),c=new PtyHostClient(old.script),send=c.sendRequest.bind(c),onResponse=c.onResponse.bind(c),events=[],logs=[],ids=[];
 let claims=0,manifests=0,responses=0,redemptions=0,validatedKey,primaryError;
 const redeem=c.redeemAnnouncedCapability.bind(c);c.redeemAnnouncedCapability=async value=>{redemptions++;return redeem(value);};
 c.attachWebContents({isDestroyed:()=>false,send:(_channel,event)=>events.push(event)});
 c.sendRequest=async(socket,req)=>{
  if(req.type==='auth-transfer-complete')ids.push(c.nextId);
  if(req.type==='owner-continuity')manifests++;
  const result=await send(socket,req);
  if(req.type==='handover-claim'){claims++;validatedKey=Buffer.from(result.credential,'base64');assert.deepEqual(result.checkpoint.eligible.map(p=>p.id).sort(),['ended','kept']);}
  return result;
 };
 c.onResponse=message=>{if(ids.includes(message.id))responses++;return onResponse(message);};
 try{
  await c.redeemAnnouncedCapability(ticket);
  await assert.rejects(c.adoptPlannedHandover(ticket,c.expectedHostIdentity('reuse'),async()=>{}),/disconnected/i);
  assert.equal(responses,0,'server committed completion but no response settled the original RPC');
  const pending=c.receivedAuthTransfer;assert.ok(pending?.receipt);assert.equal(c.ownsOwnerKey,true);assert.deepEqual(Buffer.from(c.ownerSecret),validatedKey);assert.equal(c.recoveryOwner.pid,old.ownerPid);assert.equal(c.recoveryLaunches.get('kept').pid,old.pid);assert.equal(c.live.has('kept'),true);
  const status=await c.hostStatus();assert.equal(status.pid,old.hostPid);assert.equal(status.owner.pid,old.ownerPid);assert.equal(c.receivedAuthTransfer,null);assert.equal(responses,1);assert.equal(redemptions,1);assert.equal(claims,1);assert.equal(manifests,0,'the planned receipt is not replaced by a live-only manifest');
  const receipts=fs.readFileSync(old.completions,'utf8').trim().split('\n').map(JSON.parse);assert.equal(receipts.length,2);assert.deepEqual(receipts[0],receipts[1]);assert.equal(receipts[0].attempt,ticket.attempt);
  // Credential completion neither ACKs the ended display nor respawns it.
  await c.spawn({ptyId:'ended',agent:'custom',command:'never respawn',cwd:process.env.HOME,cols:80,rows:24,attachIfReused:true,replayAfter:{generation:old.endedOrigin.generation,offset:old.endedOrigin.outputEnd,token:'after-lost-completion'}});
  assert.equal(await c.getPid('ended'),null);assert.equal(events.filter(e=>e.ptyId==='ended'&&e.type==='data'&&e.replay).map(e=>e.chunk).join(''),'LAST_SUFFIX');assert.deepEqual(events.filter(e=>e.ptyId==='ended'&&e.type==='exit').map(e=>e.exitCode),[23]);
  assert.equal(await c.acknowledgeHandoverDisplay('ended',old.endedOrigin.generation,'stale'),false);assert.equal(await c.acknowledgeHandoverDisplay('ended',old.endedOrigin.generation,'after-lost-completion'),true);
  c.enableCrashRecovery({log:(event,fields)=>logs.push({event,...fields})});assert.equal(ownerProcessStartIdentity(old.hostPid),ticket.hostStartIdentity);process.kill(old.hostPid,'SIGKILL');
  const until=Date.now()+12000;while(!logs.some(e=>e.state==='recovered')){if(Date.now()>until)throw Error('validated planned authority did not recover the owner after ACK retry');await new Promise(r=>setTimeout(r,5));}
  const recovered=await c.hostStatus();assert.notEqual(recovered.pid,old.hostPid);assert.equal(recovered.owner.pid,old.ownerPid);assert.equal(await c.getPid('kept'),old.pid);
  await c.write('kept','AFTER_PLANNED_LOST_ACK_RECOVERY\n');while(!(await c.getBuffer('kept')).includes('AFTER_PLANNED_LOST_ACK_RECOVERY')){if(Date.now()>until)throw Error('recovered input failed');await new Promise(r=>setTimeout(r,5));}
  await c.shutdown();
 }catch(error){primaryError=error;throw error;}finally{validatedKey?.fill(0);await cleanupPlannedFixture(c,ticket,primaryError);fs.rmSync(old.script,{force:true});}
});

test('a failed planned assertion retires its real host/principal before the next fixture',{timeout:20000},async()=>{
 const old=await fixture('publish-planned'),ticket=await readAuthTransferTicket(old.file),c=new PtyHostClient(path.resolve('dist-electron/pty-host.js'));
 let primaryError;await assert.rejects(async()=>{
  try{await c.redeemAnnouncedCapability(ticket);await c.adoptPlannedHandover(ticket,c.expectedHostIdentity('reuse'),async()=>{});assert.fail('intentional planned assertion');}
  catch(error){primaryError=error;throw error;}finally{await cleanupPlannedFixture(c,ticket,primaryError);}
 },/intentional planned assertion/);
 assert.notEqual(await waitForKnownIdentity(old.hostPid,ownerProcessStartIdentity),ticket.hostStartIdentity);
 const next=await fixture('publish-planned'),nextTicket=await readAuthTransferTicket(next.file),recipient=new PtyHostClient(path.resolve('dist-electron/pty-host.js'));
 try{await recipient.redeemAnnouncedCapability(nextTicket);await recipient.adoptPlannedHandover(nextTicket,recipient.expectedHostIdentity('reuse'),async()=>{});assert.equal(await recipient.getPid('kept'),next.pid);}
 finally{await cleanupPlannedFixture(recipient,nextTicket);}
});

for(const result of ['absent','unknown'])test(`planned cleanup deduplicates targets and handles native ${result} at the final exit boundary`,async()=>{
 let alive=true,signals=0,ownerCleaned=false;
 const ticket={hostPid:123,hostStartIdentity:'1:2'},client={lastHostPid:123,lastHostStart:'1:2',hostAsked:false,isConnected:()=>false,openSocket:async()=>{throw Error('fixture socket gone');},dispose(){},dropSocket(){}};
 assert.deepEqual(fixtureRetirementTargets(client,ticket),[{pid:123,startIdentity:'1:2'}]);
 const work=retirePlannedFixture(client,ticket,{identity:()=>alive?'1:2':null,terminate:target=>{assert.deepEqual(target,{pid:123,startIdentity:'1:2'});signals++;if(result==='absent')alive=false;return result;},cleanupOwner:async()=>{ownerCleaned=true;}});
 if(result==='absent'){await work;assert.equal(ownerCleaned,true);}else{await assert.rejects(work,/cannot verify host retirement: unknown/);assert.equal(ownerCleaned,false);}
 assert.equal(signals,1);
});

test('planned cleanup retries a transient native process-identity failure before retiring the host',async()=>{
 let probes=0,ownerCleaned=false;
 const ticket={hostPid:123,hostStartIdentity:'1:2'},client={lastHostPid:123,lastHostStart:'1:2',hostAsked:false,isConnected:()=>false,openSocket:async()=>{throw Error('fixture socket gone');},dispose(){},dropSocket(){}};
 const identity=()=>{probes++;if(probes===1)throw Error('Cannot verify process identity');return null;};
 await retirePlannedFixture(client,ticket,{identity,cleanupOwner:async()=>{ownerCleaned=true;}});
 assert.ok(probes>=2);assert.equal(ownerCleaned,true);
});
