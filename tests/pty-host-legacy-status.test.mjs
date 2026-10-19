import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
fs.mkdirSync('test-results',{recursive:true});const home=fs.mkdtempSync(path.resolve('test-results/legacy-status-'));
process.env.AYA_HOME=home;
const {probeLegacyInventory}=require('../dist-electron/pty-host-legacy-status.js');
const {ownerProcessStartIdentity}=require('../dist-electron/pty-owner-client.js');
const file=path.join(home,'pty-hosts'),requests=path.join(home,'requests.jsonl');
const source=`const fs=require('fs'),net=require('net'),path=require('path');if(process.env.LEGACY_MODE==='no-ready')process.exit(2);const registry=require(path.join(process.env.AYA_TEST_APP_ROOT,'dist-electron/pty-host-registry.js'));const info=registry.readProcInfo(process.pid);registry.writeHostRecord({pid:process.pid,pgid:process.pid,startTime:info.startTime,version:'0.12.0',scriptHash:'a'.repeat(64),nonce:'legacy'});net.createServer(socket=>{let buf='';socket.on('error',()=>{});socket.on('data',data=>{buf+=data;let end;while((end=buf.indexOf('\\n'))>=0){const req=JSON.parse(buf.slice(0,end));buf=buf.slice(end+1);fs.appendFileSync(process.env.AYA_TEST_REQUEST_LOG,JSON.stringify(req)+'\\n');if(process.env.LEGACY_MODE==='silent')continue;let result=req.type==='version'?{version:'0.12.0',scriptHash:'a'.repeat(64),pid:process.pid,ptyCount:2}:req.ptyId==='saved'?{cols:80,rows:24}:null;if(process.env.LEGACY_MODE==='wrong-pid'&&req.type==='version')result.pid++;if(process.env.LEGACY_MODE==='too-many'&&req.type==='version')result.ptyCount=26;if(process.env.LEGACY_MODE==='flood'){socket.write('x'.repeat(70000));continue;}socket.write(JSON.stringify({id:req.id,ok:true,result})+'\\n');}});}).listen(path.join(process.env.AYA_HOME,'pty-host.sock'),()=>console.log('READY'));`;
function waitForReady(child, timeoutMs=5000){
 return new Promise((resolve,reject)=>{
  let output='',errors='';
  const finish=error=>{clearTimeout(timer);child.stdout.off('data',onData);child.stderr.off('data',onErrorText);child.off('error',onError);child.off('exit',onExit);error?reject(error):resolve();};
  const onData=data=>{output=(output+data.toString()).slice(-4096);if(output.includes('READY\n'))finish();};
  const onErrorText=data=>{errors=(errors+data.toString()).slice(-4096);};
  const onError=error=>finish(new Error(`legacy fixture failed to spawn: ${error.message}`));
  const onExit=(code,signal)=>finish(new Error(`legacy fixture exited before READY (code ${code}, signal ${signal}); stderr: ${errors.trim()||'(empty)'}`));
  const timer=setTimeout(()=>finish(new Error(`legacy fixture did not become READY in ${timeoutMs} ms; stdout: ${output.trim()||'(empty)'}; stderr: ${errors.trim()||'(empty)'}`)),timeoutMs);
  child.stdout.on('data',onData);child.stderr.on('data',onErrorText);child.once('error',onError);child.once('exit',onExit);
 });
}
async function fixture(mode,body){
 fs.rmSync(home,{recursive:true,force:true});fs.mkdirSync(home,{recursive:true});
 const child=spawn(process.execPath,['-e',source],{detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env,ELECTRON_RUN_AS_NODE:'1',LEGACY_MODE:mode,AYA_TEST_APP_ROOT:path.resolve('.'),AYA_TEST_REQUEST_LOG:requests}}),exit=new Promise(resolve=>{child.once('exit',(code,signal)=>resolve([code,signal]));child.once('error',error=>resolve([null,error]));});
 try{await waitForReady(child);await body({pid:child.pid,startIdentity:ownerProcessStartIdentity(child.pid)});}
 finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exit;fs.rmSync(home,{recursive:true,force:true});}
}
test('legacy fixture reports a child that exits before READY instead of leaving startup pending', {timeout:3000}, async()=>{
 await assert.rejects(fixture('no-ready',async()=>{}),/legacy fixture exited before READY \(code 2, signal null\)/);
});
const readRequests=()=>fs.existsSync(requests)?fs.readFileSync(requests,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[];
test('v0.12.0 read-only migration reports one saved pane plus one unknown, without requesting a credential or trusting reply PID',()=>fixture('',async peer=>{
 assert.deepEqual(await probeLegacyInventory(peer,['saved','gone']),{reportedIds:['saved'],unknownCount:1,total:2});
 assert.deepEqual(readRequests().map(r=>[r.type,r.ptyId]),[['version',undefined],['size','saved'],['size','gone']]);
}));
test('new auth marker, unknown hash/version, changed kernel or registry identity send no legacy request',()=>fixture('',async peer=>{
 const record=path.join(file,`${peer.pid}.json`),original=JSON.parse(fs.readFileSync(record,'utf8'));
 for(const patch of [{authProtocol:1},{scriptHash:'unknown'},{version:'99.0.0'},{startTime:'another instance'}]){
  fs.writeFileSync(record,JSON.stringify({...original,...patch}),{mode:0o600});assert.equal(await probeLegacyInventory(peer,['saved']),null);assert.deepEqual(readRequests(),[]);
 }
 fs.writeFileSync(record,JSON.stringify(original),{mode:0o600});assert.equal(await probeLegacyInventory({...peer,startIdentity:'0:0'},['saved']),null);assert.deepEqual(readRequests(),[]);
}));
test('unsafe or over-limit legacy records refuse before any socket request, including FIFOs',()=>fixture('',async peer=>{
 const file=path.join(home,'pty-hosts',`${peer.pid}.json`),original=fs.readFileSync(file),backup=file+'.backup';
 const {execFileSync}=await import('node:child_process');
 for(const kind of ['mode','symlink','fifo','large']){
  fs.rmSync(file,{force:true});fs.writeFileSync(file,original,{mode:0o600});
  if(kind==='mode')fs.chmodSync(file,0o644);
  if(kind==='symlink'){fs.renameSync(file,backup);fs.symlinkSync(backup,file);}
  if(kind==='fifo'){fs.unlinkSync(file);execFileSync('/usr/bin/mkfifo',[file]);fs.chmodSync(file,0o600);}
  if(kind==='large')fs.writeFileSync(file,JSON.stringify({...JSON.parse(original),padding:'x'.repeat(16384)}));
  const start=Date.now();assert.equal(await probeLegacyInventory(peer,['saved']),null);assert.ok(Date.now()-start<500,kind);assert.deepEqual(readRequests(),[]);
 }
}));
for(const mode of ['wrong-pid','too-many','flood','silent'])test(`legacy ${mode} refuses with bounded time and no stop side effect`,{timeout:4000},()=>fixture(mode,async peer=>{
 const start=Date.now();assert.equal(await probeLegacyInventory(peer,['saved']),null);assert.ok(Date.now()-start<2000);assert.doesNotThrow(()=>process.kill(peer.pid,0));
 assert.ok(readRequests().length<=1);
}));
test('legacy query budget caps saved IDs at25 and refuses a record changed during the read',()=>fixture('',async peer=>{
 const result=await probeLegacyInventory(peer,['saved',...Array.from({length:100},(_,i)=>'unknown'+i)]);assert.equal(result.total,2);assert.equal(readRequests().length,26);
 const record=path.join(file,`${peer.pid}.json`),original=JSON.parse(fs.readFileSync(record,'utf8'));
 const probe=probeLegacyInventory(peer,['saved']);fs.writeFileSync(record,JSON.stringify({...original,authProtocol:1}),{mode:0o600});assert.equal(await probe,null);
}));
for(const phase of ['preflight','final'])test(`a blocked ${phase} ps cannot outlive the absolute migration deadline or send late requests`,{timeout:3000},()=>fixture('',async peer=>{
 const cp=require('node:child_process'),original=cp.execFile;let calls=0,kills=0;
 try{
  cp.execFile=(command,args,options,callback)=>{
   assert.equal(command,'ps');assert.ok(options.timeout>0&&options.timeout<=1000);assert.equal(options.killSignal,'SIGKILL');assert.equal(options.maxBuffer,1024);
   if(++calls===(phase==='preflight'?1:2))return {kill:signal=>{assert.equal(signal,'SIGKILL');kills++;},stdout:{destroy(){}},stderr:{destroy(){}}};
   return original(command,args,options,callback);
  };
  const start=performance.now();assert.equal(await probeLegacyInventory(peer,['saved']),null);
  assert.ok(performance.now()-start<1500);assert.equal(kills,1);assert.equal(readRequests().length,phase==='preflight'?0:2);
 }finally{cp.execFile=original;}
}));
for(const phase of ['preflight','final'])test(`a ${phase} identity result arriving after the absolute deadline is never accepted`,()=>fixture('',async peer=>{
 const cp=require('node:child_process'),original=cp.execFile,clock=Date.now,base=clock();let now=base,calls=0;
 try{
  Date.now=()=>now;
  cp.execFile=(command,args,options,callback)=>{
   const call=++calls;
   return original(command,args,options,(error,stdout,stderr)=>{
    if(call===(phase==='preflight'?1:2))now=base+1001;
    callback(error,stdout,stderr);
   });
  };
  assert.equal(await probeLegacyInventory(peer,['saved']),null);assert.equal(readRequests().length,phase==='preflight'?0:2);
 }finally{Date.now=clock;cp.execFile=original;}
}));
