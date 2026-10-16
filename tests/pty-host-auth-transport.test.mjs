import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {HostSocketAuthenticator,HostAuthPrincipal,authenticateHostSocket,HOST_AUTH_PENDING_CONNECTIONS}=require('../dist-electron/pty-host-auth-transport.js');
const {ownerProcessStartIdentity}=require('../dist-electron/pty-owner-client.js');
const key=Buffer.alloc(32,9),host={pid:101,startIdentity:'1:2'},client={pid:202,startIdentity:'3:4'};
async function until(check){const deadline=Date.now()+2000;while(!check()){assert.ok(Date.now()<deadline,'bounded condition');await new Promise(r=>setTimeout(r,5));}}
async function fixture(fn,options={}){
 await fs.mkdir('test-results',{recursive:true});const dir=await fs.mkdtemp(path.resolve('test-results/auth-wire-'));
 const socketPath=path.join(dir,'sock'),sockets=new Set(),received=[],failures=[],accepted=[];
 const auth=new HostSocketAuthenticator(key,options.ownPeer??host,options.authorize??(()=>{}),options.realPeer?undefined:options.readPeer??(()=>client));
 const server=net.createServer(socket=>{
  sockets.add(socket);socket.once('close',()=>sockets.delete(socket));
  void auth.accept(socket).then(result=>{
   accepted.push(result);
   const data=chunk=>{received.push(String(chunk));socket.write('REPLY:'+chunk);};
   socket.on('data',data);if(result.buffered)data(result.buffered);
   if(options.initial)socket.write(options.initial);
   socket.resume();
  }).catch(error=>failures.push(error.code));
 });
 await new Promise(resolve=>server.listen(socketPath,resolve));
 async function connect(){const socket=net.createConnection(socketPath);sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));await once(socket,'connect');return socket;}
 try{await fn({auth,received,failures,accepted,connect,socketPath});}
 finally{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});}
}
test('real Unix stream gates dispatch and preserves initial events and bytes after authentication',()=>fixture(async({connect,received,accepted})=>{
 const socket=await connect();assert.deepEqual(accepted,[]);assert.deepEqual(received,[]);
 const result=await authenticateHostSocket(socket,key,client,()=>host);let data=result.buffered;
 socket.on('data',chunk=>data+=chunk);socket.resume();socket.write('INPUT\n');
 await until(()=>data.includes('REPLY:INPUT\n')&&data.includes('INITIAL\n'));
 assert.equal(data.match(/INITIAL/g).length,1);assert.equal(received.join(''),'INPUT\n');assert.equal(accepted.length,1);
},{initial:'INITIAL\n'}));
test('pre-auth RPC and pipelined hello/RPC are refused with zero dispatch and no initial event',()=>fixture(async({connect,received,failures,accepted})=>{
 for(const payload of ['{"id":1,"type":"shutdown"}\n','{"type":"pty-auth-hello","version":1,"nonce":"'+'a'.repeat(64)+'"}\n{"id":2,"type":"write"}\n']){
  const socket=await connect();let data='';socket.setEncoding('utf8');socket.on('data',chunk=>data+=chunk);
  const closed=once(socket,'close');socket.write(payload);await closed;
  assert.ok(!data.includes('INITIAL'));assert.ok(data.includes('authentication required'));
 }
 assert.equal(failures.length,2);assert.deepEqual(accepted,[]);assert.deepEqual(received,[]);
},{initial:'INITIAL\n'}));
test('wrong capability and a failed kernel identity probe neither authenticate nor dispatch',async()=>{
 await fixture(async({connect,received,accepted})=>{
  await assert.rejects(authenticateHostSocket(await connect(),Buffer.alloc(32,8),client,()=>host),{code:'PTY_HOST_AUTH_REQUIRED'});
  assert.deepEqual(received,[]);assert.deepEqual(accepted,[]);
 });
 await fixture(async({connect,received,accepted})=>{
  const socket=await connect();socket.resume();await once(socket,'close');assert.deepEqual(received,[]);assert.deepEqual(accepted,[]);
 },{readPeer:()=>{throw new Error('kernel identity unavailable');}});
});
test('oversized unterminated handshake is rejected before dispatch',()=>fixture(async({connect,received,accepted})=>{
 const socket=await connect(),closed=once(socket,'close');socket.resume();socket.write('x'.repeat(1025));await closed;
 assert.deepEqual(received,[]);assert.deepEqual(accepted,[]);
}));
test('pending handshake connection budget is bounded and released on close',()=>fixture(async({connect,auth,accepted})=>{
 assert.equal(HOST_AUTH_PENDING_CONNECTIONS,32);const pending=[];
 for(let i=0;i<32;i++)pending.push(await connect());await until(()=>auth.pendingConnections===32);
 const refused=await connect();await once(refused,'close');assert.equal(auth.pendingConnections,32);assert.deepEqual(accepted,[]);
 for(const socket of pending)socket.destroy();await until(()=>auth.pendingConnections===0);
 const socket=await connect();await authenticateHostSocket(socket,key,client,()=>host);socket.resume();await until(()=>accepted.length===1);
}));
test('principal takeover requires proven old-main death; bad clients cannot displace it',()=>{
 let observation='same';const principal=new HostAuthPrincipal(()=>observation),second={pid:303,startIdentity:'5:6'};
 principal.authorize(client);principal.authorize({...client});
 assert.throws(()=>principal.authorize(second),{code:'PTY_HOST_PRINCIPAL_BUSY'});
 observation='unknown';assert.throws(()=>principal.authorize(second),{code:'PTY_HOST_PRINCIPAL_BUSY'});
 observation='same';principal.authorize(client);observation='gone';principal.authorize(second);
 observation='unknown';assert.throws(()=>principal.authorize(client),{code:'PTY_HOST_PRINCIPAL_BUSY'});
 principal.authorize(second);
});
test('authorized incumbent stays usable when another proven client is refused',async()=>{
 const principal=new HostAuthPrincipal(()=> 'same');let connecting=client;
 await fixture(async({connect,received})=>{
  const first=await connect(),r=await authenticateHostSocket(first,key,client,()=>host);let data=r.buffered;
  first.on('data',chunk=>data+=chunk);first.resume();
  connecting={pid:303,startIdentity:'5:6'};
  await assert.rejects(authenticateHostSocket(await connect(),key,connecting,()=>host),{code:'PTY_HOST_PRINCIPAL_BUSY'});
  first.write('INCUMBENT\n');await until(()=>data.includes('REPLY:INCUMBENT\n'));
  assert.equal(received.join(''),'INCUMBENT\n');
 },{authorize:peer=>principal.authorize(peer),readPeer:()=>connecting});
});
test('a silent unauthenticated connection expires without holding a recipient slot', {timeout:15000},()=>fixture(async({connect,auth,received,accepted})=>{
 const socket=await connect(),closed=once(socket,'close'),began=performance.now();socket.resume();await closed;
 assert.ok(performance.now()-began>=4900);assert.equal(auth.pendingConnections,0);assert.deepEqual(received,[]);assert.deepEqual(accepted,[]);
}));
test('the native bridge binds real Unix peer identities across separate processes', {timeout:15000},async()=>{
 const ownPeer={pid:process.pid,startIdentity:ownerProcessStartIdentity(process.pid)};
 assert.ok(ownPeer.startIdentity);
 await fixture(async({socketPath,accepted,received})=>{
  const source=`
   const fs=require('node:fs'),net=require('node:net');
   const {authenticateHostSocket}=require('./dist-electron/pty-host-auth-transport.js');
   const {ownerProcessStartIdentity}=require('./dist-electron/pty-owner-client.js');
   const key=fs.readFileSync(3);fs.closeSync(3);
   const socket=net.createConnection(process.argv[1]);socket.on('error',()=>{});
   socket.once('connect',()=>void authenticateHostSocket(socket,key,{pid:process.pid,startIdentity:ownerProcessStartIdentity(process.pid)})
    .then(({buffered})=>{if(buffered)throw Error('unexpected');socket.on('data',chunk=>{if(String(chunk)==='REPLY:NATIVE\\n'){process.stdout.write('AUTH_OK');socket.end();}});socket.resume();socket.write('NATIVE\\n');})
    .catch(()=>process.exit(2)));
  `;
  const child=spawn(process.execPath,['-e',source,socketPath],{stdio:['ignore','pipe','pipe','pipe'],env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
  let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  const exited=once(child,'exit');child.stdio[3].end(key);
  try{const [code]=await exited;assert.equal(code,0,stderr);assert.equal(stdout,'AUTH_OK');assert.equal(accepted.length,1);assert.equal(accepted[0].peer.pid,child.pid);assert.notEqual(child.pid,process.pid);assert.equal(received.join(''),'NATIVE\n');}
  finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
 },{realPeer:true,ownPeer});
});

test('principal busy is visible only after a valid capability proof and permits later proven takeover',async()=>{
 let observation='unknown';const principal=new HostAuthPrincipal(()=>observation);principal.authorize({pid:303,startIdentity:'5:6'});
 await fixture(async({connect,received,accepted})=>{
  await assert.rejects(authenticateHostSocket(await connect(),Buffer.alloc(32,8),client,()=>host),{code:'PTY_HOST_AUTH_REQUIRED'});
  for(const state of ['same','unknown']){observation=state;await assert.rejects(authenticateHostSocket(await connect(),key,client,()=>host),{code:'PTY_HOST_PRINCIPAL_BUSY'});}
  assert.deepEqual(received,[]);assert.deepEqual(accepted,[]);
  observation='gone';const socket=await connect();await authenticateHostSocket(socket,key,client,()=>host);socket.resume();socket.write('TAKEN_OVER\n');await until(()=>received.join('')==='TAKEN_OVER\n');
 },{authorize:peer=>principal.authorize(peer)});
});
