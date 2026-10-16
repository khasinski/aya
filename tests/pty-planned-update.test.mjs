import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
fs.mkdirSync('test-results',{recursive:true});const root=fs.mkdtempSync(path.resolve('test-results/planned-update-'));process.env.AYA_HOME=root;
const require=createRequire(import.meta.url),{PlannedUpdate}=require('../dist-electron/pty-planned-update.js');
const {writeHandoverTicket,readHandoverTicket}=require('../dist-electron/pty-handover-ticket.js');
const {writeAuthTransferTicket,authTransferTicketPath}=require('../dist-electron/pty-host-auth-ticket.js');
after(()=>fs.rmSync(root,{recursive:true,force:true}));
const ticketFile=path.join(root,'pty-handover.json');
const receipt={nonce:'a'.repeat(64),sha256:'b'.repeat(64),bytes:100};
function fixture(ineligible=[]){
 const calls=[],state={deadline:Date.now()+10000,eligible:[{id:'kept',generation:'g',outputEnd:10}],ineligible,consented:[],core:receipt,display:null};
 const deps={
  host:{reservePlannedHandover:async deadline=>{const ticket={format:2,purpose:'planned-update',attempt:'e'.repeat(64),nonce:'f'.repeat(64),deadline,hostPid:123,hostStartIdentity:'1:2'};calls.push(['reserve']);return ticket;},activatePlannedHandover:async()=>{calls.push(['activate']);},cancelPlannedAuth:async()=>{calls.push(['auth-cancel']);return 'cancelled';},redeemAnnouncedCapability:async()=>{calls.push(['redeem']);},preparePlannedHandover:async deadline=>{state.deadline=deadline;calls.push(['freeze']);return state;},announcePlannedHandover:async(s,display,consented,nonce)=>{calls.push(['announce',consented]);return{nonce,deadline:s.deadline,hostPid:123,hostStartIdentity:'1:2'};},cancelPlannedHandover:async()=>{calls.push(['cancel']);},adoptPlannedHandover:async(_ticket,_expected,inspect)=>{await inspect(state);return state;},restart:async()=>{calls.push(['restart']);return true;}},
  displays:{capture:async()=>{calls.push(['capture']);return receipt;},inspect:async()=>{calls.push(['inspect']);},acknowledgeEscrow:async()=>{},clear:()=>{calls.push(['clear']);}},
  publication:{publish:async(...args)=>{calls.push(['publish']);await writeAuthTransferTicket(...args);}},
  expected:()=>({version:'1',scriptHash:'x'}),confirmStop:async(ids)=>{calls.push(['ask',ids]);return true;},log:()=>{},
 };
 return {deps,calls,state,planned:new PlannedUpdate(deps)};
}
const transferFile=()=>authTransferTicketPath(root,'e'.repeat(64));
const clean=()=>{for(const name of fs.readdirSync(root))if(/^pty-handover(?:\.[a-f0-9]{64})?\.json$/.test(name))fs.rmSync(path.join(root,name),{force:true});};
test('eligible preflight is shared, asks nothing, publishes a nonce-only ticket and aborts cleanly',async()=>{
 clean();const f=fixture();try{
  const first=f.planned.prepare(),second=f.planned.prepare();assert.equal(first,second);assert.equal(await first,true);
  assert.deepEqual(f.calls,[['reserve'],['freeze'],['capture'],['announce',[]],['publish'],['activate']]);const json=JSON.parse(fs.readFileSync(transferFile()));assert.equal(json.format,2);assert.equal(fs.statSync(transferFile()).mode&0o777,0o600);assert.equal(Object.hasOwn(json,'credential'),false);
  await f.planned.abort();assert.equal(fs.existsSync(transferFile()),false);assert.deepEqual(f.calls.slice(-2),[['auth-cancel'],['cancel']]);
 }finally{clean();}
});
test('ineligible pane is asked alone before capture; Cancel leaves the old host and no announcement',async()=>{
 clean();const f=fixture([{id:'bad',reason:'unsupported state'}]);f.deps.confirmStop=async ids=>{f.calls.push(['ask',ids]);return false;};
 assert.equal(await f.planned.prepare(),false);assert.deepEqual(f.calls,[['reserve'],['freeze'],['ask',['bad']],['auth-cancel'],['cancel']]);assert.equal(fs.existsSync(ticketFile),false);
});
test('a yes publishes exactly the ineligible consent IDs',async()=>{
 clean();const f=fixture([{id:'bad',reason:'unsupported state'}]);try{assert.equal(await f.planned.prepare(),true);assert.deepEqual(f.calls,[['reserve'],['freeze'],['ask',['bad']],['capture'],['announce',['bad']],['publish'],['activate']]);}finally{await f.planned.abort();clean();}
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
 const winner={format:2,purpose:'planned-update',attempt:'1'.repeat(64),...other};const winnerFile=authTransferTicketPath(root,winner.attempt);await writeAuthTransferTicket(winnerFile,winner,{deadline:performance.now()+2000});writeHandoverTicket(ticketFile,other);await f.planned.abort();assert.deepEqual(JSON.parse(fs.readFileSync(winnerFile)),winner);assert.deepEqual(readHandoverTicket(ticketFile),other);clean();
});

