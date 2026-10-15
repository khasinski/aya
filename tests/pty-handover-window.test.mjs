import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {HandoverWindow,handoverPeer}=require('../dist-electron/pty-handover-window.js');
const {readHandoverTicket,writeHandoverTicket}=require('../dist-electron/pty-handover-ticket.js');
const {ownerProcessStartIdentity}=require('../dist-electron/pty-owner-client.js');
const nonce='a'.repeat(64),announcer={pid:100,startIdentity:'1:2'},recipient={pid:200,startIdentity:'3:4'};
test('only an announced unexpired handover succeeds, exactly once',()=>{
 let now=1000;const w=new HandoverWindow(()=>now);
 assert.throws(()=>w.consume(nonce,recipient),/refused/);
 w.announce(nonce,121000,announcer);assert.deepEqual(w.consume(nonce,recipient),recipient);
 assert.deepEqual(w.transferredTo,recipient);assert.throws(()=>w.consume(nonce,recipient),/refused/);
 assert.throws(()=>w.announce(nonce,121000,announcer),/refused/);
 now=2000;assert.deepEqual(w.transferredTo,recipient);
});
test('a wrong nonce permanently ends the window; deadline expiry refuses',()=>{
 let now=1000;const wrong=new HandoverWindow(()=>now);wrong.announce(nonce,2000,announcer);
 assert.throws(()=>wrong.consume('b'.repeat(64),recipient),/refused/);assert.throws(()=>wrong.consume(nonce,recipient),/refused/);assert.equal(wrong.transferredTo,null);
 const expired=new HandoverWindow(()=>now);expired.announce(nonce,2000,announcer);now=2000;assert.throws(()=>expired.consume(nonce,recipient),/refused/);
});
test('peer or deadline failures close the attempt and only the announcer can cancel an unused window',()=>{
 const w=new HandoverWindow(()=>1000);w.announce(nonce,2000,announcer);w.cancel(recipient);assert.deepEqual(w.consume(nonce,recipient),recipient);
 const canceled=new HandoverWindow(()=>1000);canceled.announce(nonce,2000,announcer);canceled.cancel(announcer);assert.throws(()=>canceled.consume(nonce,recipient),/refused/);
 for(const deadline of [1000,121001,NaN])assert.throws(()=>new HandoverWindow(()=>1000).announce(nonce,deadline,announcer),/refused/);
 const bad=new HandoverWindow(()=>1000);bad.announce(nonce,2000,announcer);assert.throws(()=>bad.consume(nonce,{pid:2,startIdentity:''}),/refused/);assert.throws(()=>bad.consume(nonce,recipient),/refused/);
});
async function home(fn){await fs.mkdir('test-results',{recursive:true});const dir=await fs.mkdtemp(path.resolve('test-results/handover-'));try{await fn(dir);}finally{await fs.rm(dir,{recursive:true,force:true});}}
test('nonce ticket is private, contains no credential, is read once, and expired/invalid payloads are consumed',()=>home(async(dir)=>{
 const file=path.join(dir,'ticket'),ticket={nonce,deadline:2000,hostPid:300,hostStartIdentity:'5:6'};
 writeHandoverTicket(file,ticket,1000);assert.equal((await fs.stat(file)).mode&0o777,0o600);
 assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(file))).sort(),['deadline','hostPid','hostStartIdentity','nonce']);
 assert.deepEqual(readHandoverTicket(file,1000),ticket);assert.equal(readHandoverTicket(file,1000),null);
 writeHandoverTicket(file,ticket,1000);assert.throws(()=>readHandoverTicket(file,2000),/Expired/);assert.equal(readHandoverTicket(file,2000),null);
 await fs.writeFile(file,'{}',{mode:0o600});assert.throws(()=>readHandoverTicket(file,1000),/invalid/);assert.equal(readHandoverTicket(file),null);
}));
test('kernel Unix peer identity is the connected child, with its real start identity',()=>home(async(dir)=>{
 const socketPath=path.join(dir,'peer.sock'),server=net.createServer();let child,socket;
 try{
  const listening=once(server,'listening');server.listen(socketPath);await listening;
  const connected=once(server,'connection');child=spawn(process.execPath,['-e',`require('net').createConnection(process.argv[1]).on('error',()=>process.exit(2));`,socketPath],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:'ignore'});
  [socket]=await connected;
  assert.deepEqual(handoverPeer(socket),{pid:child.pid,startIdentity:ownerProcessStartIdentity(child.pid)});
  assert.notEqual(handoverPeer(socket).pid,process.pid);
 }finally{socket?.destroy();if(child){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}await new Promise(resolve=>server.close(resolve));}
}));
