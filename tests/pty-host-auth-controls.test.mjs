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
  const next=await c.request({id:0,type:'auth-transfer-reserve',purpose:'ordinary-quit',nonce:'c'.repeat(64),deadline:Date.now()+120000});assert.notEqual(next.attempt,ticket.attempt);assert.equal(await c.request({id:0,type:'auth-transfer-cancel',attempt:next.attempt}),'cancelled');
  assert.equal(await c.getPid('kept'),old.pid);assert.equal((await c.hostStatus()).owner.pid,old.ownerPid);await c.shutdown();
 }finally{c.dispose();c.dropSocket();key.fill(0);await cleanupNativeOwner(process.env.AYA_HOME);}
});
for(const mode of ['ordinary-wins','core-wins','planned-reserved'])test(`real host ${mode} excludes competing transfer/freeze without stopping the pane`,{timeout:20000},async()=>{
 assert.deepEqual(await fixture(mode),{ok:true});await cleanupNativeOwner(process.env.AYA_HOME);
});
test('authenticated transfer verbs and receipt requests have closed bounded envelopes',async()=>{
 const {isPtyHostRequest}=await import('../dist-electron/pty-host-protocol.js'),attempt='a'.repeat(64),receipt='b'.repeat(64);
 const requests=[{id:1,type:'auth-transfer-reserve',purpose:'ordinary-quit',nonce:attempt,deadline:Date.now()+1000},{id:1,type:'auth-transfer-activate',attempt},{id:1,type:'auth-transfer-cancel',attempt},{id:1,type:'auth-transfer-complete',attempt,receipt},{id:1,type:'owner-continuity',transferAttempt:attempt}];
 for(const request of requests){
  assert.equal(isPtyHostRequest(request),true);assert.equal(isPtyHostRequest({...request,extra:true}),false);assert.equal(isPtyHostRequest({...request,id:NaN}),false);
  const inherited=Object.create(request);Object.assign(inherited,Object.fromEntries(Object.entries(request).filter(([key])=>key!=='type')));inherited.extra=true;assert.equal(isPtyHostRequest(inherited),false);
  const key=request.type==='auth-transfer-reserve'?'nonce':request.type==='owner-continuity'?'transferAttempt':'attempt';
  for(const invalid of ['', 'a'.repeat(63),'g'.repeat(64),{},undefined])assert.equal(isPtyHostRequest({...request,[key]:invalid}),false);
 }
 assert.equal(isPtyHostRequest({id:1,type:'auth-transfer-unknown',attempt}),false);
 assert.equal(isPtyHostRequest({...requests[0],purpose:'other'}),false);assert.equal(isPtyHostRequest({...requests[3],receipt:'not-a-receipt'}),false);
});

test('existing B3 cancel alone revokes planned credential release and resumes the same pane',{timeout:20000},async()=>{
 const old=await fixture('planned-cancel'),ticket=await readAuthTransferTicket(old.file);
 const socket=net.createConnection(path.join(process.env.AYA_HOME,'pty-host.sock'));await once(socket,'connect');
 await assert.rejects(redeemHostCapability(socket,ticket,{pid:process.pid,startIdentity:ownerProcessStartIdentity(process.pid)}));
 const c=new PtyHostClient(path.resolve('dist-electron/pty-host.js'));
 try{assert.equal(await c.getPid('kept'),old.pid);assert.equal((await c.hostStatus()).owner.pid,old.ownerPid);assert.match(await c.getBuffer('kept'),/AFTER_PLANNED_ABORT/);await c.write('kept','AFTER_CANCEL_REDEMPTION\n');await c.shutdown();}
 finally{c.dispose();c.dropSocket();await cleanupNativeOwner(process.env.AYA_HOME);}
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
  const next=await c.request({id:0,type:'auth-transfer-reserve',purpose:'ordinary-quit',nonce:'c'.repeat(64),deadline:Date.now()+120000});await c.request({id:0,type:'auth-transfer-cancel',attempt:next.attempt});
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
 fs.writeFileSync(path.join(process.env.AYA_HOME,'pty-host-auth/key'),Buffer.alloc(32,91));
 try{
  await c.redeemAnnouncedCapability(ticket);assert.equal(c.isConnected(),false,'redemption does not wait for principal ownership');
  const status=await c.hostStatus();assert.equal(status.pid,old.hostPid);assert.equal(c.ownsOwnerKey,true);assert.equal(c.receivedAuthTransfer,null);assert.equal(starts,0);
  if(mode!=='publish-empty'){assert.equal(status.owner.pid,old.ownerPid);assert.equal(await c.getPid('kept'),old.pid);c.dropSocket();assert.equal(typeof (await c.paneState('kept')).generation,'string','observer borrows announced memory authority despite wrong disk key');}
  else assert.equal(status.owner,undefined);
  const next=await c.request({id:0,type:'auth-transfer-reserve',purpose:'ordinary-quit',nonce:'c'.repeat(64),deadline:Date.now()+120000});await c.request({id:0,type:'auth-transfer-cancel',attempt:next.attempt});
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
  const receipts=fs.readFileSync(path.join(process.env.AYA_HOME,'transfer-completions.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.equal(receipts.length,2);assert.deepEqual(receipts[0],receipts[1]);assert.equal(receipts[0].attempt,ticket.attempt);
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
