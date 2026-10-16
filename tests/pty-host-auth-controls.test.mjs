import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {isolateHome} from './helpers/isolate-home.mjs';
fs.mkdirSync('test-results',{recursive:true});const root=fs.mkdtempSync(path.resolve('test-results/auth-control-'));isolateHome(root);
const {PtyHostClient}=await import('../dist-electron/pty-host-client.js');
const {readAuthTransferTicket}=await import('../dist-electron/pty-host-auth-ticket.js');
const {redeemHostCapability}=await import('../dist-electron/pty-host-auth-redemption.js');
const {ownerProcessStartIdentity}=await import('../dist-electron/pty-owner-client.js');
const {validateOwnerContinuity,validateTransferredOwnerContinuity}=await import('../dist-electron/pty-host-owner-continuity.js');
const {cleanupNativeOwner}=await import('./helpers/pty-host.mjs');
async function fixture(mode){
 const child=spawn(process.execPath,['tests/helpers/pty-host-auth-controls.cjs',mode],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore','ignore','pipe','ipc']});let stderr='',message;child.stderr.on('data',b=>stderr+=b);child.on('message',m=>message=m);
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

test('announced empty-owner relaunch completes without starting or probing a replacement owner',{timeout:20000},async()=>{
 const old=await fixture('publish-empty');assert.equal(old.ownerPid,null);
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
  assert.equal((await c.request({id:0,type:'version'})).owner,null);assert.equal(fs.existsSync(path.join(process.env.AYA_HOME,'pty-owner/record.json')),false);await c.shutdown();
 }finally{c.dispose();c.dropSocket();key.fill(0);await cleanupNativeOwner(process.env.AYA_HOME);}
});
