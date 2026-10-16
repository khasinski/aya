import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
fs.mkdirSync('test-results',{recursive:true});const home=fs.mkdtempSync(path.resolve('test-results/start-proof-'));
process.env.AYA_HOME=home;process.env.HOME=home;
const {hostCreationProof}=require('../dist-electron/pty-host-start-guard.js');
const {readProcInfo}=require('../dist-electron/pty-host-registry.js');
const {PtyHostClient}=require('../dist-electron/pty-host-client.js');
const registry=path.join(home,'pty-hosts'),ownerDir=path.join(home,'pty-owner'),ownerFile=path.join(ownerDir,'record.json');
after(()=>fs.rmSync(home,{recursive:true,force:true}));
function reset(){for(const dir of [registry,ownerDir])fs.rmSync(dir,{recursive:true,force:true});}
function record(pid=process.pid,startTime=readProcInfo(pid).startTime){
 fs.mkdirSync(registry,{mode:0o700,recursive:true});const file=path.join(registry,`${pid}.json`);
 fs.writeFileSync(file,JSON.stringify({pid,pgid:pid,startTime,version:'test',scriptHash:'a'.repeat(64),nonce:'a'.repeat(16)}),{mode:0o600});return file;
}
const observation=(alive,startTime,probeFailed=false)=>({alive,startTime,probeFailed,command:null});
test('creation has three states; only verified gone/reused records and an absent/empty registry allow it',()=>{
 reset();assert.equal(hostCreationProof().state,'gone');const file=record();
 for(const [info,expected] of [[observation(true,'same'),'alive'],[observation(false,null),'gone'],[observation(true,'other'),'gone'],[observation(false,null,true),'unknown'],[observation(true,null),'unknown']]){
  fs.writeFileSync(file,JSON.stringify({pid:process.pid,pgid:process.pid,startTime:'same'}));
  assert.equal(hostCreationProof(registry,()=>info).state,expected);
 }
 fs.unlinkSync(file);assert.equal(hostCreationProof().state,'gone');
});
test('a registered reader blocks creation even when there is no group-leading host record',()=>{
 reset();fs.mkdirSync(ownerDir,{mode:0o700});fs.writeFileSync(ownerFile,JSON.stringify({jsPid:process.pid,jsStartTime:'same'}),{mode:0o600});
 assert.equal(hostCreationProof(registry,()=>observation(true,'same')).state,'alive');
 assert.equal(hostCreationProof(registry,()=>observation(true,'new')).state,'gone');
 assert.equal(hostCreationProof(registry,()=>observation(false,null,true)).state,'unknown');
});
test('read failures, malformed/private-file failures and incomplete temporary records are unknown, never deleted',()=>{
 reset();const file=record(),read=fs.readdirSync;
 try{fs.readdirSync=(directory,...args)=>{if(directory===registry)throw Object.assign(Error('injected private read denial'),{code:'EACCES'});return read(directory,...args);};assert.equal(hostCreationProof().state,'unknown');}
 finally{fs.readdirSync=read;}
 for(const payload of ['{','null',JSON.stringify({pid:process.pid,pgid:process.pid,startTime:''})]){
  fs.writeFileSync(file,payload);const before=fs.statSync(file);assert.equal(hostCreationProof().state,'unknown');assert.equal(fs.statSync(file).ino,before.ino);assert.equal(fs.readFileSync(file,'utf8'),payload);
 }
 fs.writeFileSync(file,JSON.stringify({pid:process.pid,pgid:process.pid,startTime:'same'}));fs.chmodSync(file,0o644);
 assert.equal(hostCreationProof(registry,()=>observation(false,null)).state,'unknown');assert.equal(fs.statSync(file).mode&0o777,0o644);
 fs.chmodSync(file,0o600);fs.writeFileSync(path.join(registry,'pending.tmp'),'');assert.equal(hostCreationProof(registry,()=>observation(false,null)).state,'unknown');
});
test('a recorded live PID followed by ps EAGAIN is unknown for both absent and refused sockets, with no start attempt',async()=>{
 for(const code of ['ENOENT','ECONNREFUSED']){
  reset();record();assert.equal(hostCreationProof().state,'alive');let starts=0;
  const client=new PtyHostClient(path.resolve('dist-electron/pty-host.js')),exec=childProcess.execFileSync;
  client.openSocket=async()=>{throw Object.assign(Error('fixture socket absent'),{code});};client.startHost=()=>{starts++;};
  try{
   childProcess.execFileSync=()=>{throw Object.assign(Error('injected ps failure'),{code:'EAGAIN'});};
   assert.equal(hostCreationProof().state,'unknown');
   await assert.rejects(client.connectWithHostStart(),error=>error.code==='PTY_HOST_START_BLOCKED'&&error.proof.state==='unknown');
   assert.equal(starts,0);assert.equal(fs.existsSync(path.join(home,'pty-host-auth')),false);
  }finally{childProcess.execFileSync=exec;client.dispose();}
 }
});
test('absent/refused socket with a proven live record or unreadable registry never reaches startHost',async()=>{
 for(const code of ['ENOENT','ECONNREFUSED'])for(const unreadable of [false,true]){
  reset();record();let starts=0;const client=new PtyHostClient(path.resolve('dist-electron/pty-host.js')),read=fs.readdirSync;
  client.openSocket=async()=>{throw Object.assign(Error('fixture socket absent'),{code});};client.startHost=()=>{starts++;};
  try{
   if(unreadable)fs.readdirSync=(directory,...args)=>{if(directory===registry)throw Object.assign(Error('injected'),{code:'EACCES'});return read(directory,...args);};
   await assert.rejects(client.connectWithHostStart(),error=>error.code==='PTY_HOST_START_BLOCKED'&&(unreadable?error.proof.state==='unknown':['alive','unknown'].includes(error.proof.state)));
   assert.equal(starts,0);
  }finally{fs.readdirSync=read;client.dispose();}
 }
});
test('proven gone records allow the cold start branch for both socket errors without a real process spawn',async()=>{
 for(const code of ['ENOENT','ECONNREFUSED']){
  reset();const ended=childProcess.spawnSync(process.execPath,['-e','process.exit(0)'],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});assert.equal(ended.status,0);record(ended.pid,'old');let starts=0;const client=new PtyHostClient(path.resolve('dist-electron/pty-host.js'));
  client.openSocket=async()=>{throw Object.assign(Error('fixture socket absent'),{code});};client.startHost=()=>{starts++;};client.openStartedHostSocket=async()=>{};
  try{assert.equal(hostCreationProof().state,'gone');await client.connectWithHostStart();assert.equal(starts,1);}
  finally{client.dispose();}
 }
});
test('the final startHost check precedes unlinking the socket and forking',()=>{
 reset();record();const socket=path.join(home,'pty-host.sock');fs.writeFileSync(socket,'kept');const before=fs.statSync(socket),spawn=childProcess.spawn;
 const client=new PtyHostClient(path.resolve('dist-electron/pty-host.js'));client.hostAuthKey=Buffer.alloc(32);let spawns=0;
 try{
  childProcess.spawn=()=>{spawns++;throw Error('unexpected fork');};
  assert.throws(()=>client.startHost(),{code:'PTY_HOST_START_BLOCKED'});assert.equal(spawns,0);assert.equal(fs.statSync(socket).ino,before.ino);assert.equal(fs.readFileSync(socket,'utf8'),'kept');
 }finally{childProcess.spawn=spawn;client.dispose();fs.unlinkSync(socket);}
});

