import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
fs.mkdirSync('test-results',{recursive:true});const home=fs.mkdtempSync(path.resolve('test-results/start-proof-'));
process.env.AYA_HOME=home;process.env.HOME=home;
const {hostCreationProof,hostCreationPermit}=require('../dist-electron/pty-host-start-guard.js');
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
const realExecFile=childProcess.execFile,execSync=childProcess.execFileSync;
/** One fake ps for both readers: impl's return is stdout and its throw the failure; the async form answers on a later
 *  turn, as a real ps would. Returns the restore function. */
function fakePs(impl){
 const exec=childProcess.execFileSync;
 childProcess.execFileSync=(...args)=>impl(...args);
 childProcess.execFile=(command,args,options,callback)=>{let out,error=null;try{out=impl(command,args,options);}catch(e){error=e;}setImmediate(()=>error?callback(error,'',''):callback(null,out,''));return {pid:0};};
 return ()=>{childProcess.execFileSync=exec;childProcess.execFile=realExecFile;};
}
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
  const client=new PtyHostClient(path.resolve('dist-electron/pty-host.js'));let restore=()=>{};
  client.openSocket=async()=>{throw Object.assign(Error('fixture socket absent'),{code});};client.startHost=()=>{starts++;};
  try{
   restore=fakePs(()=>{throw Object.assign(Error('injected ps failure'),{code:'EAGAIN'});});
   assert.equal(hostCreationProof().state,'unknown');assert.equal((await hostCreationPermit()).state,'unknown');
   await assert.rejects(client.connectWithHostStart(),error=>error.code==='PTY_HOST_START_BLOCKED'&&error.proof.state==='unknown');
   assert.equal(starts,0);assert.equal(fs.existsSync(path.join(home,'pty-host-auth')),false);
  }finally{restore();client.dispose();}
 }
});
test('absent/refused socket with a proven live record or unreadable registry never reaches startHost',async()=>{
 for(const code of ['ENOENT','ECONNREFUSED'])for(const unreadable of [false,true]){
  reset();record();let starts=0;const client=new PtyHostClient(path.resolve('dist-electron/pty-host.js')),read=fs.readdirSync;
  const savedStartTime=readProcInfo(process.pid).startTime;const diagnose=()=>{const info=readProcInfo(process.pid);console.error('LIVE_START_GUARD_FAILURE',JSON.stringify({at:new Date().toISOString(),pid:process.pid,savedStartTime,observed:{alive:info.alive,probeFailed:info.probeFailed,startTime:info.startTime},code,unreadable,starts,proof:hostCreationProof()}));};
  client.openSocket=async()=>{throw Object.assign(Error('fixture socket absent'),{code});};client.startHost=()=>{starts++;diagnose();};
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
  const client=new PtyHostClient(path.resolve('dist-electron/pty-host.js')),remove=fs.rmSync;let starts=0,unlinks=0,restore=()=>{};const events=[];
  const sink={isDestroyed:()=>false,send:(_channel,event)=>events.push(event)};client.attachWebContents(sink);
  client.openSocket=async()=>{throw Object.assign(Error('injected socket failure'),{code});};client.startHost=()=>{starts++;throw Error('must not start');};
  try{
   fs.rmSync=(file,...args)=>{if(file===socket)unlinks++;return remove(file,...args);};
   if(unknown)restore=fakePs(()=>{throw Object.assign(Error('injected ps EAGAIN'),{code:'EAGAIN'});});
   await assert.rejects(client.spawn({ptyId:'blocked',command:'cat',cwd:home,cols:80,rows:24}),error=>error.code==='PTY_HOST_START_BLOCKED'&&error.message==='The terminal host is disconnected or recovering. This request was not sent.');
   assert.equal(events.length,1);assert.equal(events[0].type,'disconnected');assert.equal(events[0].ptyId,'blocked');assert.match(events[0].reason,/inventory could not be verified/);
   const late=[];client.attachWebContents({isDestroyed:()=>false,send:(_channel,event)=>late.push(event)});assert.deepEqual(late,events);
   assert.equal(starts,0);assert.equal(unlinks,0);assert.equal(fs.statSync(socket).ino,before.ino);assert.equal(fs.readFileSync(socket,'utf8'),'kept-socket-inode');
  }finally{restore();fs.rmSync=remove;client.dispose();fs.unlinkSync(socket);}
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
 try{childProcess.execFileSync=(_file,_args,options)=>{observed=options;throw Object.assign(Error('timeout'),{code:'ETIMEDOUT'});};assert.deepEqual(readProcInfo(process.pid,37),{alive:true,probeFailed:true,startTime:null,command:null});assert.equal(observed.timeout,37);assert.equal(observed.killSignal,'SIGKILL');}
 finally{childProcess.execFileSync=exec;}
});

test('a live shutdown candidate that becomes unknown is never treated as gone during the grace',async()=>{
 const {waitForHostShutdown}=require('../dist-electron/pty-host-start-guard.js');let now=0;
 await assert.rejects(waitForHostShutdown('unused',undefined,{now:()=>now,proof:()=>({state:now<750?'alive':'unknown',hosts:[]}),socketMissing:()=>true,wait:async ms=>{now+=ms;}}),error=>error.code==='PTY_HOST_START_BLOCKED'&&error.proof.state==='unknown');assert.equal(now,3000);
});

test('actual client.dispose interrupts the default shutdown grace before any host creation',async()=>{
 reset();fs.rmSync(path.join(home,'pty-host-auth'),{recursive:true,force:true});record();const client=new PtyHostClient('unused');let starts=0,ready;
 const began=new Promise(resolve=>{ready=resolve;});
 client.openSocket=async()=>{throw Object.assign(Error('missing'),{code:'ENOENT'});};client.startHost=()=>{starts++;};
 let timeout;
 try{
  childProcess.execFile=(...args)=>{const child=realExecFile(...args);ready();return child;};
  const starting=client.connectWithHostStart(),rejected=assert.rejects(starting,/disposed/);await began;client.dispose();
  await Promise.race([rejected,new Promise((_resolve,reject)=>{timeout=setTimeout(()=>reject(Error('dispose did not interrupt the three-second grace')),500);})]);
  assert.equal(starts,0);assert.equal(fs.existsSync(path.join(home,'pty-host-auth')),false);
 }finally{clearTimeout(timeout);client.dispose();client.startupCancelled.abort();childProcess.execFile=realExecFile;}
});
test('default grace passes the decreasing remaining deadline to its actual ps caller',async()=>{
 reset();record();const {waitForHostShutdown}=require('../dist-electron/pty-host-start-guard.js'),cancelled=new AbortController(),timeouts=[];let now=0;
 try{
  childProcess.execFileSync=()=>{throw Error('the shutdown grace must not block on ps');};
  childProcess.execFile=(...args)=>{timeouts.push([args[2].timeout,args[2].killSignal]);return realExecFile(...args);};
  await assert.rejects(waitForHostShutdown(path.join(home,'pty-host.sock'),cancelled.signal,{now:()=>now,wait:async()=>{now+=150;if(timeouts.length>=2)cancelled.abort();}}),/cancelled/);
  assert.deepEqual(timeouts,[[3000,'SIGKILL'],[2850,'SIGKILL']]);
 }finally{cancelled.abort();childProcess.execFileSync=execSync;childProcess.execFile=realExecFile;}
});

test('startHost repeats the absence proof after stderr open immediately before fork',()=>{
 reset();const client=new PtyHostClient(path.resolve('dist-electron/pty-host.js'));client.hostAuthKey=Buffer.alloc(32);
 const open=fs.openSync,spawn=childProcess.spawn;let opened=false,spawns=0;
 try{
  fs.openSync=(file,...args)=>{const fd=open(file,...args);if(String(file)===path.join(home,'pty-host.stderr.log')&&!opened){opened=true;record();}return fd;};
  childProcess.spawn=()=>{spawns++;throw Error('fork passed a newly live record');};
  assert.throws(()=>client.startHost(),{code:'PTY_HOST_START_BLOCKED'});assert.equal(opened,true);assert.equal(spawns,0);
 }finally{fs.openSync=open;childProcess.spawn=spawn;client.dispose();reset();}
});

test('failed or empty ps for this still-live fixture cannot reach the cold start branch',async()=>{
 for(const code of ['ENOENT','ECONNREFUSED'])for(const status of [1,2,'empty']){
  reset();record();let starts=0,restore=()=>{};
  const client=new PtyHostClient(path.resolve('dist-electron/pty-host.js'));
  client.openSocket=async()=>{throw Object.assign(Error('fixture socket absent'),{code});};client.startHost=()=>{starts++;throw Error('must not start');};
  try{
   restore=fakePs(()=>{if(status==='empty')return '';throw Object.assign(Error('injected ps nonzero'),{status});});
   await assert.rejects(client.connectWithHostStart(),error=>error.code==='PTY_HOST_START_BLOCKED'&&error.proof.state==='unknown');
   assert.equal(starts,0);assert.doesNotThrow(()=>process.kill(process.pid,0));
  }finally{restore();client.dispose();}
 }
});

// --- the async permit startHost confirms ----------------------------------------------------------------------------

test('the async permit gives the sync proof\'s verdicts, with sync or async probes, and fails closed on a throwing probe',async()=>{
 reset();assert.equal((await hostCreationPermit()).state,'gone');const file=record();
 for(const [info,expected] of [[observation(true,'same'),'alive'],[observation(false,null),'gone'],[observation(true,'other'),'gone'],[observation(false,null,true),'unknown'],[observation(true,null),'unknown']]){
  fs.writeFileSync(file,JSON.stringify({pid:process.pid,pgid:process.pid,startTime:'same'}));
  assert.equal(hostCreationProof(registry,()=>info).state,expected);
  assert.equal((await hostCreationPermit(registry,()=>info)).state,expected);
  assert.equal((await hostCreationPermit(registry,async()=>info)).state,expected);
 }
 assert.equal((await hostCreationPermit(registry,async()=>{throw Error('injected');})).state,'unknown');
 fs.mkdirSync(ownerDir,{mode:0o700});fs.writeFileSync(ownerFile,JSON.stringify({jsPid:process.pid,jsStartTime:'same'}),{mode:0o600});
 assert.equal((await hostCreationPermit(registry,async pid=>pid===process.pid?observation(true,'same'):observation(false,null))).state,'alive');
});
test('failed, empty, timed-out or overflowing async ps keeps a live record unknown',async()=>{
 for(const failure of ['EAGAIN','empty','timeout','maxBuffer']){
  reset();record();const restore=fakePs(()=>{
   if(failure==='empty')return '';
   if(failure==='timeout')throw Object.assign(Error('timed out'),{killed:true,signal:'SIGKILL'});
   if(failure==='maxBuffer')throw Object.assign(Error('stdout maxBuffer length exceeded'),{code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'});
   throw Object.assign(Error('injected'),{code:'EAGAIN'});
  });
  try{const permit=await hostCreationPermit();assert.equal(permit.state,'unknown',failure);assert.equal(permit.confirm().state,'unknown',failure);}
  finally{restore();}
 }
});
test('the permit probe lets the event loop run',async()=>{
 reset();record();let ticks=0;const timer=setInterval(()=>ticks++,1);
 try{const permit=await hostCreationPermit(registry,pid=>new Promise(resolve=>setTimeout(()=>resolve(readProcInfo(pid)),20)));assert.equal(permit.state,'alive');assert.ok(ticks>0);}
 finally{clearInterval(timer);}
});
test('permit.confirm is spawn-free and turns gone into unknown for any new, rewritten or newly present record',async()=>{
 const gone=async()=>{const permit=await hostCreationPermit(registry,async()=>observation(false,null));assert.equal(permit.state,'gone');return permit;};
 const changes={
  'new host record':()=>record(process.pid,'later'),
  'rewritten record':()=>{const file=path.join(registry,'4242.json');const payload=fs.readFileSync(file);fs.unlinkSync(file);fs.writeFileSync(file,payload,{mode:0o600});},
  'registry created':()=>{fs.rmSync(registry,{recursive:true,force:true});fs.mkdirSync(registry,{mode:0o700});},
  'owner directory created':()=>fs.mkdirSync(ownerDir,{mode:0o700}),
  'owner record created':()=>{fs.writeFileSync(ownerFile,JSON.stringify({jsPid:process.pid,jsStartTime:'same'}),{mode:0o600});},
 };
 for(const [name,change] of Object.entries(changes)){
  reset();
  if(name!=='registry created')record(4242,'old');
  if(name==='registry created')fs.rmSync(registry,{recursive:true,force:true});
  if(name==='owner record created')fs.mkdirSync(ownerDir,{mode:0o700});
  const permit=await gone();
  const restore=fakePs(()=>{throw Error('confirm must not spawn ps');});
  try{assert.equal(permit.confirm().state,'gone',`${name}: unchanged`);change();assert.equal(permit.confirm().state,'unknown',name);}
  finally{restore();}
 }
});
test('startHost with a permit confirms after stderr open, right before fork, without a ps',async()=>{
 reset();record(4242,'old');const client=new PtyHostClient(path.resolve('dist-electron/pty-host.js'));client.hostAuthKey=Buffer.alloc(32);
 const permit=await hostCreationPermit(registry,async()=>observation(false,null));assert.equal(permit.state,'gone');
 const open=fs.openSync,spawn=childProcess.spawn;let opened=false,spawns=0;const restore=fakePs(()=>{throw Error('startHost with a permit must not spawn ps');});
 try{
  fs.openSync=(file,...args)=>{const fd=open(file,...args);if(String(file)===path.join(home,'pty-host.stderr.log')&&!opened){opened=true;record(process.pid,'live');}return fd;};
  childProcess.spawn=()=>{spawns++;throw Error('fork passed a newly live record');};
  assert.throws(()=>client.startHost(undefined,permit),error=>error.code==='PTY_HOST_START_BLOCKED'&&error.proof.state==='unknown'&&!('confirm' in error.proof));
  assert.equal(opened,true);assert.equal(spawns,0);
  // Unchanged inventory: confirm passes both checks and the fork is reached in the same synchronous call.
  reset();record(4242,'old');const fresh=await hostCreationPermit(registry,async()=>observation(false,null));
  childProcess.spawn=()=>{spawns++;throw Error('reached fork');};
  assert.throws(()=>client.startHost(undefined,fresh),/reached fork/);assert.equal(spawns,1);
 }finally{fs.openSync=open;childProcess.spawn=spawn;restore();client.dispose();reset();}
});
test('a live host recorded while the cold-start permit probes ps blocks the start before unlink or fork',async()=>{
 reset();const ended=childProcess.spawnSync(process.execPath,['-e','process.exit(0)'],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});record(ended.pid,'old');
 const socket=path.join(home,'pty-host.sock');fs.writeFileSync(socket,'kept');
 const guard=require('../dist-electron/pty-host-start-guard.js'),wait=guard.waitForHostShutdown,spawn=childProcess.spawn;let spawns=0;
 const client=new PtyHostClient(path.resolve('dist-electron/pty-host.js'));
 client.openSocket=async()=>{throw Object.assign(Error('fixture socket absent'),{code:'ENOENT'});};
 const restore=fakePs(()=>{record(process.pid,'live');return '';}); // the ps that reads the old pid answers after a live host recorded itself
 try{
  guard.waitForHostShutdown=async()=>{};childProcess.spawn=()=>{spawns++;throw Error('unexpected fork');};
  await assert.rejects(client.connectWithHostStart(),error=>error.code==='PTY_HOST_START_BLOCKED'&&error.proof.state==='unknown');
  assert.equal(spawns,0);assert.equal(fs.readFileSync(socket,'utf8'),'kept');
 }finally{guard.waitForHostShutdown=wait;childProcess.spawn=spawn;restore();client.dispose();fs.rmSync(socket,{force:true});reset();}
});
