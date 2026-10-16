import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createHash,createHmac} from 'node:crypto';
import {HostAuthTransfer} from '../dist-electron/pty-host-auth-transfer.js';
import {HostRedemptionServer,HostRedemptionClient,acceptHostRedemption,redeemHostCapability,AUTH_REDEMPTION_BYTES,AUTH_REDEMPTION_MS} from '../dist-electron/pty-host-auth-redemption.js';
import {ownerProcessStartIdentity} from '../dist-electron/pty-owner-client.js';
const key=Buffer.alloc(32,7),issuer={pid:101,startIdentity:'10:1'},host={pid:102,startIdentity:'10:2'},recipient={pid:103,startIdentity:'10:3'},nonce='a'.repeat(64);
function pair(){let mono=0;const transfer=new HostAuthTransfer(key),reservation=transfer.reserve(issuer,'ordinary-quit',nonce,null);transfer.activate(issuer,reservation.attempt);const ticket={format:2,...reservation,nonce,hostPid:host.pid,hostStartIdentity:host.startIdentity};return{transfer,ticket,server:new HostRedemptionServer(transfer,host,recipient,()=>mono),client:new HostRedemptionClient(ticket,host,recipient,()=>mono),setClock:value=>mono=value};}
test('credential response binds exact ticket/nonces/instance/peers and releases only once',()=>{
 const p=pair(),response=p.server.receive(p.client.hello);assert.deepEqual(p.client.receive(response),key);assert.equal(p.transfer.phase,'claimed');
 assert.throws(()=>p.server.receive(p.client.hello));assert.throws(()=>p.client.receive(response));p.transfer.dispose();
});
test('each proof field mutation refuses without accepting credential bytes',()=>{
 for(const field of ['serverNonce','instance','credential','proof']){
  const p=pair(),response=JSON.parse(p.server.receive(p.client.hello));response[field]=field==='credential'?Buffer.alloc(32,9).toString('base64'):'f'.repeat(64);
  assert.throws(()=>p.client.receive(JSON.stringify(response)));p.transfer.dispose();
 }
});
test('another connection, recipient instance or purpose cannot reuse a valid response',()=>{
 for(const mutation of [{},{client:{...recipient,pid:104}},{client:{...recipient,startIdentity:'10:4'}},{ticket:{purpose:'planned-update',deadline:Date.now()+120000}}]){
  const p=pair(),other=new HostRedemptionClient({...p.ticket,...mutation.ticket},host,mutation.client??recipient),response=p.server.receive(p.client.hello);
  assert.throws(()=>other.receive(response));p.transfer.dispose();
 }
 const p=pair();for(const changed of [{...host,pid:105},{...host,startIdentity:'10:9'}])assert.throws(()=>new HostRedemptionClient(p.ticket,changed,recipient));assert.equal(p.transfer.phase,'active');p.transfer.dispose();
});
test('unannounced, wrong nonce and expiry refuse; wrong nonce seals the window',()=>{
 const p=pair(),wrong={...JSON.parse(p.client.hello),nonce:'f'.repeat(64)};assert.throws(()=>p.server.receive(JSON.stringify(wrong)));assert.equal(p.transfer.phase,'sealed');
 assert.throws(()=>new HostRedemptionServer(new HostAuthTransfer(key),host,recipient).receive(p.client.hello));p.transfer.dispose();
 const q=pair();q.setClock(AUTH_REDEMPTION_MS);assert.throws(()=>q.server.receive(q.client.hello));assert.equal(q.transfer.phase,'active','handshake expiry must not release credentials');q.transfer.dispose();
});
test('valid late reply at the monotonic deadline is refused without relying on timer callback',()=>{
 const p=pair(),response=p.server.receive(p.client.hello);p.setClock(AUTH_REDEMPTION_MS);assert.throws(()=>p.client.receive(response));assert.throws(()=>p.client.receive(response));p.transfer.dispose();
});
test('closed frame schema and byte caps refuse malformed/RPC input without key release',()=>{
 assert.equal(AUTH_REDEMPTION_BYTES,1024);assert.equal(AUTH_REDEMPTION_MS,5000);
 for(const raw of ['null','[]','{"type":"version","id":1}','{"secret":"PRIVATE_SENTINEL",}', ' '.repeat(1025)]){
  const p=pair();assert.throws(()=>p.server.receive(raw),error=>error.message==='Terminal host credential transfer refused'&&!String(error).includes('PRIVATE_SENTINEL'));assert.equal(p.transfer.phase,'active');p.transfer.dispose();
 }
 for(const change of [{extra:true},{version:2},{purpose:'unrelated'},{hostPid:999},{hostStartIdentity:'10:9'}]){
  const p=pair();assert.throws(()=>p.server.receive(JSON.stringify({...JSON.parse(p.client.hello),...change})));assert.equal(p.transfer.phase,'active');p.transfer.dispose();
 }
});
async function listening(server,socket){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});}
async function connect(socket){const s=net.createConnection(socket);await new Promise((resolve,reject)=>{s.once('connect',resolve);s.once('error',reject);});return s;}
test('real kernel peers: simultaneous distinct processes get exactly one credential recipient',{timeout:12000},async()=>{
 fs.mkdirSync('test-results',{recursive:true});const root=fs.mkdtempSync(path.resolve('test-results/auth-redemption-')),socket=path.join(root,'host.sock');
 const transfer=new HostAuthTransfer(key),reservation=transfer.reserve(issuer,'ordinary-quit',nonce,null),own={pid:process.pid,startIdentity:ownerProcessStartIdentity(process.pid)};transfer.activate(issuer,reservation.attempt);
 const ticket={format:2,...reservation,nonce,hostPid:own.pid,hostStartIdentity:own.startIdentity},children=[],connections=new Set();
 const server=net.createServer(s=>{connections.add(s);s.on('close',()=>connections.delete(s));void acceptHostRedemption(s,transfer,own).catch(()=>{});});
 try{
  await listening(server,socket);
  const run=()=>new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,['tests/helpers/pty-host-auth-redemption.cjs'],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['pipe','ignore','pipe','ipc']});children.push(child);let message,stderr='';child.on('message',m=>message=m);child.stderr.on('data',b=>stderr+=b);child.once('error',reject);child.once('exit',code=>code===0&&message?resolve(message):reject(Error(`redemption child failed:${code}:${stderr}`)));child.stdin.end(JSON.stringify({socket,ticket}));
  });
  const results=await Promise.all([run(),run()]);assert.notEqual(results[0].pid,results[1].pid);const successes=results.filter(r=>r.success);assert.equal(successes.length,1);assert.equal(successes[0].hash,createHash('sha256').update(key).digest('hex'));assert.equal(transfer.phase,'claimed');
  assert.throws(()=>transfer.reserve(issuer,'ordinary-quit','b'.repeat(64),null),'lost reply/second request cannot rearm');
 }finally{for(const child of children)if(child.exitCode===null)child.kill('SIGKILL');for(const s of connections)s.destroy();await new Promise(resolve=>server.close(resolve));transfer.dispose();fs.rmSync(root,{recursive:true,force:true});}
});
test('real socket target mismatch sends no nonce',{timeout:8000},async()=>{
 fs.mkdirSync('test-results',{recursive:true});const root=fs.mkdtempSync(path.resolve('test-results/auth-redemption-refuse-')),socket=path.join(root,'host.sock'),p=pair();let bytes='';const sockets=new Set();
 const server=net.createServer(s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));s.on('data',b=>bytes+=b);});
 try{
  await listening(server,socket);const s=await connect(socket);
  await assert.rejects(redeemHostCapability(s,p.ticket,recipient,()=>({...host,pid:999})));assert.equal(bytes,'');assert.equal(p.transfer.phase,'active');
  await new Promise(resolve=>server.close(()=>resolve()));
 }finally{for(const s of sockets)s.destroy();server.close();p.transfer.dispose();fs.rmSync(root,{recursive:true,force:true});}
});
test('pipelined ordinary RPC is refused without a credential or application dispatch',{timeout:8000},async()=>{
 fs.mkdirSync('test-results',{recursive:true});const root=fs.mkdtempSync(path.resolve('test-results/auth-redemption-pipeline-')),socket=path.join(root,'host.sock'),p=pair(),sockets=new Set();
 const server=net.createServer(s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));void acceptHostRedemption(s,p.transfer,host,()=>recipient).catch(()=>{});});
 try{
  await listening(server,socket);const s=await connect(socket);let response='';s.on('data',b=>response+=b);
  const closed=new Promise(resolve=>s.once('close',resolve));s.write(p.client.hello+'\n'+JSON.stringify({id:1,type:'write',ptyId:'p',data:'BAD'})+'\n');await closed;
  assert.equal(response,'');assert.equal(p.transfer.phase,'active');
 }finally{for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));p.transfer.dispose();fs.rmSync(root,{recursive:true,force:true});}
});
test('lost credential response commits only one recipient and cannot be retried',{timeout:8000},async()=>{
 fs.mkdirSync('test-results',{recursive:true});const root=fs.mkdtempSync(path.resolve('test-results/auth-redemption-lost-')),socket=path.join(root,'host.sock'),p=pair(),sockets=new Set();let dropped=0;
 const server=net.createServer(s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));s.end=()=>{dropped++;s.destroy();return s;};void acceptHostRedemption(s,p.transfer,host,()=>recipient).catch(()=>{});});
 try{
  await listening(server,socket);const s=await connect(socket);await assert.rejects(redeemHostCapability(s,p.ticket,recipient,()=>host));assert.equal(dropped,1);assert.equal(p.transfer.phase,'claimed');
  const next=await connect(socket);await assert.rejects(redeemHostCapability(next,p.ticket,recipient,()=>host));assert.equal(dropped,1);assert.equal(p.transfer.phase,'claimed');
 }finally{for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));p.transfer.dispose();fs.rmSync(root,{recursive:true,force:true});}
});
test('malformed nonce and a different active attempt also close the one-use window',()=>{
 for(const change of [{nonce:'bad'},{nonce:7},{attempt:'e'.repeat(64)},{purpose:'planned-update'},{deadline:Date.now()+1000}]){
  const p=pair();assert.throws(()=>p.server.receive(JSON.stringify({...JSON.parse(p.client.hello),...change})));assert.equal(p.transfer.phase,'sealed');p.transfer.dispose();
 }
});
test('fragmented credential response is accepted; oversized request closes promptly',{timeout:8000},async()=>{
 fs.mkdirSync('test-results',{recursive:true});const root=fs.mkdtempSync(path.resolve('test-results/auth-redemption-fragment-')),socket=path.join(root,'host.sock'),p=pair(),sockets=new Set();
 const server=net.createServer(s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));s.on('error',()=>{});let raw='';s.on('data',b=>{raw+=b;if(!raw.includes('\n'))return;const response=p.server.receive(raw.trim())+'\n';s.write(response.slice(0,20));setImmediate(()=>s.end(response.slice(20)));});});
 try{
  await listening(server,socket);assert.deepEqual(await redeemHostCapability(await connect(socket),p.ticket,recipient,()=>host),key);
 }finally{for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));p.transfer.dispose();fs.rmSync(root,{recursive:true,force:true});}
 const q=pair(),otherRoot=fs.mkdtempSync(path.resolve('test-results/auth-redemption-oversize-')),otherSocket=path.join(otherRoot,'host.sock'),connections=new Set();
 const rejectServer=net.createServer(s=>{connections.add(s);s.on('close',()=>connections.delete(s));void acceptHostRedemption(s,q.transfer,host,()=>recipient).catch(()=>{});});
 try{
  await listening(rejectServer,otherSocket);const s=await connect(otherSocket),start=performance.now(),closed=new Promise(resolve=>s.once('close',resolve));let received='';s.on('data',b=>received+=b);s.write(' '.repeat(1025));await closed;assert.ok(performance.now()-start<1000);assert.equal(received,'');assert.equal(q.transfer.phase,'active');
 }finally{for(const s of connections)s.destroy();await new Promise(resolve=>rejectServer.close(resolve));q.transfer.dispose();fs.rmSync(otherRoot,{recursive:true,force:true});}
});
test('stalled redemption has a whole exchange deadline on both server and client',{timeout:14000},async()=>{
 for(const side of ['server','client']){
  fs.mkdirSync('test-results',{recursive:true});const root=fs.mkdtempSync(path.resolve('test-results/auth-redemption-stall-')),socket=path.join(root,'host.sock'),p=pair(),sockets=new Set();
  const server=net.createServer(s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));if(side==='server')void acceptHostRedemption(s,p.transfer,host,()=>recipient).catch(()=>{});else s.on('data',()=>{});});
  try{
   await listening(server,socket);const s=await connect(socket),start=performance.now();
   if(side==='server')await new Promise(resolve=>s.once('close',resolve));else await assert.rejects(redeemHostCapability(s,p.ticket,recipient,()=>host));
   const elapsed=performance.now()-start;assert.ok(elapsed>=4500&&elapsed<6500,`bounded ${side} exchange: ${elapsed}ms`);assert.equal(p.transfer.phase,'active');
  }finally{for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));p.transfer.dispose();fs.rmSync(root,{recursive:true,force:true});}
 }
});
test('fragmented maximum-size request is read once before a credential response',{timeout:8000},async()=>{
 fs.mkdirSync('test-results',{recursive:true});const root=fs.mkdtempSync(path.resolve('test-results/auth-redemption-request-')),socket=path.join(root,'host.sock'),p=pair(),sockets=new Set();
 const server=net.createServer(s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));void acceptHostRedemption(s,p.transfer,host,()=>recipient).catch(()=>{});});
 try{
  await listening(server,socket);const s=await connect(socket),request=p.client.hello.padEnd(1024,' ')+'\n';let response='';s.on('data',b=>response+=b);const closed=new Promise(resolve=>s.once('close',resolve));
  s.write(request.slice(0,30));await new Promise(resolve=>setImmediate(resolve));assert.equal(p.transfer.phase,'active');s.write(request.slice(30));await closed;
  assert.deepEqual(p.client.receive(response.trimEnd()),key);assert.equal(p.transfer.phase,'claimed');
 }finally{for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));p.transfer.dispose();fs.rmSync(root,{recursive:true,force:true});}
});
test('a later-chunk RPC after a valid redemption gets no second response or parser',{timeout:8000},async()=>{
 fs.mkdirSync('test-results',{recursive:true});const root=fs.mkdtempSync(path.resolve('test-results/auth-redemption-split-')),socket=path.join(root,'host.sock'),p=pair(),sockets=new Set();let accepted,release,endCalls=0;
 const server=net.createServer(s=>{accepted=s;sockets.add(s);s.on('close',()=>sockets.delete(s));const end=s.end.bind(s);s.end=(...args)=>{endCalls++;release=()=>end(...args);return s;};void acceptHostRedemption(s,p.transfer,host,()=>recipient).catch(()=>{});});
 try{
  await listening(server,socket);const s=await connect(socket);let response='';s.on('data',b=>response+=b);const closed=new Promise(resolve=>s.once('close',resolve));s.write(p.client.hello+'\n');
  const deadline=performance.now()+2000;while(!release){assert.ok(performance.now()<deadline);await new Promise(resolve=>setImmediate(resolve));}
  assert.equal(p.transfer.phase,'claimed');assert.equal(accepted.listenerCount('data'),0,'neither credential nor application parser remains after one valid frame');
  await new Promise((resolve,reject)=>s.write(JSON.stringify({id:2,type:'shutdown'})+'\n',error=>error?reject(error):resolve()));
  accepted.resume();await new Promise(resolve=>setImmediate(resolve));release();await closed;
  assert.equal(endCalls,1);assert.equal(response.trimEnd().split('\n').length,1);assert.deepEqual(p.client.receive(response.trimEnd()),key);
 }finally{for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));p.transfer.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('wire proof MACs the independently recomputed random capability digest and full transcript',()=>{
 const p=pair(),hello=JSON.parse(p.client.hello),response=JSON.parse(p.server.receive(p.client.hello));
 const digest=createHash('sha256').update(Buffer.from(response.credential,'base64')).digest('hex');
 const input=['aya-pty-host-transfer',1,'credential-digest',p.ticket.attempt,p.ticket.purpose,p.ticket.deadline,hello.clientNonce,response.serverNonce,response.instance,host.pid,host.startIdentity,recipient.pid,recipient.startIdentity,digest];
 assert.equal(response.proof,createHmac('sha256',Buffer.from(nonce,'hex')).update(JSON.stringify(input)).digest('hex'));
 assert.equal(input.includes(response.credential),false);assert.deepEqual(p.client.receive(JSON.stringify(response)),key);p.transfer.dispose();
});

test('null deadline is purpose-bound in client validation and credential MAC',()=>{
 const p=pair(),response=p.server.receive(p.client.hello);
 for(const ticket of [{...p.ticket,purpose:'planned-update'},{...p.ticket,deadline:Date.now()+120000}])assert.throws(()=>new HostRedemptionClient(ticket,host,recipient));
 // A valid finite planned ticket cannot accept the ordinary-null transcript.
 const other=new HostRedemptionClient({...p.ticket,purpose:'planned-update',deadline:Date.now()+120000},host,recipient);other.clientNonce=p.client.clientNonce;assert.equal(other.clientNonce,p.client.clientNonce);
 assert.throws(()=>other.receive(response));p.transfer.dispose();
});
