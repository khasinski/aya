import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
fs.mkdirSync('test-results',{recursive:true});
const home=fs.mkdtempSync(path.resolve('test-results/auth-status-'));
process.env.AYA_HOME=home;process.env.HOME=home;
const registry=require('../dist-electron/pty-owner-registry.js');
const hostRegistry=require('../dist-electron/pty-host-registry.js');
const ownerClient=require('../dist-electron/pty-owner-client.js');
const {refusedHostStatus}=require('../dist-electron/pty-host-auth-status.js');
const peer={pid:process.pid,startIdentity:ownerClient.ownerProcessStartIdentity(process.pid)};
const file=path.join(home,'pty-owner','record.json');
const pane={id:'kept-pane',pid:32123,startIdentity:'1:2',generation:1,cols:80,rows:24,exited:false,acknowledged:false,exitCode:null,signal:0,event:0};
function record(){
 fs.rmSync(path.dirname(file),{recursive:true,force:true});registry.prepareOwnerDirectory();
 const r={pid:32122,startTime:'owner-start',executable:'/private/owner',binaryHash:'a'.repeat(64),instanceId:'b'.repeat(32),jsPid:peer.pid,jsStartTime:hostRegistry.readProcInfo(peer.pid).startTime,panes:[pane],spawnIntents:[{id:'pending-pane',generation:'c'.repeat(32)}]};
 registry.writeOwnerRecord(r);return r;
}
after(()=>fs.rmSync(home,{recursive:true,force:true}));
test('auth refusal uses only private retained inventory bound to the observed peer instance',async()=>{
 record();const spawn=childProcess.spawn,exec=childProcess.execFileSync,execAsync=childProcess.execFile;let spawns=0;
 try{
  childProcess.spawn=()=>{spawns++;throw Error('no owner spawn permitted');};
  childProcess.execFileSync=()=>{throw Error('the refused-host status must not block on ps');};
  childProcess.execFile=(command,...args)=>{assert.equal(command,'ps','only host identity observation is allowed');return execAsync(command,...args);};
  const status=await refusedHostStatus(peer);
  assert.equal(status.authentication.inventoryKnown,true);assert.equal(status.authentication.targetVerified,true);
  assert.equal(status.ptyCount,2);assert.equal(status.pid,peer.pid);assert.equal(status.startTime,peer.startIdentity);
  assert.deepEqual(status.owner.inventory,[{id:pane.id,pid:pane.pid,startIdentity:pane.startIdentity}]);
  assert.deepEqual(status.owner.uncertain,['pending-pane']);assert.equal(status.owner.instanceId,'b'.repeat(32));assert.equal(spawns,0);
 }finally{childProcess.spawn=spawn;childProcess.execFileSync=exec;childProcess.execFile=execAsync;}
});
test('absent peer, changed reader or changed kernel instance never turns unknown inventory into empty verified inventory',async()=>{
 for(const kind of ['no-peer','reader','kernel']){
  const r=record();if(kind==='reader'){r.jsStartTime='another-start';registry.writeOwnerRecord(r);}
  const status=await refusedHostStatus(kind==='no-peer'?null:kind==='kernel'?{...peer,startIdentity:'0:0'}:peer);
  assert.equal(status.authentication.inventoryKnown,false,kind);assert.equal(status.owner,undefined,kind);assert.equal(status.ptyCount,0);
 }
});
test('failed identity probes, including the final check, discard a partially assembled inventory',async()=>{
 const probe=ownerClient.ownerProcessStartIdentity;
 try{
  for(const failAt of [1,2,3]){
   record();let calls=0;ownerClient.ownerProcessStartIdentity=(pid)=>{if(++calls===failAt)throw Error('injected identity failure');return probe(pid);};
   const status=await refusedHostStatus(peer);assert.equal(status.authentication.inventoryKnown,false,`identity probe ${failAt}`);assert.equal(status.authentication.targetVerified,false);assert.equal(status.owner,undefined);
  }
 }finally{ownerClient.ownerProcessStartIdentity=probe;}
});
test('legacy private host record can verify a target but cannot supply a fabricated pane inventory',async()=>{
 fs.rmSync(path.dirname(file),{recursive:true,force:true});
 const directory=path.join(home,'pty-hosts');fs.mkdirSync(directory,{mode:0o700,recursive:true});
 fs.writeFileSync(path.join(directory,`${peer.pid}.json`),JSON.stringify({pid:peer.pid,pgid:peer.pid,startTime:hostRegistry.readProcInfo(peer.pid).startTime}),{mode:0o600});
 const status=await refusedHostStatus(peer);assert.equal(status.authentication.targetVerified,true);assert.equal(status.authentication.inventoryKnown,false);assert.equal(status.owner,undefined);
 fs.rmSync(directory,{recursive:true,force:true});
});
test('retained owner records refuse symlinks and broad permissions without reading an unsafe payload',async()=>{
 for(const kind of ['symlink','permissions']){
  record();
  if(kind==='symlink'){fs.renameSync(file,file+'.real');fs.symlinkSync(file+'.real',file);}
  if(kind==='permissions')fs.chmodSync(file,0o644);
  assert.throws(()=>registry.readOwnerRecord(),undefined,kind);
  const status=await refusedHostStatus(peer);assert.equal(status.authentication.inventoryKnown,false,kind);assert.equal(status.owner,undefined,kind);
 }
});
test('a FIFO record is promptly refused instead of blocking a question indefinitely',()=>{
 record();fs.unlinkSync(file);childProcess.execFileSync('/usr/bin/mkfifo',[file]);fs.chmodSync(file,0o600);
 const script=`const {readOwnerRecord}=require('./dist-electron/pty-owner-registry.js');try{readOwnerRecord();process.exit(2)}catch(e){if(!String(e).includes('not private'))throw e;}`;
 const result=childProcess.spawnSync(process.execPath,['-e',script],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},timeout:1500,encoding:'utf8'});
 assert.equal(result.error,undefined,String(result.error));assert.equal(result.status,0,result.stderr);assert.equal(fs.lstatSync(file).isFIFO(),true);
});

