import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {validateOwnerContinuity,validateTransferredOwnerContinuity}=require('../dist-electron/pty-host-owner-continuity.js');
const peer={pid:100,startIdentity:'1:2'};
function fixture(){
 const owner={pid:200,startTime:'owner-start',instanceId:'a'.repeat(32),binaryHash:'b'.repeat(64)};
 const panes=[0,1].map(i=>({id:`p${i}`,generation:i+1,pid:300+i,startIdentity:`3:${i}`,request:{ptyId:`p${i}`,command:'shell',cwd:'/',cols:80,rows:24},launch:{command:'shell',cwd:'/'},spawnedAt:1}));
 const response={format:1,host:{...peer},secret:'c'.repeat(64),bootstrap:{format:1,kind:'crash',owner,panes}};
 const version={owner:{...owner,hash:owner.binaryHash,incompatible:false,inventory:panes.map(p=>({id:p.id,generation:p.generation,pid:p.pid,startIdentity:p.startIdentity,exited:false,acknowledged:false}))}};
 return {response,version};
}
test('owner continuity accepts only a complete same-instance generation manifest and returns an independent in-memory key',()=>{
 const {response,version}=fixture(),result=validateOwnerContinuity(response,peer,version);
 assert.deepEqual(result.bootstrap,response.bootstrap);assert.equal(result.credential.toString('hex'),'c'.repeat(64));result.credential.fill(0);assert.equal(response.secret,'c'.repeat(64));
});
test('malformed or incomplete continuity never yields a credential',()=>{
 for(const mutate of [
  r=>{r.format=2;},r=>{r.extra=true;},r=>{r.host.pid++;},r=>{r.host.startIdentity='other';},r=>{r.host.extra=true;},r=>{r.secret='short';},
  r=>{r.bootstrap.owner.pid++;},r=>{r.bootstrap.owner.startTime='other';},r=>{r.bootstrap.owner.instanceId='d'.repeat(32);},r=>{r.bootstrap.owner.binaryHash='e'.repeat(64);},
  r=>{r.bootstrap.panes.pop();},r=>{r.bootstrap.panes=[];},r=>{r.bootstrap.panes[1]=structuredClone(r.bootstrap.panes[0]);},r=>{r.bootstrap.panes[0].generation++;},r=>{r.bootstrap.panes[0].pid++;},r=>{r.bootstrap.panes[0].startIdentity='3:99';},r=>{r.bootstrap.panes[0].request.ptyId='wrong';},r=>{r.bootstrap.observed=[];},r=>{r.bootstrap.secret='not allowed';}
 ]){const {response,version}=fixture();mutate(response);assert.throws(()=>validateOwnerContinuity(response,peer,version));}
});
test('expected owner inventory must be compatible, bounded, unique, live and exactly match the offered panes',()=>{
 for(const mutate of [
  v=>{v.owner.incompatible=true;},v=>{delete v.owner;},v=>{v.owner.inventory=[];},v=>{v.owner.inventory=Array(26).fill(v.owner.inventory[0]);},v=>{v.owner.inventory[1]=v.owner.inventory[0];},v=>{v.owner.inventory[0].exited=true;},v=>{v.owner.inventory[0].acknowledged=true;},v=>{delete v.owner.inventory[0].generation;},v=>{v.owner.inventory[0].pid++;}
 ]){const {response,version}=fixture();mutate(version);assert.throws(()=>validateOwnerContinuity(response,peer,version));}
});
test('continuity accepts exactly one MiB and refuses a valid manifest one byte above the envelope cap',()=>{
 const {response,version}=fixture();response.bootstrap.panes[0].request.peerCwds=Array(16).fill('');
 let remaining=1024*1024-Buffer.byteLength(JSON.stringify(response));
 for(let i=0;i<16;i++){const count=Math.min(65536,remaining);response.bootstrap.panes[0].request.peerCwds[i]='x'.repeat(count);remaining-=count;}
 assert.equal(remaining,0);assert.equal(Buffer.byteLength(JSON.stringify(response)),1024*1024);
 const accepted=validateOwnerContinuity(response,peer,version);accepted.credential.fill(0);
 const slot=response.bootstrap.panes[0].request.peerCwds.findIndex(s=>s.length<65536);assert.notEqual(slot,-1);
 response.bootstrap.panes[0].request.peerCwds[slot]+='x';assert.equal(Buffer.byteLength(JSON.stringify(response)),1024*1024+1);
 assert.throws(()=>validateOwnerContinuity(response,peer,version),/^Error: Invalid terminal owner continuity response$/);
});

function tag(response){return {...response,transferReceipt:createHash('sha256').update(JSON.stringify(response.bootstrap)).digest('hex')};}
test('announced continuity verifies exact receipt and complete live manifest before releasing a copied credential',()=>{
 const {response,version}=fixture(),tagged=tag(response),accepted=validateTransferredOwnerContinuity(tagged,peer,version);
 assert.deepEqual(accepted.bootstrap,response.bootstrap);accepted.credential.fill(0);assert.equal(tagged.secret,'c'.repeat(64));
 for(const mutate of [r=>{r.transferReceipt='0'.repeat(64);},r=>{r.extra=true;},r=>{r.host.pid++;},r=>{r.bootstrap.panes.pop();}]){
  const value=structuredClone(tagged);mutate(value);assert.throws(()=>validateTransferredOwnerContinuity(value,peer,version));
 }
});
test('empty continuity is closed and requires authenticated exact-host zero panes and no owner',()=>{
 const response={format:2,host:{...peer},secret:'c'.repeat(64),bootstrap:{format:2,kind:'empty',owner:null,panes:[]}},version={owner:null,ptyCount:0};
 const value=tag(response),accepted=validateTransferredOwnerContinuity(value,peer,version);assert.equal(accepted.bootstrap,null);accepted.credential.fill(0);
 for(const mutate of [r=>{r.format=1;},r=>{r.host.startIdentity='1:3';},r=>{r.secret='bad';},r=>{r.bootstrap.extra=true;},r=>{r.bootstrap.kind='crash';},r=>{r.bootstrap.owner={pid:42};},r=>{r.bootstrap.panes=[{id:'unseen'}];}]){
  const changed=structuredClone(response);mutate(changed);assert.throws(()=>validateTransferredOwnerContinuity(tag(changed),peer,version));
 }
 for(const changed of [{owner:null},{owner:null,ptyCount:1},{ptyCount:0},{owner:{},ptyCount:0}])assert.throws(()=>validateTransferredOwnerContinuity(value,peer,changed));
});