test('already consumed version2 planned ticket resumes without reading an obsolete disk announcement',async()=>{
 clean();const f=fixture(),ticket={format:2,purpose:'planned-update',attempt:'e'.repeat(64),nonce:'f'.repeat(64),deadline:Date.now()+10000,hostPid:123,hostStartIdentity:'1:2'};let adopted;
 f.deps.host.adoptPlannedHandover=async value=>{adopted=value;return f.state;};
 assert.equal(await f.planned.resume(ticket),'restored');assert.equal(adopted,ticket);assert.equal(fs.existsSync(ticketFile),false);assert.equal(f.calls.some(call=>call[0]==='restart'),false);
});
test('prepared-update state prevents ordinary quit from publishing a second credential window',async()=>{
 clean();const f=fixture();try{assert.equal(f.planned.hasPreparedHandover,false);assert.equal(await f.planned.prepare(),true);assert.equal(f.planned.hasPreparedHandover,true);await f.planned.abort();assert.equal(f.planned.hasPreparedHandover,false);}finally{clean();}
});

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
async function until(predicate){const end=Date.now()+3000;while(!predicate()){if(Date.now()>end)throw Error('planned transaction readiness timeout');await new Promise(resolve=>setImmediate(resolve));}}
test('a losing reservation cannot freeze, publish or cancel the winning purpose',async()=>{
 clean();const f=fixture();f.deps.host.reservePlannedHandover=async()=>{f.calls.push(['reserve-lost']);throw Error('ordinary winner');};f.deps.confirmStop=async()=>false;
 assert.equal(await f.planned.prepare(),false);assert.deepEqual(f.calls,[['reserve-lost']]);assert.equal(fs.existsSync(transferFile()),false);
});
test('a late reservation reply cleans only its own attempt after a newer preparation wins',async()=>{
 clean();const f=fixture(),late=deferred(),cancelled=[],cleaned=[],coreCancelled=[];let oldDeadline;
 const reserve=f.deps.host.reservePlannedHandover;f.deps.host.reservePlannedHandover=deadline=>{oldDeadline=deadline;return late.promise;};
 f.deps.host.cancelPlannedAuth=async attempt=>{cancelled.push(attempt);return 'cancelled';};f.deps.host.cancelPlannedHandover=async attempt=>{coreCancelled.push(attempt);};
 const {cancelAuthTransferTicket}=require('../dist-electron/pty-host-auth-ticket.js');f.deps.publication.cancel=async(...args)=>{await cancelAuthTransferTicket(...args);cleaned.push(args[1]);};
 const first=f.planned.prepare();await f.planned.abort();assert.equal(await first,false);
 f.deps.host.reservePlannedHandover=reserve;assert.equal(await f.planned.prepare(),true);
 const winning=JSON.parse(fs.readFileSync(transferFile(),'utf8'));
 const old={...winning,attempt:'1'.repeat(64),nonce:'2'.repeat(64),deadline:oldDeadline};late.resolve(old);
 await until(()=>cleaned.includes(old.attempt));assert.deepEqual(cancelled,[old.attempt]);assert.deepEqual(coreCancelled,[]);
 assert.deepEqual(JSON.parse(fs.readFileSync(transferFile(),'utf8')),winning);assert.equal(f.planned.hasPreparedHandover,true);await f.planned.abort();clean();
});
test('abort while file cleanup awaits I/O also discards a display returned later, without cancelling a winner',async()=>{
 clean();const f=fixture(),capture=deferred(),fileCancel=deferred();let capturing=false,cancelling=false;
 const store=require('../dist-electron/pty-checkpoint-store.js'),displayRoot=path.join(root,'pty-handover-display');
 const lateReceipt=await store.writeCheckpoint(displayRoot,[{id:'kept',generation:'g',data:Buffer.from('late display')}]);
 f.deps.displays.capture=async()=>{capturing=true;return capture.promise;};
 const {cancelAuthTransferTicket}=require('../dist-electron/pty-host-auth-ticket.js');f.deps.publication.cancel=async(...args)=>{cancelling=true;await fileCancel.promise;return cancelAuthTransferTicket(...args);};
 const preparing=f.planned.prepare();await until(()=>capturing);const aborting=f.planned.abort();await until(()=>cancelling);
 capture.resolve(lateReceipt);await new Promise(resolve=>setImmediate(resolve));fileCancel.resolve();await aborting;assert.equal(await preparing,false);
 await until(()=>!fs.existsSync(path.join(displayRoot,lateReceipt.nonce)));assert.equal(f.planned.hasPreparedHandover,false);assert.equal(f.calls.filter(c=>c[0]==='activate').length,0);clean();
});
test('publication stalled past the parent budget never activates even after its I/O finishes',async()=>{
 clean();const f=fixture(),gate=deferred();let entered=false,returned=false;f.deps.publication.budgetMs=200;
 f.deps.confirmStop=async()=>false;
 f.deps.publication.publish=async(...args)=>{entered=true;await gate.promise;try{await writeAuthTransferTicket(...args);}finally{returned=true;}};
 const start=performance.now();assert.equal(await f.planned.prepare(),false);assert.equal(entered,true);assert.ok(performance.now()-start<2000);
 gate.resolve();await until(()=>returned);assert.equal(f.calls.some(c=>c[0]==='activate'),false);assert.equal(fs.existsSync(transferFile()),false);clean();
});
test('a valid activation reply at the monotonic deadline cannot publish successful preparation',async()=>{
 clean();const f=fixture();let mono=0;f.deps.publication.now=()=>mono;f.deps.confirmStop=async()=>false;
 f.deps.host.activatePlannedHandover=async()=>{f.calls.push(['activate']);mono=120000;};
 assert.equal(await f.planned.prepare(),false);assert.equal(f.calls.filter(c=>c[0]==='activate').length,1);assert.equal(f.planned.hasPreparedHandover,false);assert.equal(fs.existsSync(transferFile()),false);clean();
});
test('recipient commit survives issuer abort without core cancellation or another reservation',async()=>{
 clean();const f=fixture();f.deps.host.cancelPlannedAuth=async()=>{f.calls.push(['committed']);return 'committed';};
 const prepared=f.planned.prepare();assert.equal(await prepared,true);await f.planned.abort();
 assert.equal(f.planned.hasPreparedHandover,true);assert.equal(f.calls.some(c=>c[0]==='cancel'),false);assert.equal(f.planned.prepare(),prepared);assert.equal(f.calls.filter(c=>c[0]==='reserve').length,1);clean();
});
test('abort while fallback consent is pending cannot authorize a late installer continuation',async()=>{
 clean();const f=fixture(),question=deferred();let asking=false;
 f.deps.host.reservePlannedHandover=async()=>{throw Error('reservation refused');};
 f.deps.confirmStop=async()=>{asking=true;return question.promise;};
 const preparing=f.planned.prepare();await until(()=>asking);const aborting=f.planned.abort();
 question.resolve(true);await aborting;assert.equal(await preparing,false);
 assert.equal(f.planned.hasPreparedHandover,false);assert.equal(f.calls.some(c=>c[0]==='restart'||c[0]==='activate'||c[0]==='freeze'),false);
});
for(const code of ['ENOENT','ECONNREFUSED'])test(`planned reservation is existing-host-only for ${code}`,async()=>{
 const {PtyHostClient}=require('../dist-electron/pty-host-client.js'),c=new PtyHostClient('unused');let starts=0;
 c.openSocket=async()=>{throw Object.assign(Error('existing socket unavailable'),{code});};c.startHost=()=>{starts++;throw Error('not allowed');};
 try{await assert.rejects(c.reservePlannedHandover(Date.now()+120000),error=>error.code===code);assert.equal(starts,0);}finally{c.dispose();}
});
