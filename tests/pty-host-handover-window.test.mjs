import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {isolateHome} from './helpers/isolate-home.mjs';
mkdirSync('test-results',{recursive:true});
const root=mkdtempSync(path.resolve('test-results/host-handover-'));isolateHome(root);
mkdirSync(process.env.HOME,{recursive:true});mkdirSync(process.env.AYA_HOME,{recursive:true});
const {PtyHostClient}=await import('../dist-electron/pty-host-client.js');
const {cleanupNativeOwner}=await import('./helpers/pty-host.mjs');
after(async()=>{await cleanupNativeOwner(process.env.AYA_HOME);rmSync(root,{recursive:true,force:true});});
const hostScript=path.resolve('dist-electron/pty-host.js');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function host(fn){const client=new PtyHostClient(hostScript);try{await client.request({id:0,type:'version'});await fn(client);}finally{await client.shutdown().catch(()=>{});client.dispose();}}
test('real host refuses unannounced transfer; announced transfer returns its inherited key exactly once without logging it',()=>host(async(client)=>{
 const nonce=randomBytes(32).toString('hex');
 await assert.rejects(client.request({id:0,type:'handover-claim',nonce}),/refused/);
 const announcement=await client.request({id:0,type:'handover-announce',nonce,deadline:Date.now()+10000});
 assert.ok(announcement.hostPid>1);assert.match(announcement.hostStartIdentity,/^\d+:\d+$/);
 const result=await client.request({id:0,type:'handover-claim',nonce});
 assert.equal(digest(Buffer.from(result.credential,'base64')),digest(client.ownerSecret));
 await assert.rejects(client.request({id:0,type:'handover-claim',nonce}),/refused/);
 const log=path.join(process.env.AYA_HOME,'pty-events.log');assert.equal(readFileSync(log,'utf8').includes(result.credential),false);
}));
test('real host closes an announced window on a wrong nonce',()=>host(async(client)=>{
 const nonce=randomBytes(32).toString('hex');await client.request({id:0,type:'handover-announce',nonce,deadline:Date.now()+10000});
 await assert.rejects(client.request({id:0,type:'handover-claim',nonce:'b'.repeat(64)}),/refused/);
 await assert.rejects(client.request({id:0,type:'handover-claim',nonce}),/refused/);
}));
test('real host refuses a transfer after its deadline',()=>host(async(client)=>{
 const nonce=randomBytes(32).toString('hex');await client.request({id:0,type:'handover-announce',nonce,deadline:Date.now()+100});
 await new Promise(resolve=>setTimeout(resolve,150));await assert.rejects(client.request({id:0,type:'handover-claim',nonce}),/refused/);
}));
