import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HostAuthTransfer,newHostAuthCapability,AUTH_TRANSFER_WINDOW_MS,AUTH_QUIT_PUBLICATION_MS} from '../dist-electron/pty-host-auth-transfer.js';
const issuer={pid:10,startIdentity:'100:1'},recipient={pid:20,startIdentity:'200:2'},other={pid:30,startIdentity:'300:3'},nonce='a'.repeat(64),receipt='b'.repeat(64),key=Buffer.alloc(32,7);
function fixture(){let wall=1000000,mono=100;const transfer=new HostAuthTransfer(key,{wall:()=>wall,monotonic:()=>mono});return{transfer,setWall:value=>wall=value,setMono:value=>mono=value,reserve:(purpose='ordinary-quit')=>transfer.reserve(issuer,purpose,nonce,purpose==='ordinary-quit'?null:wall+120000)};}
test('capabilities are fresh in-memory32-byte values; no disk authority participates',()=>{
 const a=newHostAuthCapability(),b=newHostAuthCapability();assert.equal(a.length,32);assert.notDeepEqual(a,b);assert.throws(()=>new HostAuthTransfer(Buffer.alloc(31)));a.fill(0);b.fill(0);
});
test('unannounced and reserved windows release no key; activation permits exactly one recipient',()=>{
 const {transfer,reserve}=fixture();assert.throws(()=>transfer.redeem('x',nonce,recipient));const a=reserve();assert.equal(transfer.phase,'reserved');assert.throws(()=>transfer.redeem(a.attempt,nonce,recipient));
 transfer.activate(issuer,a.attempt);const received=transfer.redeem(a.attempt,nonce,recipient);assert.deepEqual(received,key);received.fill(0);assert.deepEqual(key,Buffer.alloc(32,7));assert.equal(transfer.phase,'claimed');
 assert.throws(()=>transfer.redeem(a.attempt,nonce,recipient));assert.throws(()=>transfer.redeem(a.attempt,nonce,other));transfer.dispose();
});
test('wrong nonce, attempt, or invalid/same issuer recipient seals the window without rearm',()=>{
 for(const mutation of [{nonce:'c'.repeat(64)},{attempt:'c'.repeat(64)},{peer:issuer},{peer:{...recipient,startIdentity:'unknown'}}]){
  const {transfer,reserve}=fixture(),a=reserve();transfer.activate(issuer,a.attempt);
  assert.throws(()=>transfer.redeem(mutation.attempt??a.attempt,mutation.nonce??nonce,mutation.peer??recipient));assert.equal(transfer.phase,'sealed');
  assert.throws(()=>transfer.redeem(a.attempt,nonce,recipient));assert.throws(()=>reserve());transfer.dispose();
 }
});
test('monotonic activation and authorization deadlines cannot be extended by wall rollback',()=>{
 assert.equal(AUTH_TRANSFER_WINDOW_MS,120000);assert.equal(AUTH_QUIT_PUBLICATION_MS,2000);
 const f=fixture(),a=f.reserve();f.setWall(1);f.setMono(2100);assert.throws(()=>f.transfer.activate(issuer,a.attempt));assert.equal(f.transfer.phase,'sealed');
 const g=fixture(),b=g.reserve('planned-update');g.transfer.activate(issuer,b.attempt);g.setWall(1);g.setMono(120100);assert.throws(()=>g.transfer.redeem(b.attempt,nonce,recipient));assert.equal(g.transfer.phase,'sealed');
 const h=fixture(),c=h.reserve('planned-update');h.transfer.activate(issuer,c.attempt);h.setWall(999999999);h.setMono(120099);assert.throws(()=>h.transfer.redeem(c.attempt,nonce,recipient),'forward wall expiry also refuses');assert.equal(h.transfer.phase,'sealed');
 for(const f of [g,h])f.transfer.dispose();f.transfer.dispose();
});
test('exclusive reservation precedes B3 freeze: loser cannot activate or cancel winner',()=>{
 for(const purpose of ['ordinary-quit','planned-update']){
  const {transfer,reserve}=fixture(),a=reserve(purpose);assert.throws(()=>reserve(purpose==='ordinary-quit'?'planned-update':'ordinary-quit'));
  assert.throws(()=>transfer.cancel(issuer,'f'.repeat(64)));assert.equal(transfer.phase,'reserved');transfer.activate(issuer,a.attempt);assert.deepEqual(transfer.redeem(a.attempt,nonce,recipient),key);transfer.dispose();
 }
});
test('cancel before activation or claim prevents every late activation/credential release',()=>{
 for(const activate of [false,true]){
  const {transfer,reserve}=fixture(),a=reserve();if(activate)transfer.activate(issuer,a.attempt);
  assert.equal(transfer.cancel(issuer,a.attempt),'cancelled');assert.throws(()=>transfer.activate(issuer,a.attempt));assert.throws(()=>transfer.redeem(a.attempt,nonce,recipient));assert.throws(()=>reserve());transfer.dispose();
 }
});
test('redemption commitment wins over issuer cleanup and never rearms from EOF/repeat quit',()=>{
 const {transfer,reserve}=fixture(),a=reserve();transfer.activate(issuer,a.attempt);transfer.redeem(a.attempt,nonce,recipient);
 assert.equal(transfer.cancel(issuer,a.attempt),'committed');assert.equal(transfer.phase,'claimed');assert.throws(()=>reserve());assert.throws(()=>transfer.reserve(recipient,'ordinary-quit','c'.repeat(64),null));transfer.dispose();
});
test('only exact recipient completion after owner-continuity receipt allows a fresh window',()=>{
 const {transfer,reserve}=fixture(),a=reserve();transfer.activate(issuer,a.attempt);transfer.redeem(a.attempt,nonce,recipient).fill(0);
 assert.throws(()=>transfer.complete(recipient,a.attempt,receipt));assert.throws(()=>transfer.noteContinuity(other,a.attempt,receipt));
 transfer.noteContinuity(recipient,a.attempt,receipt);assert.throws(()=>transfer.complete({...recipient,startIdentity:'200:9'},a.attempt,receipt));assert.throws(()=>transfer.complete(recipient,a.attempt,'d'.repeat(64)));
 transfer.complete(recipient,a.attempt,receipt);transfer.complete(recipient,a.attempt,receipt);assert.equal(transfer.phase,'owned');assert.throws(()=>reserve());
 const next=transfer.reserve(recipient,'ordinary-quit','c'.repeat(64),null);assert.notEqual(next.attempt,a.attempt);transfer.activate(recipient,next.attempt);
 assert.throws(()=>transfer.complete(recipient,a.attempt,receipt));assert.equal(transfer.phase,'active');assert.deepEqual(transfer.redeem(next.attempt,'c'.repeat(64),other),key);transfer.dispose();
});
test('competing claimants get one winner; stale replay after rearm seals without a second release',()=>{
 const {transfer,reserve}=fixture(),a=reserve();transfer.activate(issuer,a.attempt);
 const outcomes=[recipient,other].map(peer=>{try{return transfer.redeem(a.attempt,nonce,peer);}catch{return null;}});assert.equal(outcomes.filter(Boolean).length,1);
 transfer.noteContinuity(recipient,a.attempt,receipt);transfer.complete(recipient,a.attempt,receipt);
 const next=transfer.reserve(recipient,'planned-update','c'.repeat(64),1120000);transfer.activate(recipient,next.attempt);
 assert.throws(()=>transfer.redeem(a.attempt,nonce,other));assert.throws(()=>transfer.redeem(next.attempt,'c'.repeat(64),other));assert.equal(transfer.phase,'sealed');transfer.dispose();
});
test('invalid reservation bounds and disposed authority never open a window',()=>{
 for(const args of [[issuer,'planned-update',nonce,1000000],[issuer,'planned-update',nonce,1120001],[issuer,'other',nonce,null],[issuer,'ordinary-quit','bad',null],[Object.assign(Object.create(issuer),{a:1,b:2}),'ordinary-quit',nonce,null]]){
  const {transfer}=fixture();assert.throws(()=>transfer.reserve(...args));assert.equal(transfer.phase,'empty');transfer.dispose();
 }
 const {transfer,reserve}=fixture();transfer.dispose();assert.throws(()=>reserve());
});
test('a retried authenticated continuity response replaces only its pending exact receipt',()=>{
 const {transfer,reserve}=fixture(),a=reserve();transfer.activate(issuer,a.attempt);transfer.redeem(a.attempt,nonce,recipient);
 transfer.noteContinuity(recipient,a.attempt,receipt);transfer.noteContinuity(recipient,a.attempt,receipt);
 const next='e'.repeat(64);transfer.noteContinuity(recipient,a.attempt,next);assert.throws(()=>transfer.complete(recipient,a.attempt,receipt));transfer.complete(recipient,a.attempt,next);transfer.dispose();
});

