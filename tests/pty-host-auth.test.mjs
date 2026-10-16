import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {HostAuthServer,HostAuthClient,HOST_AUTH_TIMEOUT_MS,HOST_AUTH_FRAME_BYTES}=require('../dist-electron/pty-host-auth.js');
const key=Buffer.alloc(32,7),host={pid:101,startIdentity:'100:2'},client={pid:202,startIdentity:'200:3'},instance='a'.repeat(64);
function pair(options={}) {
 const server=new HostAuthServer(options.serverKey??key,host,client,options.instance??instance,options.clock);
 const customer=new HostAuthClient(options.clientKey??key,options.host??host,options.client??client,options.clock);
 return {server,customer};
}
function exchange(server,customer) {
 const challenge=server.receive(customer.hello);
 const response=customer.receive(challenge);
 assert.equal(server.authenticated,false);assert.equal(customer.authenticated,false);
 const ready=server.receive(response);assert.equal(server.authenticated,true);
 assert.equal(customer.receive(ready),null);assert.equal(customer.authenticated,true);
 return {challenge,response,ready};
}
test('mutual proofs complete only after their matching transcript and final ready proof',()=>{
 const {server,customer}=pair();exchange(server,customer);
 assert.throws(()=>server.receive(customer.hello),/authentication required/);
 assert.throws(()=>customer.receive('{}'),/authentication required/);
});
test('a foreign-home capability fails server proof before a client proof is released',()=>{
 const {server,customer}=pair({clientKey:Buffer.alloc(32,8)});
 assert.throws(()=>customer.receive(server.receive(customer.hello)),/authentication required/);
 assert.equal(server.authenticated,false);assert.equal(customer.authenticated,false);
});
test('kernel peer PID and start identity are bound in both directions',()=>{
 for(const changed of [{host:{...host,pid:102}},{host:{...host,startIdentity:'100:9'}},{client:{...client,pid:203}},{client:{...client,startIdentity:'200:9'}}]){
  const {server,customer}=pair(changed);
  assert.throws(()=>customer.receive(server.receive(customer.hello)),/authentication required/);
 }
});
test('client proofs cannot be replayed on another connection or host instance',()=>{
 const first=pair(),{response}=exchange(first.server,first.customer);
 for(const otherInstance of [instance,'b'.repeat(64)]){
  const next=pair({instance:otherInstance});next.server.receive(next.customer.hello);
  assert.throws(()=>next.server.receive(response),/authentication required/);
  assert.equal(next.server.authenticated,false);
 }
});
test('server proof cannot reflect as a client proof; final server ready proof is required',()=>{
 const {server,customer}=pair(),challenge=JSON.parse(server.receive(customer.hello));
 const response=customer.receive(JSON.stringify(challenge));
 assert.throws(()=>server.receive(JSON.stringify({type:'pty-auth-proof',proof:challenge.proof})),/authentication required/);
 assert.throws(()=>server.receive(response),/authentication required/);
 const other=pair(),c=other.server.receive(other.customer.hello);other.customer.receive(c);
 assert.throws(()=>other.customer.receive(JSON.stringify({type:'pty-auth-ready',proof:JSON.parse(c).proof})),/authentication required/);
});
test('whole-handshake deadline includes both phases, and expiry cannot be retried',()=>{
 assert.equal(HOST_AUTH_TIMEOUT_MS,5000);let now=0;
 const {server,customer}=pair({clock:()=>now});now=4999;
 const response=customer.receive(server.receive(customer.hello));now=5000;
 assert.throws(()=>server.receive(response),/authentication required/);
 assert.throws(()=>customer.receive(JSON.stringify({type:'pty-auth-ready',proof:'a'.repeat(64)})),/authentication required/);
 now=0;assert.throws(()=>server.receive(response),/authentication required/);
});
test('RPC, malformed, oversized, extra fields and unsupported auth versions fail closed without exposing secrets',()=>{
 assert.equal(HOST_AUTH_FRAME_BYTES,1024);
 for(const line of ['{','null','[]',JSON.stringify({id:1,type:'shutdown'}),' '.repeat(1025),JSON.stringify({type:'pty-auth-hello',version:2,nonce:'a'.repeat(64)}),JSON.stringify({type:'pty-auth-hello',version:1,nonce:'a'.repeat(64),key:key.toString('hex')})]){
  const {server,customer}=pair();assert.throws(()=>server.receive(line),error=>{
   assert.equal(error.message,'Terminal host authentication required');assert.equal(error.code,'PTY_HOST_AUTH_REQUIRED');return true;
  });assert.equal(server.authenticated,false);assert.throws(()=>server.receive(customer.hello),/authentication required/);
 }
});
test('unsupported key length, identity or instance never creates a session',()=>{
 assert.throws(()=>new HostAuthServer(Buffer.alloc(31),host,client,instance),/authentication required/);
 assert.throws(()=>new HostAuthClient(key,{...host,startIdentity:''},client),/authentication required/);
 assert.throws(()=>new HostAuthServer(key,host,{...client,pid:1},instance),/authentication required/);
 assert.throws(()=>new HostAuthServer(key,host,client,'bad'),/authentication required/);
});
