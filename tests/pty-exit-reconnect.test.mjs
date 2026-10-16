import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {isolateHome} from './helpers/isolate-home.mjs';
fs.mkdirSync('test-results',{recursive:true});const root=fs.mkdtempSync(path.resolve('test-results/exit-reconnect-'));isolateHome(root);
const {PtyHostClient}=await import('../dist-electron/pty-host-client.js');
const {cleanupNativeOwner}=await import('./helpers/pty-host.mjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(f){const end=Date.now()+6000;while(!await f()){if(Date.now()>end)throw Error('exit reconnect acknowledgement timeout');await sleep(2);}}
test('native ACK success followed by socket loss retries the same receipt on reconnect before a later attach',{timeout:15000},async()=>{
 fs.mkdirSync(process.env.HOME,{recursive:true});fs.mkdirSync(process.env.AYA_HOME,{recursive:true});
 const script=path.resolve(`dist-electron/pty-host-ack-reconnect-${process.pid}.js`);
 fs.copyFileSync(path.resolve('dist-electron/pty-host.js'),script);
 fs.appendFileSync(script,`\nconst ackCore=require('./pty-core'),ackNative=ackCore.acknowledgePtyExit;let firstAck=true,keepExitOwner;ackCore.acknowledgePtyExit=async(...args)=>{keepExitOwner??=require('./pty-owner-runtime').currentOwnerRuntime().holdRestoration();const result=await ackNative(...args);require('node:fs').appendFileSync(require('node:path').join(process.env.AYA_HOME,'ack-receipts.jsonl'),JSON.stringify({args,result})+'\\n');if(firstAck){firstAck=false;for(const socket of clients)socket.destroy();}else{keepExitOwner();keepExitOwner=undefined;}return result;};\n`);
 const client=new PtyHostClient(script),events=[];client.attachWebContents({isDestroyed:()=>false,send:(_c,e)=>events.push(e)});
 const req={ptyId:'p',agent:'custom',command:"exec /bin/sh -c 'stty -echo; echo READY; while IFS= read -r line; do if [ \"$line\" = quit ]; then exit 23; fi; done'",cwd:process.env.HOME,cols:80,rows:24};
 try{
  await client.spawn(req);await wait(async()=>(await client.getBuffer('p')).includes('READY'));const before=await client.hostStatus();
  await client.write('p','quit\n');await wait(()=>!client.isConnected());assert.deepEqual(events.filter(e=>e.type==='exit').map(e=>e.exitCode),[23]);
  const receipt=client.observedExits.get('p');assert.ok(receipt);assert.notEqual(receipt.acknowledged,true);
  const after=await client.hostStatus();assert.equal(after.pid,before.pid);assert.equal(after.owner.pid,before.owner.pid);
  // This must complete from reconnect itself, not the later attach's retry.
  await wait(()=>receipt.acknowledged===true);
  const requests=fs.readFileSync(path.join(process.env.AYA_HOME,'ack-receipts.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(requests.length,2);assert.deepEqual(requests.map(p=>p.args),[['p',receipt.generation,receipt.event],['p',receipt.generation,receipt.event]]);assert.deepEqual(requests.map(p=>p.result),['retired','retired']);
  assert.equal(events.filter(e=>e.type==='exit').length,1,'one spontaneous outcome across reconnect');
  events.length=0;await client.spawn({...req,attachOnly:true});assert.deepEqual(events.filter(e=>e.type==='exit').map(e=>e.exitCode),[23]);
  assert.equal((await client.hostStatus()).owner.inventory.length,0);await client.shutdown();
 }finally{client.dispose();client.dropSocket();await cleanupNativeOwner(process.env.AYA_HOME);fs.rmSync(script,{force:true});fs.rmSync(root,{recursive:true,force:true});}
});
