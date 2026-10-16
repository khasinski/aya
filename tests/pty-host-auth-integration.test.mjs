import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {once} from 'node:events';

fs.mkdirSync('test-results',{recursive:true});
const home=fs.mkdtempSync(path.resolve('test-results/auth-real-host-'));
process.env.AYA_HOME=home;process.env.HOME=home;process.env.SHELL='/bin/sh';
const {PtyHostClient}=await import('../dist-electron/pty-host-client.js');
const {waitFor,fakeWebContents,ptyEventsFor}=await import('./helpers/pty-host.mjs');
const socketPath=path.join(home,'pty-host.sock'),keyFile=path.join(home,'pty-host-auth/key');
const main=new PtyHostClient(path.resolve('dist-electron/pty-host.js')),sink=fakeWebContents();main.attachWebContents(sink);
let originalKey,pid,hostPid;
const output=()=>ptyEventsFor(sink,'auth-pane').filter(e=>e.type==='data').map(e=>e.chunk).join('');
before(async()=>{
 await main.spawn({ptyId:'auth-pane',command:'stty -echo; printf READY_AUTH; cat',cwd:home,cols:80,rows:24});
 await waitFor(()=>output().includes('READY_AUTH'));originalKey=Buffer.from(main.hostAuthKey);pid=await main.getPid('auth-pane');hostPid=(await main.hostStatus()).pid;
});
after(async()=>{try{await main.shutdown();}finally{main.dispose();fs.rmSync(home,{recursive:true,force:true});}});
async function raw(){const socket=net.createConnection(socketPath);socket.setEncoding('utf8');socket.on('error',()=>{});await once(socket,'connect');return socket;}
test('every normal RPC is refused before authentication, without changing the real pane or owner', {timeout:20000},async()=>{
 const union=fs.readFileSync('electron/pty-host-protocol.ts','utf8').split('export type PtyHostRequest =')[1].split('export type PtyHostResponse')[0];
 const types=[...new Set([...union.matchAll(/type:\s*["']([^"']+)["']/g)].map(match=>match[1]).concat(['constructor','__proto__','vt-snapshot','exit-applied']))];
 assert.ok(types.includes('version')&&types.includes('handover-claim')&&types.includes('kill'));
 for(const type of types){
  const socket=await raw();let data='';socket.on('data',chunk=>data+=chunk);const closed=once(socket,'close');
  socket.write(JSON.stringify({id:17,type,ptyId:'auth-pane',data:'FORBIDDEN\n',query:'READY',cols:10,rows:10,nonce:'c'.repeat(64),deadline:Date.now()+100000,req:{ptyId:'forbidden',command:'printf FORBIDDEN',cwd:home,cols:80,rows:24}})+'\n');
  await closed;const messages=data.trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(messages,[{id:-1,ok:false,code:'PTY_HOST_AUTH_REQUIRED',error:'Terminal host authentication required'}],type);
  assert.equal(await main.getPid('auth-pane'),pid,type);assert.equal((await main.hostStatus()).pid,hostPid,type);
 }
 const status=await main.hostStatus();assert.equal(status.ptyCount,1);assert.equal(status.owner.inventory.length,1);assert.ok(!output().includes('FORBIDDEN'));
 assert.deepEqual(await main.getSize('auth-pane'),{cols:80,rows:24,alt:false});
});
test('an accepted but unproven socket receives no broadcast output or pane metadata', {timeout:15000},async()=>{
 const socket=await raw();let data='';socket.on('data',chunk=>data+=chunk);
 const closed=once(socket,'close');socket.write(JSON.stringify({type:'pty-auth-hello',version:1,nonce:'d'.repeat(64)})+'\n');
 await waitFor(()=>data.includes('pty-auth-challenge'));data='';
 await main.write('auth-pane','PRIVATE_AUTH_OUTPUT\n');await waitFor(()=>output().includes('PRIVATE_AUTH_OUTPUT'));
 socket.write('{"id":19,"type":"version"}\n');await closed;
 assert.deepEqual(data.trim().split('\n').map(line=>JSON.parse(line)),[{id:-1,ok:false,code:'PTY_HOST_AUTH_REQUIRED',error:'Terminal host authentication required'}]);
});
test('missing or wrong in-memory capability cannot reach the generic create-host fallback', {timeout:15000},async()=>{
 for(const corruption of ['missing','wrong']){
  const before=fs.lstatSync(socketPath),other=new PtyHostClient(path.resolve('dist-electron/pty-host.js')),refusedSink=fakeWebContents();other.attachWebContents(refusedSink);let starts=0;
  if(corruption==='wrong')other.hostAuthKey=Buffer.alloc(32,1);
  other.startHost=()=>{starts++;throw new Error('unexpected host creation');};
  try{
   await assert.rejects(other.spawn({ptyId:'must-not-spawn',command:'cat',cwd:home,cols:80,rows:24}),error=>['PTY_HOST_AUTH_UNAVAILABLE','PTY_HOST_AUTH_REQUIRED'].includes(error.code)&&error.message==='The terminal host is disconnected or recovering. This request was not sent.');
   const notice=ptyEventsFor(refusedSink,'must-not-spawn');assert.equal(notice.length,1);assert.equal(notice[0].type,'disconnected');assert.match(notice[0].reason,corruption==='wrong'?/could not authenticate/:/cannot be reattached by this Aya/);assert.ok(!notice.some(e=>e.type==='no-session'||e.type==='exit'));
   const lateSink=fakeWebContents();other.attachWebContents(lateSink);assert.deepEqual(ptyEventsFor(lateSink,'must-not-spawn'),notice);
   const status=await other.hostStatus();assert.equal(status.authentication.unannounced,corruption==='missing'?true:undefined);assert.equal(status.pid,hostPid);assert.equal(status.authentication.targetVerified,true);
   assert.equal(starts,0);assert.equal(fs.lstatSync(socketPath).ino,before.ino);assert.equal(await main.getPid('auth-pane'),pid);assert.equal((await main.hostStatus()).pid,hostPid);
   const refused=await other.hostStatus();assert.equal(refused.pid,hostPid,corruption);assert.equal(refused.authentication?.inventoryKnown,true,corruption);assert.equal(refused.authentication?.targetVerified,true,corruption);
   assert.deepEqual(refused.owner?.inventory.map(p=>[p.id,p.pid]),[['auth-pane',pid]],corruption);assert.equal(refused.ptyCount,1);assert.equal(starts,0);
   assert.equal(fs.existsSync(keyFile),false);
  }finally{other.dispose();}
 }
 await main.write('auth-pane','STILL_USABLE\n');await waitFor(()=>output().includes('STILL_USABLE'));
});

