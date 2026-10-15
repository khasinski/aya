import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
fs.mkdirSync('test-results',{recursive:true});const root=fs.mkdtempSync(path.resolve('test-results/planned-update-'));process.env.AYA_HOME=root;
const require=createRequire(import.meta.url),{PlannedUpdate}=require('../dist-electron/pty-planned-update.js');
const {writeHandoverTicket,readHandoverTicket}=require('../dist-electron/pty-handover-ticket.js');
const ticketFile=path.join(root,'pty-handover.json');
const receipt={nonce:'a'.repeat(64),sha256:'b'.repeat(64),bytes:100};
function fixture(ineligible=[]){
 const calls=[],state={deadline:Date.now()+10000,eligible:[{id:'kept',generation:'g',outputEnd:10}],ineligible,consented:[],core:receipt,display:null};
 const deps={
  host:{preparePlannedHandover:async()=>state,announcePlannedHandover:async(s,display,consented,nonce)=>{calls.push(['announce',consented]);return{nonce,deadline:s.deadline,hostPid:123,hostStartIdentity:'1:2'};},cancelPlannedHandover:async()=>{calls.push(['cancel']);},adoptPlannedHandover:async(_ticket,_expected,inspect)=>{await inspect(state);return state;},restart:async()=>{calls.push(['restart']);return true;}},
  displays:{capture:async()=>{calls.push(['capture']);return receipt;},inspect:async()=>{calls.push(['inspect']);},acknowledgeEscrow:async()=>{},clear:()=>{calls.push(['clear']);}},
  expected:()=>({version:'1',scriptHash:'x'}),confirmStop:async(ids)=>{calls.push(['ask',ids]);return true;},log:()=>{},
 };
 return {deps,calls,state,planned:new PlannedUpdate(deps)};
}
const clean=()=>{fs.rmSync(ticketFile,{force:true});};
test('eligible preflight is shared, asks nothing, publishes a nonce-only ticket and aborts cleanly',async()=>{
 clean();const f=fixture();try{
  const first=f.planned.prepare(),second=f.planned.prepare();assert.equal(first,second);assert.equal(await first,true);
  assert.deepEqual(f.calls,[['capture'],['announce',[]]]);const json=JSON.parse(fs.readFileSync(ticketFile));assert.equal(Object.hasOwn(json,'credential'),false);
  await f.planned.abort();assert.equal(fs.existsSync(ticketFile),false);assert.deepEqual(f.calls.at(-1),['cancel']);
 }finally{clean();}
});
test('ineligible pane is asked alone before capture; Cancel leaves the old host and no announcement',async()=>{
 clean();const f=fixture([{id:'bad',reason:'unsupported state'}]);f.deps.confirmStop=async ids=>{f.calls.push(['ask',ids]);return false;};
 assert.equal(await f.planned.prepare(),false);assert.deepEqual(f.calls,[['ask',['bad']],['cancel']]);assert.equal(fs.existsSync(ticketFile),false);
});
test('a yes publishes exactly the ineligible consent IDs',async()=>{
 clean();const f=fixture([{id:'bad',reason:'unsupported state'}]);try{assert.equal(await f.planned.prepare(),true);assert.deepEqual(f.calls,[['ask',['bad']],['capture'],['announce',['bad']]]);}finally{await f.planned.abort();clean();}
});
for(const yes of [false,true])test(`unexpected successor refusal asks before destructive fallback, yes=${yes}`,async()=>{
 clean();const f=fixture();f.deps.host.adoptPlannedHandover=async()=>{throw Error('unexpected refusal');};f.deps.confirmStop=async ids=>{f.calls.push(['ask',ids]);return yes;};
 writeHandoverTicket(ticketFile,{nonce:'c'.repeat(64),deadline:Date.now()+10000,hostPid:123,hostStartIdentity:'1:2'});
 assert.equal(await f.planned.resume(),yes?'restored':'kept');assert.equal(fs.existsSync(ticketFile),false);
 assert.deepEqual(f.calls,yes?[['clear'],['ask',undefined],['restart']]:[['clear'],['ask',undefined]]);
});
test('no announced relaunch performs no host work',async()=>{clean();const f=fixture();assert.equal(await f.planned.resume(),'none');assert.deepEqual(f.calls,[]);});
test('cancelling an earlier attempt does not consume another nonce ticket',async()=>{
 clean();const f=fixture();await f.planned.prepare();const other={nonce:'d'.repeat(64),deadline:Date.now()+10000,hostPid:123,hostStartIdentity:'1:2'};
 writeHandoverTicket(ticketFile,other);await f.planned.abort();assert.deepEqual(readHandoverTicket(ticketFile),other);clean();
});