test('spawn maps live and unknown start refusals to one friendly disconnected state without start or unlink',async()=>{
 for(const code of ['ENOENT','ECONNREFUSED'])for(const unknown of [false,true]){
  reset();record();const socket=path.join(home,'pty-host.sock');fs.writeFileSync(socket,'kept-socket-inode');const before=fs.statSync(socket);
  const client=new PtyHostClient(path.resolve('dist-electron/pty-host.js')),exec=childProcess.execFileSync,remove=fs.rmSync;let starts=0,unlinks=0;const events=[];
  const sink={isDestroyed:()=>false,send:(_channel,event)=>events.push(event)};client.attachWebContents(sink);
  client.openSocket=async()=>{throw Object.assign(Error('injected socket failure'),{code});};client.startHost=()=>{starts++;throw Error('must not start');};
  try{
   fs.rmSync=(file,...args)=>{if(file===socket)unlinks++;return remove(file,...args);};
   if(unknown)childProcess.execFileSync=()=>{throw Object.assign(Error('injected ps EAGAIN'),{code:'EAGAIN'});};
   await assert.rejects(client.spawn({ptyId:'blocked',command:'cat',cwd:home,cols:80,rows:24}),error=>error.code==='PTY_HOST_START_BLOCKED'&&error.message==='The terminal host is disconnected or recovering. This request was not sent.');
   assert.equal(events.length,1);assert.equal(events[0].type,'disconnected');assert.equal(events[0].ptyId,'blocked');assert.match(events[0].reason,/inventory could not be verified/);
   const late=[];client.attachWebContents({isDestroyed:()=>false,send:(_channel,event)=>late.push(event)});assert.deepEqual(late,events);
   assert.equal(starts,0);assert.equal(unlinks,0);assert.equal(fs.statSync(socket).ino,before.ino);assert.equal(fs.readFileSync(socket,'utf8'),'kept-socket-inode');
  }finally{childProcess.execFileSync=exec;fs.rmSync=remove;client.dispose();fs.unlinkSync(socket);}
 }
});