test('refusal cache survives failed kill but retires on a real successful attach and kill', {timeout:15000},async()=>{
 const other=new PtyHostClient(path.resolve('dist-electron/pty-host.js'));
 const req={ptyId:'auth-pane',command:'cat',cwd:home,cols:80,rows:24,attachOnly:true};
 const late=()=>{const sink=fakeWebContents();other.attachWebContents(sink);other.detachWebContents(sink);return ptyEventsFor(sink,'auth-pane');};
 try{
  other.hostAuthKey=null;await assert.rejects(other.spawn(req));await assert.rejects(other.kill('auth-pane'));
  assert.equal(late()[0].type,'disconnected');assert.equal(await main.getPid('auth-pane'),pid);
  other.hostAuthKey=Buffer.from(originalKey);await other.spawn(req);assert.deepEqual(late(),[]);
  other.dropSocket();other.hostAuthKey=null;other.hostAuthKey=null;await assert.rejects(other.spawn(req));assert.equal(late()[0].type,'disconnected');
  other.hostAuthKey=Buffer.from(originalKey);await other.kill('auth-pane');assert.equal(await main.getPid('auth-pane'),null);assert.deepEqual(late(),[]);
 }finally{other.dispose();}
});

test('authoritative exit/no-session and a known ended attachment retire only that pane refusal',async()=>{
 for(const kind of ['exit','no-session','ended-attach']){
  const client=new PtyHostClient('unused');client.authRefusedPanes.set('done','stale notice');client.authRefusedPanes.set('keep','still unknown');
  try{
   if(kind==='ended-attach'){client.endedBootPanes.set('done',23);await client.spawn({ptyId:'done',command:'cat',cwd:home,cols:80,rows:24,attachOnly:true});}
   else client.onData(JSON.stringify({type:'event',event:{type:kind,ptyId:'done',...(kind==='exit'?{exitCode:23}:{})}})+'\n');
   const sink=fakeWebContents();client.attachWebContents(sink);assert.deepEqual(ptyEventsFor(sink,'done'),[],kind);assert.equal(ptyEventsFor(sink,'keep')[0].reason,'still unknown',kind);
  }finally{client.dispose();}
 }
});
