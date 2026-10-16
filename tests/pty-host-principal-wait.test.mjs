import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {PtyHostClient}=require('../dist-electron/pty-host-client.js');
const {HostPrincipalBusyError,HOST_PRINCIPAL_BUSY_REASON}=require('../dist-electron/pty-host-auth.js');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t){
 t.mock.timers.enable({apis:['Date','setTimeout']});
 const client=new PtyHostClient('unused'),events=[],sent=[];
 client.attachWebContents({isDestroyed:()=>false,send:(_channel,event)=>events.push(...(Array.isArray(event)?event:[event]))});
 client.sendRequest=async(_socket,request)=>{sent.push(request);return true;};
 let allow=false,attempts=0;
 client.connect=async()=>{attempts++;if(!allow){client.principalBusyPeer={pid:123,startIdentity:'1:2'};throw new HostPrincipalBusyError();}client.socket={destroyed:false,destroy(){this.destroyed=true;}};};
 t.after(()=>{client.dispose();client.dropSocket();});
 return {client,events,sent,allow:()=>{allow=true;},attempts:()=>attempts};
}
const req={ptyId:'p',command:'cat',cwd:process.cwd(),cols:80,rows:24,attachIfReused:true};
test('principal acquisition waits once, keeps input disconnected, then attaches without host creation',async t=>{
 const f=fixture(t);f.client.reusedHost=true;const spawn=f.client.spawn(req);await flush();
 assert.equal(f.attempts(),1);assert.deepEqual(f.sent,[]);
 assert.ok(f.events.some(e=>e.type==='host-connection'&&!e.connected&&e.reason===HOST_PRINCIPAL_BUSY_REASON));
 t.mock.timers.tick(100);await flush();assert.equal(f.attempts(),2);
 f.allow();t.mock.timers.tick(250);await spawn;
 assert.deepEqual(f.sent.map(r=>[r.type,r.req.attachOnly]),[['spawn',true]]);
 assert.ok(f.events.some(e=>e.type==='host-connection'&&e.connected));
});
test('the whole busy wait ends after ten seconds and only a later attach retries it',async t=>{
 const f=fixture(t),spawn=f.client.spawn(req);const rejected=assert.rejects(spawn,{code:'PTY_HOST_PRINCIPAL_BUSY'});await flush();
 t.mock.timers.tick(10000);await rejected;assert.deepEqual(f.sent,[]);assert.equal(f.client.principalRetryExhausted,true);
 const attempts=f.attempts();assert.equal(await f.client.getPid('p'),undefined);assert.equal(f.attempts(),attempts);
 f.allow();await f.client.spawn(req);assert.equal(f.sent.length,1);assert.equal(f.sent[0].type,'spawn');
});
test('a close during principal acquisition cancels the late spawn even when kill itself is refused',async t=>{
 const f=fixture(t),spawn=f.client.spawn(req),rejected=assert.rejects(spawn,{code:'PTY_HOST_PRINCIPAL_BUSY'});await flush();
 await assert.rejects(f.client.kill('p'),{code:'PTY_HOST_PRINCIPAL_BUSY'});
 f.allow();t.mock.timers.tick(100);await rejected;
 assert.deepEqual(f.sent,[]);assert.ok(!f.events.some(e=>e.type==='host-connection'&&e.connected));
});
test('quit cancels a busy attach and cannot send a late spawn',async t=>{
 const f=fixture(t),spawn=f.client.spawn(req),rejected=assert.rejects(spawn,/disposed/);await flush();
 f.client.dispose();f.allow();t.mock.timers.tick(10000);await rejected;assert.deepEqual(f.sent,[]);
});

test('close before the first busy reply cancels the original attach before any retry',async t=>{
 const f=fixture(t);let refuse;const first=new Promise((_resolve,reject)=>{refuse=()=>reject(new HostPrincipalBusyError());});
 f.client.connect=()=>first;
 const spawn=f.client.spawn(req),rejected=assert.rejects(spawn,{code:'PTY_HOST_PRINCIPAL_BUSY'});
 const kill=assert.rejects(f.client.kill('p'),{code:'PTY_HOST_PRINCIPAL_BUSY'});
 refuse();await Promise.all([rejected,kill]);assert.equal(f.client.principalRetry,null);assert.deepEqual(f.sent,[]);
});