test('core abort revokes only matching uncommitted planned authority, never ordinary or claimed recipients',()=>{
 for(const purpose of ['ordinary-quit','planned-update'])for(const claimed of [false,true]){
  const {transfer,reserve}=fixture(),a=reserve(purpose);transfer.activate(issuer,a.attempt);
  if(claimed)transfer.redeem(a.attempt,nonce,recipient);
  transfer.revokeUnclaimedPlanned('f'.repeat(64));assert.equal(transfer.phase,claimed?'claimed':'active');
  transfer.revokeUnclaimedPlanned(a.attempt);
  assert.equal(transfer.phase,claimed?'claimed':purpose==='planned-update'?'sealed':'active');
  if(claimed){transfer.noteContinuity(recipient,a.attempt,receipt);transfer.complete(recipient,a.attempt,receipt);assert.equal(transfer.phase,'owned');}
  else if(purpose==='planned-update')assert.throws(()=>transfer.redeem(a.attempt,nonce,recipient));
  else assert.deepEqual(transfer.redeem(a.attempt,nonce,recipient),key);
  transfer.dispose();
 }
});

 test('ordinary active transfer survives days/months and clock jumps, still exactly once',()=>{
 for(const offset of [86400000,180*86400000,-86400000]){
  const f=fixture(),a=f.reserve();assert.equal(a.deadline,null);f.transfer.activate(issuer,a.attempt);
  f.setWall(1000000+offset);f.setMono(100+Math.abs(offset));
  assert.deepEqual(f.transfer.redeem(a.attempt,nonce,recipient),key);
  assert.throws(()=>f.transfer.redeem(a.attempt,nonce,other));f.transfer.dispose();
 }
});
test('deadline encoding belongs to purpose: no finite ordinary or null planned reservation',()=>{
 for(const [purpose,deadline] of [['ordinary-quit',1120000],['ordinary-quit',undefined],['planned-update',null],['planned-update',Infinity],['planned-update',1120001]]){
  const f=fixture();assert.throws(()=>f.transfer.reserve(issuer,purpose,nonce,deadline));assert.equal(f.transfer.phase,'empty');f.transfer.dispose();
 }
});
