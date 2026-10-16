import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),native=require('../dist-electron/pty-owner-client.js');
const {PtyHostClient}=require('../dist-electron/pty-host-client.js');
const pidA=2147483000,pidB=2147483001;
const owner=(pid,instance)=>({pid,startTime:'owner-start',instanceId:instance.repeat(32),hash:'c'.repeat(64),incompatible:false,disconnected:['p'],inventory:[{id:'p',pid:pid+1}]});
const target=(pid,startTime,own)=>({pid,startTime,owner:own,identity:null,ptyCount:1});
function fixture(actual){
 const client=new PtyHostClient('unused'),requests=[],socket={destroyed:false,once(){return this;},destroy(){this.destroyed=true;}};
 client.socket=socket;client.request=async req=>{requests.push(req.type);assert.equal(req.type,'version');return actual;};
 client.sendRequest=async(s,req)=>{assert.equal(s,socket);requests.push(req.type);return null;};
 client.startHost=()=>{throw Error('must not start a host in this fixture');};return{client,requests,socket};
}
for(const changed of ['pid','start','owner'])test(`restart consent refuses changed ${changed} until a fresh question`,async()=>{
 const a=target(pidA,'A',owner(800,'a')),b=changed==='pid'?target(pidB,'B',owner(801,'b')):changed==='start'?target(pidA,'B',a.owner):target(pidA,'A',owner(801,'b'));
 const {client,requests}=fixture(b),probe=native.ownerProcessStartIdentity,questions=[];native.ownerProcessStartIdentity=()=>b.startTime;
 try{await assert.rejects(client.restart({target:a,confirmChanged:async fresh=>{questions.push(fresh);return false;}}),/restart cancelled/);assert.equal(questions.length,1);assert.equal(questions[0].owner.pid,b.owner.pid);assert.deepEqual(requests,['version']);}
 finally{native.ownerProcessStartIdentity=probe;client.dispose();}
});
test('a fresh yes is revalidated, then shutdown is pinned to that socket and identity',async()=>{
 const a=target(pidA,'A',owner(800,'a')),b=target(pidB,'B',owner(801,'b')),{client,requests,socket}=fixture(b),probe=native.ownerProcessStartIdentity;let questions=0;
 native.ownerProcessStartIdentity=()=>b.startTime;client.sendRequest=async(s,req)=>{assert.equal(s,socket);assert.deepEqual(req.target,{pid:pidB,startTime:'B',ownerInstance:'b'.repeat(32)});requests.push(req.type);return null;};
 try{assert.equal(await client.restart({target:a,confirmChanged:async()=>{questions++;return true;}}),true);assert.equal(questions,1);assert.deepEqual(requests,['version','version','shutdown']);}
 finally{native.ownerProcessStartIdentity=probe;client.dispose();}
});
test('an unreadable kernel identity cannot authorize any shutdown',async()=>{
 const b=target(pidB,'B',owner(801,'b')),{client,requests}=fixture(b),probe=native.ownerProcessStartIdentity;let questions=0;native.ownerProcessStartIdentity=()=>null;
 try{await assert.rejects(client.restart({target:b,confirmChanged:async()=>{questions++;return true;}}),/could not be verified/);assert.equal(questions,1);assert.deepEqual(requests,['version']);}
 finally{native.ownerProcessStartIdentity=probe;client.dispose();}
});
test('a target refusal never falls through to a numeric host kill',async()=>{
 const a=target(pidA,'A',owner(800,'a')),{client,requests}=fixture(a),probe=native.ownerProcessStartIdentity,kill=process.kill;
 native.ownerProcessStartIdentity=()=>a.startTime;process.kill=()=>{throw Error('must not kill after target refusal');};client.sendRequest=async(_s,r)=>{requests.push(r.type);throw Error('target changed before shutdown');};
 try{await assert.rejects(client.restart({target:a,confirmChanged:async()=>{throw Error('no question needed for same target');}}),/target changed/);assert.deepEqual(requests,['version','shutdown']);}
 finally{native.ownerProcessStartIdentity=probe;process.kill=kill;client.dispose();}
});