test('socketless verified host gets one bounded shutdown grace, never an absence bypass',async()=>{
 const {waitForHostShutdown,HOST_SHUTDOWN_GRACE_MS}=require('../dist-electron/pty-host-start-guard.js');assert.equal(HOST_SHUTDOWN_GRACE_MS,3000);
 const alive={state:'alive',hosts:[{pid:100,startTime:'same',state:'alive'}]},gone={state:'gone',hosts:[{pid:100,startTime:'same',state:'gone'}]};
 let now=0,reads=0;await waitForHostShutdown('unused',undefined,{now:()=>now,proof:()=>{reads++;return now<750?alive:gone;},socketMissing:()=>true,wait:async ms=>{now+=ms;}});
 assert.equal(now,750);assert.ok(reads>1);
 now=0;await assert.rejects(waitForHostShutdown('unused',undefined,{now:()=>now,proof:()=>alive,socketMissing:()=>true,wait:async ms=>{now+=ms;}}),{code:'PTY_HOST_START_BLOCKED'});assert.equal(now,3000);
 now=0;await assert.rejects(waitForHostShutdown('unused',undefined,{now:()=>now,proof:()=>({state:'unknown',hosts:[]}),socketMissing:()=>true,wait:async ms=>{now+=ms;}}),{code:'PTY_HOST_START_BLOCKED'});assert.equal(now,0);
 now=0;await assert.rejects(waitForHostShutdown('unused',undefined,{now:()=>now,proof:()=>alive,socketMissing:()=>false,wait:async ms=>{now+=ms;}}),{code:'PTY_HOST_START_BLOCKED'});assert.equal(now,0);
});
test('quit during the socketless shutdown grace cancels before a new proof or host start',async()=>{
 const {waitForHostShutdown}=require('../dist-electron/pty-host-start-guard.js');const cancelled=new AbortController();let probes=0;
 await assert.rejects(waitForHostShutdown('unused',cancelled.signal,{proof:()=>{probes++;return {state:'alive',hosts:[]};},socketMissing:()=>true,wait:async()=>cancelled.abort()}),/cancelled/);
 assert.equal(probes,1);
});
test('the shutdown grace bounds each ps to the remaining budget and failed ps stays unknown',()=>{
 reset();record();const exec=childProcess.execFileSync;let observed;
 try{childProcess.execFileSync=(_file,_args,options)=>{observed=options;throw Object.assign(Error('timeout'),{code:'ETIMEDOUT'});};assert.deepEqual(readProcInfo(process.pid,37),{alive:false,probeFailed:true,startTime:null,command:null});assert.equal(observed.timeout,37);assert.equal(observed.killSignal,'SIGKILL');}
 finally{childProcess.execFileSync=exec;}
});

test('a live shutdown candidate that becomes unknown is never treated as gone during the grace',async()=>{
 const {waitForHostShutdown}=require('../dist-electron/pty-host-start-guard.js');let now=0;
 await assert.rejects(waitForHostShutdown('unused',undefined,{now:()=>now,proof:()=>({state:now<750?'alive':'unknown',hosts:[]}),socketMissing:()=>true,wait:async ms=>{now+=ms;}}),error=>error.code==='PTY_HOST_START_BLOCKED'&&error.proof.state==='unknown');assert.equal(now,3000);
});
