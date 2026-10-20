import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {isolateHome} from './helpers/isolate-home.mjs';
fs.mkdirSync('test-results',{recursive:true});const home=fs.mkdtempSync(path.resolve('test-results/exit-delivery-'));isolateHome(home);
const {PtyHostClient}=await import('../dist-electron/pty-host-client.js');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const event=(generation=1)=>({type:'event',event:{type:'exit',ptyId:'p',exitCode:23,ownerExit:{generation,event:7}}});
test('main records exit before ACK, retries a lost reply, and never delivers the same native outcome twice',async()=>{
 const client=new PtyHostClient('unused'),events=[],requests=[];
 client.attachWebContents({isDestroyed:()=>false,send:(_channel,event)=>events.push(event)});
 client.socket={destroyed:false,write:line=>{
  const request=JSON.parse(line);requests.push(request);
  assert.equal(client.observedExits.get('p').event,7,'record before sending ACK');
  queueMicrotask(()=>client.onResponse(requests.length===1?{id:request.id,ok:false,error:'test ACK reply lost'}:{id:request.id,ok:true,result:"retired"}));
 }};
 try{
  client.onData(JSON.stringify(event())+'\n'+JSON.stringify(event())+'\n');
  await sleep(180);assert.equal(events.length,1);assert.equal(requests.length,2);assert.ok(requests.every(r=>r.type==='exit-observed'&&r.generation===1&&r.event===7));
  client.onData(JSON.stringify(event())+'\n');await sleep(10);assert.equal(events.length,1);assert.equal(requests.length,2);
  client.onData(JSON.stringify(event(2))+'\n');await sleep(10);assert.equal(events.length,2);assert.equal(requests.at(-1).generation,2);
 }finally{client.dispose();}
});
test('app quit cancels pending exit acknowledgement retries',async()=>{
 const client=new PtyHostClient('unused');let requests=0;
 client.socket={destroyed:false,write:line=>{const request=JSON.parse(line);requests++;queueMicrotask(()=>client.onResponse({id:request.id,ok:false,error:'lost'}));}};
 client.onData(JSON.stringify(event())+'\n');await sleep(5);client.dispose();await sleep(150);assert.equal(requests,1);
});
test('a lost write acknowledgement rejects as uncertain, with no resend or false delivered result',async()=>{
 const client=new PtyHostClient('unused');let requests=0,resolve;
 const written=new Promise(r=>{resolve=r;});client.connect=async()=>{};
 client.socket={destroyed:false,write:()=>{requests++;resolve();}};
 const writing=client.write('p','one Enter\r');await written;client.onClose();await assert.rejects(writing,/Some bytes may have reached.*did not resend/);assert.equal(requests,1);client.dispose();
});


test('exit ACK retry budget stops at three and duplicate delivery cannot reopen it',async()=>{
 const client=new PtyHostClient('unused');let requests=0;
 client.socket={destroyed:false,write:line=>{const request=JSON.parse(line);requests++;queueMicrotask(()=>client.onResponse({id:request.id,ok:false,error:'lost'}));}};
 try{client.onData(JSON.stringify(event())+'\n');await sleep(350);assert.equal(requests,3);client.onData(JSON.stringify(event())+'\n');await sleep(120);assert.equal(requests,3);}finally{client.dispose();}
});
test('a new-generation exit arriving behind an older ACK gets its own scoped ACK',async()=>{
 const client=new PtyHostClient('unused'),requests=[];
 client.socket={destroyed:false,write:line=>requests.push(JSON.parse(line))};
 try{
  client.onData(JSON.stringify(event())+'\n');client.onData(JSON.stringify(event(2))+'\n');assert.equal(requests.length,1);
  client.onResponse({id:requests[0].id,ok:true,result:"retired"});await sleep(1);assert.equal(requests.length,2);assert.equal(requests[1].generation,2);
  client.onResponse({id:requests[1].id,ok:true,result:"retired"});await sleep(1);assert.equal(client.observedExits.get('p').acknowledged,true);
 }finally{client.dispose();}
});

test('stale exit receipt is dropped and logged without retry',async()=>{
 const client=new PtyHostClient('unused'),logs=[];let calls=0;client.enableCrashRecovery({log:(event,fields)=>logs.push({event,...fields})});
 client.socket={destroyed:false,write:line=>{const req=JSON.parse(line);calls++;queueMicrotask(()=>client.onResponse({id:req.id,ok:true,result:'stale'}));}};
 try{client.onData(JSON.stringify(event())+'\n');await sleep(150);assert.equal(calls,1);assert.equal(client.observedExits.has('p'),false);assert.ok(logs.some(e=>e.event==='pty-exit-ack-stale'));}finally{client.dispose();}
});

test('a failed fresh spawn invalidates the previous observed process exit',async()=>{
 const client=new PtyHostClient('unused');
 client.readExistingSnapshot=async()=>null;
 try{
  client.onData(JSON.stringify({type:'event',event:{type:'exit',ptyId:'p',exitCode:23}})+'\n');
  assert.equal((await client.paneState('p')).exited,true,'the explicit exit is retained before restart');
  client.request=async()=>{throw Error('host refused the replacement spawn');};
  await assert.rejects(client.spawn({ptyId:'p',command:'true',cwd:process.cwd(),cols:80,rows:24}),/refused the replacement spawn/);
  assert.equal((await client.paneState('p')).exited,false,'a failed new start is not the prior process exit');
 }finally{client.dispose();}
});

test('a spawn-failed host event clears retained exit evidence',async()=>{
 const client=new PtyHostClient('unused');client.readExistingSnapshot=async()=>null;
 try{
  client.onData(JSON.stringify({type:'event',event:{type:'exit',ptyId:'p',exitCode:23}})+'\n');
  assert.equal((await client.paneState('p')).exited,true);
  client.onData(JSON.stringify({type:'event',event:{type:'spawn-failed',ptyId:'p',reason:'command-not-found',detail:'missing'}})+'\n');
  assert.equal((await client.paneState('p')).exited,false,'spawn-failed does not preserve an old process exit');
 }finally{client.dispose();}
});
