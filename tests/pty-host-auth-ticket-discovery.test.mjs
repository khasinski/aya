import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {authTransferTicketPath,writeAuthTransferTicket,findAuthTransferTicket,cancelAuthTransferTicket} from '../dist-electron/pty-host-auth-ticket.js';
const budget=extra=>({deadline:performance.now()+1000,...extra});
const ticket=extra=>({format:2,attempt:'a'.repeat(64),purpose:'ordinary-quit',nonce:'b'.repeat(64),deadline:Date.now()+120000,hostPid:123,hostStartIdentity:'10:2',...extra});
async function fixture(){await fs.mkdir('test-results',{recursive:true});const root=await fs.mkdtemp(path.resolve('test-results/auth-discovery-'));return{root,file:t=>authTransferTicketPath(root,t.attempt),close:()=>fs.rm(root,{recursive:true,force:true})};}
test('startup discovers and consumes only one fixed attempt ticket, ignoring old disk keys and B3 artifacts',async()=>{
 const f=await fixture(),t=ticket();try{
  await fs.mkdir(path.join(f.root,'pty-host-auth'),{mode:0o700});await fs.writeFile(path.join(f.root,'pty-host-auth/key'),Buffer.alloc(32,7),{mode:0o600});
  await fs.writeFile(path.join(f.root,'pty-handover.json'),'old B3 artifact');await fs.writeFile(path.join(f.root,'pty-handover.bad.json'),'bad');
  assert.equal(await findAuthTransferTicket(f.root),null);
  await writeAuthTransferTicket(f.file(t),t,budget());assert.deepEqual(await findAuthTransferTicket(f.root),t);assert.equal(await findAuthTransferTicket(f.root),null);
  assert.deepEqual(await fs.readFile(path.join(f.root,'pty-host-auth/key')),Buffer.alloc(32,7));
 }finally{await f.close();}
});
test('ambiguous valid attempts refuse without consuming either or selecting by directory order',async()=>{
 const f=await fixture(),a=ticket(),b=ticket({attempt:'c'.repeat(64)});try{
  await writeAuthTransferTicket(f.file(a),a,budget());await writeAuthTransferTicket(f.file(b),b,budget());
  await assert.rejects(findAuthTransferTicket(f.root),/ticket is unavailable/);assert.equal((await fs.readdir(f.root)).length,2);
 }finally{await f.close();}
});
test('directory iteration is capped before any ticket is consumed and unsafe directories or ticket types refuse',async()=>{
 const f=await fixture(),t=ticket();try{
  await Promise.all(Array.from({length:257},(_,i)=>fs.writeFile(path.join(f.root,`entry-${i}`),'')));
  await writeAuthTransferTicket(f.file(t),t,budget());await assert.rejects(findAuthTransferTicket(f.root));assert.ok(await fs.stat(f.file(t)),'entry cap refuses before consuming a valid ticket');
  await fs.rm(f.root,{recursive:true});await fs.mkdir(f.root,{mode:0o700});
  await fs.chmod(f.root,0o775);await assert.rejects(findAuthTransferTicket(f.root));await fs.chmod(f.root,0o700);
  const alias=f.root+'-alias';await fs.symlink(f.root,alias);try{await assert.rejects(findAuthTransferTicket(alias));}finally{await fs.unlink(alias);}
  await fs.symlink('absent',f.file(t));await assert.rejects(findAuthTransferTicket(f.root));
 }finally{await f.close();}
});
test('final directory close and metadata probe cannot return a late discovery before the timer fires',async()=>{
 const f=await fixture();try{
  for(const step of ['close','lstat']){
   let now=0,stats=0,closed=0;
   const scanIO={lstat:async(...args)=>{const result=await fs.lstat(...args);if(++stats===2&&step==='lstat')now=100;return result;},opendir:async(...args)=>{const dir=await fs.opendir(...args);return{read:()=>dir.read(),close:async()=>{await dir.close();closed++;if(step==='close')now=100;}};}};
   await assert.rejects(findAuthTransferTicket(f.root,{deadline:100,now:()=>now,scanIO}));assert.equal(closed,1);
  }
 }finally{await f.close();}
});
test('quit cancellation removes only its own nonce, including expired tickets, never a successor attempt',async()=>{
 const f=await fixture(),a=ticket(),b=ticket({attempt:'c'.repeat(64),nonce:'d'.repeat(64)});try{
  await writeAuthTransferTicket(f.file(a),a,budget());await writeAuthTransferTicket(f.file(b),b,budget());
  await cancelAuthTransferTicket(f.file(a),a.attempt,b.nonce);assert.ok(await fs.stat(f.file(a)));
  await fs.writeFile(f.file(a),JSON.stringify({...a,deadline:Date.now()-1}));await cancelAuthTransferTicket(f.file(a),a.attempt,a.nonce);
  await assert.rejects(fs.stat(f.file(a)),{code:'ENOENT'});assert.ok(await fs.stat(f.file(b)));
  await cancelAuthTransferTicket(f.file(a),a.attempt,a.nonce);assert.deepEqual(await findAuthTransferTicket(f.root),b);
 }finally{await f.close();}
});
test('cancel refuses changed inode, unsafe types and a late final close, preserving other nonce bytes',async()=>{
 const f=await fixture(),t=ticket();try{
  await writeAuthTransferTicket(f.file(t),t,budget());
  const changed={...fs,lstat:async(...args)=>{const stat=await fs.lstat(...args);return{...stat,ino:stat.ino+1,isFile:()=>true};}};
  await assert.rejects(cancelAuthTransferTicket(f.file(t),t.attempt,t.nonce,budget({io:changed})));assert.ok(await fs.stat(f.file(t)));
  await fs.chmod(f.file(t),0o644);await assert.rejects(cancelAuthTransferTicket(f.file(t),t.attempt,t.nonce));await fs.chmod(f.file(t),0o600);
  let now=0;const io={...fs,open:async(...args)=>{const h=await fs.open(...args);return{stat:()=>h.stat(),read:(...args)=>h.read(...args),close:async()=>{await h.close();now=100;}};}};
  await assert.rejects(cancelAuthTransferTicket(f.file(t),t.attempt,'e'.repeat(64),{deadline:100,now:()=>now,io}));assert.ok(await fs.stat(f.file(t)));
 }finally{await f.close();}
});

test('ordinary0755 config root permits private0600 ticket without permission repair or group-write acceptance',async()=>{
 const f=await fixture(),t=ticket();try{
  await fs.chmod(f.root,0o755);await writeAuthTransferTicket(f.file(t),t,budget());assert.deepEqual(await findAuthTransferTicket(f.root),t);assert.equal((await fs.stat(f.root)).mode&0o7777,0o755);
  await writeAuthTransferTicket(f.file(t),t,budget());await fs.chmod(f.file(t),0o644);await assert.rejects(findAuthTransferTicket(f.root));assert.equal((await fs.stat(f.file(t))).mode&0o7777,0o644);
 }finally{await f.close();}
});
