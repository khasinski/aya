import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {execFileSync} from 'node:child_process';
import {authTransferTicketPath,writeAuthTransferTicket,readAuthTransferTicket} from '../dist-electron/pty-host-auth-ticket.js';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const wait=async predicate=>{const end=performance.now()+2000;while(!await predicate()){if(performance.now()>=end)throw Error('ticket cleanup timeout');await sleep(2);}};
const ticket=(extra={})=>({format:2,attempt:'a'.repeat(64),purpose:'ordinary-quit',nonce:'b'.repeat(64),deadline:null,hostPid:123,hostStartIdentity:'10:2',...extra});
const budget=extra=>({deadline:performance.now()+1000,...extra});
async function fixture(){await fs.mkdir('test-results',{recursive:true});const root=await fs.mkdtemp(path.resolve('test-results/auth-ticket-'));return {root,file:t=>authTransferTicketPath(root,t.attempt),close:()=>fs.rm(root,{recursive:true,force:true})};}
function gate(){let release;const promise=new Promise(resolve=>release=resolve);return{promise,release};}
test('versioned nonce-only ticket publishes privately and is consumed once, absent is not created',async()=>{
 const f=await fixture(),t=ticket();try{
  const file=f.file(t);assert.equal(await readAuthTransferTicket(file),null);await writeAuthTransferTicket(file,t,budget());
  assert.equal((await fs.stat(file)).mode&0o7777,0o600);assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),t);
  assert.deepEqual(await readAuthTransferTicket(file),t);assert.equal(await readAuthTransferTicket(file),null);assert.deepEqual(await fs.readdir(f.root),[]);
  await assert.rejects(writeAuthTransferTicket(path.join(f.root,'shared.json'),t,budget()));
 }finally{await f.close();}
});
test('replacement marker is optional for older tickets and only accepts booleans on ordinary quit',async()=>{
 const f=await fixture(),old=ticket(),replacement=ticket({replacedBuild:true}),file=f.file(old);try{
  await writeAuthTransferTicket(file,old,budget());assert.equal((await readAuthTransferTicket(file)).replacedBuild,undefined);
  await writeAuthTransferTicket(f.file(replacement),replacement,budget());assert.equal((await readAuthTransferTicket(f.file(replacement))).replacedBuild,true);
  for(const invalid of [ticket({replacedBuild:'yes'}),ticket({purpose:'planned-update',deadline:Date.now()+120000,replacedBuild:true})])await assert.rejects(writeAuthTransferTicket(f.file(invalid),invalid,budget()));
 }finally{await f.close();}
});
test('closed payload, expiry, bounds and private types are refused without FIFO blocking',async()=>{
 const f=await fixture(),t=ticket(),file=f.file(t);try{
  for(const value of [{...t,extra:true},{...t,format:1},{...t,deadline:Date.now()-1},{...t,purpose:'anything'},{...t,purpose:'planned-update'},{...t,deadline:Date.now()+120000},{...t,hostStartIdentity:'unknown'},{...t,nonce:'bad'}]){
   await fs.writeFile(file,JSON.stringify(value),{mode:0o600});await assert.rejects(readAuthTransferTicket(file));assert.equal(syncFs.existsSync(file),false,'safe invalid payload is consumed');
  }
  await fs.writeFile(file,Buffer.alloc(1025,32),{mode:0o600});await assert.rejects(readAuthTransferTicket(file));assert.equal(syncFs.existsSync(file),true);await fs.unlink(file);
  await fs.writeFile(file,JSON.stringify(t),{mode:0o644});await assert.rejects(readAuthTransferTicket(file));await fs.unlink(file);
  execFileSync('/usr/bin/mkfifo',[file]);const start=performance.now();await assert.rejects(readAuthTransferTicket(file,budget({deadline:performance.now()+200})));assert.ok(performance.now()-start<500);await fs.unlink(file);
  await fs.writeFile(path.join(f.root,'real'),JSON.stringify(t),{mode:0o600});await fs.symlink('real',file);await assert.rejects(readAuthTransferTicket(file));
 }finally{await f.close();}
});
test('a stalled open returns within the parent budget and late completion only cleans its temporary inode',async()=>{
 const f=await fixture(),t=ticket(),hold=gate();let opened=false,renames=0;
 const io={...fs,open:async(...args)=>{opened=true;const handle=await fs.open(...args);await hold.promise;return handle;},rename:async(...args)=>{renames++;return fs.rename(...args);}};
 try{
  const start=performance.now();await assert.rejects(writeAuthTransferTicket(f.file(t),t,budget({deadline:performance.now()+30,io})));assert.equal(opened,true);assert.ok(performance.now()-start<500);assert.equal(renames,0);
  hold.release();await wait(async()=>(await fs.readdir(f.root)).length===0);assert.equal(renames,0);
 }finally{hold.release();await f.close();}
});
test('a stalled fsync never blocks main or activates publication after deadline',async()=>{
 const f=await fixture(),t=ticket(),hold=gate();let syncing=false,renames=0,heartbeats=0;
 const beat=setInterval(()=>heartbeats++,2);
 const io={...fs,open:async(...args)=>{const h=await fs.open(...args);return{stat:()=>h.stat(),writeFile:data=>h.writeFile(data),close:()=>h.close(),sync:async()=>{syncing=true;await hold.promise;return h.sync();}};},rename:async(...args)=>{renames++;return fs.rename(...args);}};
 try{
  const start=performance.now();await assert.rejects(writeAuthTransferTicket(f.file(t),t,budget({deadline:performance.now()+200,io})));assert.ok(performance.now()-start<700);assert.equal(syncing,true);assert.ok(heartbeats>1);assert.equal(renames,0);
  hold.release();await wait(async()=>(await fs.readdir(f.root)).length===0);assert.equal(renames,0);
 }finally{clearInterval(beat);hold.release();await f.close();}
});
test('late rename cleanup cannot touch a later attempt ticket',async()=>{
 const f=await fixture(),t=ticket(),next=ticket({attempt:'c'.repeat(64),nonce:'d'.repeat(64)}),hold=gate();let renaming=false;
 const io={...fs,rename:async(...args)=>{renaming=true;await hold.promise;return fs.rename(...args);}};
 try{
  const start=performance.now();await assert.rejects(writeAuthTransferTicket(f.file(t),t,budget({deadline:performance.now()+200,io})));assert.ok(performance.now()-start<700);assert.equal(renaming,true);
  await writeAuthTransferTicket(f.file(next),next,budget());hold.release();await wait(async()=>!(await fs.readdir(f.root)).some(name=>name.includes(t.attempt)));
  assert.deepEqual(await readAuthTransferTicket(f.file(next)),next);
 }finally{hold.release();await f.close();}
});
test('late valid completion is rejected by monotonic check before a delayed timer callback',async()=>{
 const f=await fixture(),t=ticket();let now=0;
 const io={...fs,rename:async(...args)=>{await fs.rename(...args);now=100;}};
 try{await assert.rejects(writeAuthTransferTicket(f.file(t),t,{deadline:100,now:()=>now,io}));assert.deepEqual(await fs.readdir(f.root),[]);}finally{await f.close();}
});
test('quit cancellation fences the pending write and does not await blocked I/O',async()=>{
 const f=await fixture(),t=ticket(),hold=gate(),controller=new AbortController();let writing=false;
 const io={...fs,open:async(...args)=>{const h=await fs.open(...args);return{stat:()=>h.stat(),writeFile:async data=>{writing=true;await hold.promise;return h.writeFile(data);},sync:()=>h.sync(),close:()=>h.close()};}};
 try{
  const writingTicket=writeAuthTransferTicket(f.file(t),t,budget({io,signal:controller.signal}));await wait(()=>writing);const start=performance.now();controller.abort();await assert.rejects(writingTicket);assert.ok(performance.now()-start<500);
  hold.release();await wait(async()=>(await fs.readdir(f.root)).length===0);
 }finally{hold.release();await f.close();}
});
test('read expiry before named-identity check completes cannot consume a ticket late',async()=>{
 const f=await fixture(),t=ticket(),hold=gate();let inspecting=false,closed=false;
 try{
  await writeAuthTransferTicket(f.file(t),t,budget());
  const io={...fs,open:async(...args)=>{const h=await fs.open(...args);return{stat:()=>h.stat(),read:(...args)=>h.read(...args),close:async()=>{await h.close();closed=true;}};},lstat:async(...args)=>{inspecting=true;await hold.promise;return fs.lstat(...args);}};
  const start=performance.now();await assert.rejects(readAuthTransferTicket(f.file(t),budget({deadline:performance.now()+200,io})));assert.ok(performance.now()-start<700);assert.equal(inspecting,true);hold.release();await wait(()=>closed);assert.equal(syncFs.existsSync(f.file(t)),true);
  assert.deepEqual(await readAuthTransferTicket(f.file(t)),t);
 }finally{hold.release();await f.close();}
});
test('parse and I/O errors cannot reveal a ticket payload in an exception',async()=>{
 const f=await fixture(),t=ticket(),file=f.file(t);try{
  await fs.writeFile(file,'{"nonce":"PRIVATE_SENTINEL",}',{mode:0o600});
  await assert.rejects(readAuthTransferTicket(file),error=>error.message==='Terminal host transfer ticket is unavailable'&&!String(error).includes('PRIVATE_SENTINEL'));
  let opens=0;const io={...fs,open:async()=>{opens++;throw Error('PRIVATE_IO_DETAIL');}};
  await assert.rejects(writeAuthTransferTicket(file,t,budget({io})),error=>error.message==='Terminal host transfer ticket is unavailable');assert.equal(opens,1);
 }finally{await f.close();}
});
test('exact1024-byte valid JSON is accepted but hardlinks and wrong UID are not consumed',async()=>{
 const f=await fixture(),t=ticket(),file=f.file(t);try{
  const raw=Buffer.from(JSON.stringify(t));await fs.writeFile(file,Buffer.concat([raw,Buffer.alloc(1024-raw.length,32)]),{mode:0o600});assert.deepEqual(await readAuthTransferTicket(file),t);
  await writeAuthTransferTicket(file,t,budget());await fs.link(file,path.join(f.root,'alias'));await assert.rejects(readAuthTransferTicket(file));assert.equal(syncFs.existsSync(file),true);await fs.unlink(path.join(f.root,'alias'));
  let reads=0;const io={...fs,open:async(...args)=>{const h=await fs.open(...args);return{stat:async()=>{const stat=await h.stat();return{...stat,uid:stat.uid+1,isFile:()=>true};},read:async()=>{reads++;throw Error('must not read');},close:()=>h.close()};}};
  await assert.rejects(readAuthTransferTicket(file,budget({io})));assert.equal(reads,0);assert.equal(syncFs.existsSync(file),true);
 }finally{await f.close();}
});
test('growing files are bounded to1025 bytes and a changed named inode is not consumed',async()=>{
 const f=await fixture(),t=ticket(),file=f.file(t);try{
  await writeAuthTransferTicket(file,t,budget());let observedBuffer=0,readBytes=0,stats=0;
  const io={...fs,open:async(...args)=>{const h=await fs.open(...args);return{stat:async()=>{const stat=await h.stat();if(++stats===1)await fs.appendFile(file,Buffer.alloc(4096,32));return stat;},read:async(...args)=>{observedBuffer=Math.max(observedBuffer,args[0].length);const read=await h.read(...args);readBytes+=read.bytesRead;return read;},close:()=>h.close()};}};
  await assert.rejects(readAuthTransferTicket(file,budget({io})));assert.equal(observedBuffer,1025);assert.equal(readBytes,1025);assert.equal(syncFs.existsSync(file),true);
  await fs.unlink(file);await writeAuthTransferTicket(file,t,budget());
  const changed={...fs,lstat:async(...args)=>{const stat=await fs.lstat(...args);return{...stat,ino:stat.ino+1,isFile:()=>true};}};
  await assert.rejects(readAuthTransferTicket(file,budget({io:changed})));assert.equal(syncFs.existsSync(file),true);
 }finally{await f.close();}
});
test('final close cannot return a ticket at deadline or after quit cancellation',async()=>{
 for(const abort of [false,true]){
  const f=await fixture(),t=ticket(),file=f.file(t),controller=new AbortController();let now=0;
  try{
   await writeAuthTransferTicket(file,t,budget());
   const io={...fs,open:async(...args)=>{const h=await fs.open(...args);return{stat:()=>h.stat(),read:(...args)=>h.read(...args),close:async()=>{await h.close();if(abort)controller.abort();else now=100;}};}};
   await assert.rejects(readAuthTransferTicket(file,{deadline:100,now:()=>now,signal:controller.signal,io}));assert.equal(syncFs.existsSync(file),false,'unlink already committed; no retry is promised');
  }finally{await f.close();}
 }
});

test('ordinary null ticket survives six months and wall rollback; planned expiry remains finite',async()=>{
 const f=await fixture(),original=Date.now;
 try{
  for(const delta of [180*86400000,-180*86400000]){
   const t=ticket();await writeAuthTransferTicket(f.file(t),t,budget());const base=original();Date.now=()=>base+delta;
   assert.deepEqual(await readAuthTransferTicket(f.file(t)),t);assert.equal(await readAuthTransferTicket(f.file(t)),null);Date.now=original;
  }
  const t=ticket({purpose:'planned-update',deadline:original()+120000});await writeAuthTransferTicket(f.file(t),t,budget());const expiry=t.deadline;Date.now=()=>expiry;
  await assert.rejects(readAuthTransferTicket(f.file(t)));
 }finally{Date.now=original;await f.close();}
});
