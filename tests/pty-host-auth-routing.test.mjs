import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {once} from 'node:events';
import {HostSocketAuthenticator,HostAuthPrincipal,authenticateHostSocket} from '../dist-electron/pty-host-auth-transport.js';
import {HostAuthTransfer} from '../dist-electron/pty-host-auth-transfer.js';
import {redeemHostCapability} from '../dist-electron/pty-host-auth-redemption.js';
import {HostAuthClient} from '../dist-electron/pty-host-auth.js';
const key=Buffer.alloc(32,7),issuer={pid:101,startIdentity:'10:1'},host={pid:102,startIdentity:'10:2'},recipient={pid:103,startIdentity:'10:3'},nonce='a'.repeat(64);
const wait=async check=>{const end=performance.now()+2000;while(!check()){assert.ok(performance.now()<end,'bounded routing condition');await new Promise(resolve=>setTimeout(resolve,2));}};
async function fixture(run){
 await fs.mkdir('test-results',{recursive:true});const root=await fs.mkdtemp(path.resolve('test-results/auth-router-')),socketPath=path.join(root,'sock'),transfer=new HostAuthTransfer(key),sockets=new Set(),events=[],received=[],results=[];
 let peer=recipient,observation='same',authorizations=0;const principal=new HostAuthPrincipal(()=>observation),auth=new HostSocketAuthenticator(key,host,p=>{authorizations++;principal.authorize(p);},()=>peer,transfer);
 const server=net.createServer(socket=>{
  sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));
  void auth.accept(socket).then(result=>{
   results.push(result);if('transferred' in result)return;
   socket.on('data',chunk=>received.push(String(chunk)));if(result.buffered)received.push(result.buffered);socket.write('INITIAL_EVENT\n');events.push(result.peer);socket.resume();
  }).catch(()=>{});
 });
 await new Promise(resolve=>server.listen(socketPath,resolve));
 const connect=async()=>{const s=net.createConnection(socketPath);s.on('error',()=>{});sockets.add(s);s.once('close',()=>sockets.delete(s));await once(s,'connect');return s;};
 const announce=()=>{const r=transfer.reserve(issuer,'ordinary-quit',nonce,null);transfer.activate(issuer,r.attempt);return{format:2,...r,nonce,hostPid:host.pid,hostStartIdentity:host.startIdentity};};
 try{await run({auth,connect,transfer,events,received,results,announce,setPeer:p=>peer=p,setObservation:v=>observation=v,authorizations:()=>authorizations});}
 finally{for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));transfer.dispose();await fs.rm(root,{recursive:true,force:true});}
}
test('redemption never enters application dispatch/events or principal authorization; later normal proof does',()=>fixture(async f=>{
 const ticket=f.announce();assert.deepEqual(await redeemHostCapability(await f.connect(),ticket,recipient,()=>host),key);await wait(()=>f.results.length===1);
 assert.deepEqual(f.results,[{transferred:true}]);assert.deepEqual(f.events,[]);assert.deepEqual(f.received,[]);assert.equal(f.authorizations(),0);
 const socket=await f.connect(),proof=await authenticateHostSocket(socket,key,recipient,()=>host);let events=proof.buffered;socket.on('data',chunk=>events+=chunk);socket.resume();socket.write('INPUT\n');
 await wait(()=>f.received.join('')==='INPUT\n'&&events.includes('INITIAL_EVENT'));assert.equal(f.authorizations(),1);assert.equal(f.events.length,1);
}));
test('recipient with redeemed key stays principal-busy until the old main is proven gone',()=>fixture(async f=>{
 f.setPeer(issuer);const incumbent=await f.connect();await authenticateHostSocket(incumbent,key,issuer,()=>host);incumbent.resume();
 const ticket=f.announce();f.setPeer(recipient);assert.deepEqual(await redeemHostCapability(await f.connect(),ticket,recipient,()=>host),key);
 await assert.rejects(authenticateHostSocket(await f.connect(),key,recipient,()=>host),{code:'PTY_HOST_PRINCIPAL_BUSY'});
 f.setObservation('unknown');await assert.rejects(authenticateHostSocket(await f.connect(),key,recipient,()=>host),{code:'PTY_HOST_PRINCIPAL_BUSY'});assert.equal(f.events.length,1);
 f.setObservation('gone');const next=await f.connect();await authenticateHostSocket(next,key,recipient,()=>host);next.resume();await wait(()=>f.events.length===2);
}));
test('normal and redemption handshakes share one aggregate32 pending connection budget',()=>fixture(async f=>{
 const ticket=f.announce(),pending=[];for(let n=0;n<32;n++)pending.push(await f.connect());await wait(()=>f.auth.pendingConnections===32);
 const rejected=await f.connect();await assert.rejects(redeemHostCapability(rejected,ticket,recipient,()=>host));assert.equal(f.transfer.phase,'active');assert.equal(f.auth.pendingConnections,32);assert.equal(f.events.length,0);
 pending.pop().destroy();await wait(()=>f.auth.pendingConnections===31);assert.deepEqual(await redeemHostCapability(await f.connect(),ticket,recipient,()=>host),key);await wait(()=>f.auth.pendingConnections===31);assert.equal(f.events.length,0);
}));
test('coalesced redemption/RPC suffix is refused before commitment; wrong nonce cannot dispatch',()=>fixture(async f=>{
 const ticket=f.announce();let socket=await f.connect(),data='';socket.on('data',chunk=>data+=chunk);const closed=once(socket,'close');
 const hello=JSON.stringify({type:'pty-transfer-redeem',version:1,attempt:ticket.attempt,purpose:ticket.purpose,deadline:ticket.deadline,nonce:ticket.nonce,clientNonce:'b'.repeat(64),hostPid:host.pid,hostStartIdentity:host.startIdentity});
 socket.write(hello+'\n'+JSON.stringify({id:1,type:'shutdown'})+'\n');await closed;assert.ok(!data.includes('pty-transfer-credential'));assert.equal(f.transfer.phase,'active');assert.deepEqual(f.received,[]);assert.equal(f.events.length,0);
 socket=await f.connect();await assert.rejects(redeemHostCapability(socket,{...ticket,nonce:'f'.repeat(64)},recipient,()=>host));assert.equal(f.transfer.phase,'sealed');assert.equal(f.events.length,0);
}));
test('the first-frame wait and normal proof share a single five-second deadline',{timeout:9000},()=>fixture(async f=>{
 const socket=await f.connect(),client=new HostAuthClient(key,host,recipient),start=performance.now();let challenge='';socket.on('data',chunk=>challenge+=chunk);const closed=once(socket,'close');socket.write(client.hello.slice(0,20));
 // This delay deliberately consumes the opening-frame budget, not readiness.
 await new Promise(resolve=>setTimeout(resolve,2500));socket.write(client.hello.slice(20)+'\n');await wait(()=>challenge.includes('pty-auth-challenge'));await closed;
 const elapsed=performance.now()-start;assert.ok(elapsed>=4500&&elapsed<6500,`single accept budget: ${elapsed}ms`);assert.equal(f.events.length,0);assert.deepEqual(f.received,[]);
}));
test('valid proof and authorization cannot outlive the original accept deadline',{timeout:4000},async()=>{
 const {EventEmitter}=await import('node:events'),{HostAuthServer}=await import('../dist-electron/pty-host-auth.js');
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'performance'),original=HostAuthServer.prototype.receive;
 try{
  for(const boundary of ['proof','authorize','handoff']){
   let now=0,authorizations=0;const frames=[];
   Object.defineProperty(globalThis,'performance',{configurable:true,value:{now:()=>now}});
   const client=new HostAuthClient(key,host,recipient,()=>now);
   class Socket extends EventEmitter{
    destroyed=false;writable=true;writableEnded=false;
    setEncoding(){return this;}pause(){return this;}resume(){return this;}
    destroy(){if(!this.destroyed){this.destroyed=true;this.emit('close');}return this;}
    end(line,callback){this.writableEnded=true;if(line)frames.push(String(line));callback?.();return this;}
    write(line){frames.push(String(line));if(JSON.parse(line).type==='pty-auth-challenge'){const proof=client.receive(String(line).trim());now=4900;queueMicrotask(()=>this.emit('data',proof+'\n'));}return true;}
   }
   HostAuthServer.prototype.receive=function(line){const response=original.call(this,line);if(boundary==='proof'&&this.authenticated)now=5000;return response;};
   const auth=new HostSocketAuthenticator(key,host,()=>{authorizations++;if(boundary==='authorize')now=6000;if(boundary==='handoff')queueMicrotask(()=>now=6000);},()=>recipient),socket=new Socket();
   const outcome=auth.accept(socket).then(()=>true,error=>{assert.equal(error.code,'PTY_HOST_AUTH_REQUIRED');return false;});
   socket.emit('data',client.hello+'\n');assert.equal(await outcome,false,`${boundary} must refuse late success`);
   assert.equal(authorizations,boundary==='proof'?0:1);
   if(boundary!=='handoff')assert.equal(frames.some(line=>line.includes('pty-auth-ready')),false,'no ready proof is sent after the budget');
   assert.equal(socket.destroyed,true);assert.equal(auth.pendingConnections,0);
  }
 }finally{HostAuthServer.prototype.receive=original;Object.defineProperty(globalThis,'performance',descriptor);}
});