test('retained record cap accepts exactly 64KiB valid JSON and refuses 64KiB+1 before reading or parsing',()=>{
 const r=record(),base={...r,padding:''},overhead=Buffer.byteLength(JSON.stringify(base));
 const payload=size=>JSON.stringify({...base,padding:'x'.repeat(size-overhead)});
 fs.writeFileSync(file,payload(65536));assert.equal(fs.statSync(file).size,65536);assert.deepEqual(registry.readOwnerRecord().panes,[pane]);
 fs.writeFileSync(file,payload(65537));assert.equal(fs.statSync(file).size,65537);
 const read=fs.readSync,parse=JSON.parse;let reads=0,parses=0;
 try{
  fs.readSync=(...args)=>{reads++;return read(...args);};JSON.parse=(...args)=>{parses++;return parse(...args);};
  assert.throws(()=>registry.readOwnerRecord(),/PTY owner record is not private/);
  assert.equal(reads,0);assert.equal(parses,0);
 }finally{fs.readSync=read;JSON.parse=parse;}
});

test('legacy owner kernel identity stays absent and malformed or overlong identities refuse the record',()=>{
 record();assert.equal(registry.readOwnerRecord().startIdentity,undefined);
 for(const identity of ['unknown','1:2'.repeat(32),123,null]){const r=record();r.startIdentity=identity;registry.writeOwnerRecord(r);assert.throws(()=>registry.readOwnerRecord());}
 const r=record();r.startIdentity='123:456';registry.writeOwnerRecord(r);assert.equal(registry.readOwnerRecord().startIdentity,'123:456');
});
test('writer refuses an over-limit retained record before replacing the prior inventory',()=>{
 const r=record(),before=fs.readFileSync(file);
 assert.throws(()=>registry.writeOwnerRecord({...r,padding:'x'.repeat(65536)}),/record length limit/);
 assert.deepEqual(fs.readFileSync(file),before);
 assert.deepEqual(fs.readdirSync(path.dirname(file)),['record.json']);
});

test('the refused-host probe lets the event loop run, and a peer replaced while ps ran verifies nothing',async()=>{
 const execAsync=childProcess.execFile,probe=ownerClient.ownerProcessStartIdentity;let ticks=0,swapDuringPs=false,replaced=false;
 const timer=setInterval(()=>ticks++,1);
 try{
  // The real ps, answered 20 ms late; with swapDuringPs the peer pid gets another kernel identity meanwhile.
  childProcess.execFile=(command,args,options,callback)=>execAsync(command,args,options,(...result)=>setTimeout(()=>{if(swapDuringPs)replaced=true;callback(...result);},20));
  ownerClient.ownerProcessStartIdentity=pid=>replaced&&pid===peer.pid?'9:9':probe(pid);
  record();const status=await refusedHostStatus(peer);
  assert.ok(ticks>0,'timers ran while ps was outstanding');
  assert.equal(status.authentication.targetVerified,true);assert.equal(status.authentication.inventoryKnown,true);
  record();swapDuringPs=true;const swapped=await refusedHostStatus(peer);
  assert.equal(replaced,true);assert.equal(swapped.authentication.targetVerified,false);assert.equal(swapped.authentication.inventoryKnown,false);assert.equal(swapped.owner,undefined);
 }finally{clearInterval(timer);childProcess.execFile=execAsync;ownerClient.ownerProcessStartIdentity=probe;}
});
test('failed, empty or timed-out refused-host ps never verifies a target',async()=>{
 const execAsync=childProcess.execFile;
 try{
  for(const outcome of ['error','empty','timeout']){
   record();
   childProcess.execFile=(_command,_args,_options,callback)=>{setImmediate(()=>outcome==='empty'?callback(null,'',''):callback(Object.assign(Error(outcome),outcome==='timeout'?{killed:true,signal:'SIGKILL'}:{code:'EAGAIN'}),'',''));return {pid:0};};
   const status=await refusedHostStatus(peer);
   assert.equal(status.authentication.targetVerified,false,outcome);assert.equal(status.authentication.inventoryKnown,false,outcome);assert.equal(status.owner,undefined,outcome);
  }
 }finally{childProcess.execFile=execAsync;}
});
