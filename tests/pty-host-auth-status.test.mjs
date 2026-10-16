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
test('auth refusal uses only private retained inventory bound to the observed peer instance',()=>{
 record();const spawn=childProcess.spawn,exec=childProcess.execFileSync;let spawns=0;
 try{
  childProcess.spawn=()=>{spawns++;throw Error('no owner spawn permitted');};
  childProcess.execFileSync=(command,...args)=>{assert.equal(command,'ps','only host identity observation is allowed');return exec(command,...args);};
  const status=refusedHostStatus(peer);
  assert.equal(status.authentication.inventoryKnown,true);assert.equal(status.authentication.targetVerified,true);
  assert.equal(status.ptyCount,2);assert.equal(status.pid,peer.pid);assert.equal(status.startTime,peer.startIdentity);
  assert.deepEqual(status.owner.inventory,[{id:pane.id,pid:pane.pid,startIdentity:pane.startIdentity}]);
  assert.deepEqual(status.owner.uncertain,['pending-pane']);assert.equal(status.owner.instanceId,'b'.repeat(32));assert.equal(spawns,0);
 }finally{childProcess.spawn=spawn;childProcess.execFileSync=exec;}
});
test('absent peer, changed reader or changed kernel instance never turns unknown inventory into empty verified inventory',()=>{
 for(const kind of ['no-peer','reader','kernel']){
  const r=record();if(kind==='reader'){r.jsStartTime='another-start';registry.writeOwnerRecord(r);}
  const status=refusedHostStatus(kind==='no-peer'?null:kind==='kernel'?{...peer,startIdentity:'0:0'}:peer);
  assert.equal(status.authentication.inventoryKnown,false,kind);assert.equal(status.owner,undefined,kind);assert.equal(status.ptyCount,0);
 }
});
test('failed identity probes, including the final check, discard a partially assembled inventory',()=>{
 const probe=ownerClient.ownerProcessStartIdentity;
 try{
  for(const failAt of [1,2]){
   record();let calls=0;ownerClient.ownerProcessStartIdentity=(pid)=>{if(++calls===failAt)throw Error('injected identity failure');return probe(pid);};
   const status=refusedHostStatus(peer);assert.equal(status.authentication.inventoryKnown,false);assert.equal(status.authentication.targetVerified,false);assert.equal(status.owner,undefined);
  }
 }finally{ownerClient.ownerProcessStartIdentity=probe;}
});
test('legacy private host record can verify a target but cannot supply a fabricated pane inventory',()=>{
 fs.rmSync(path.dirname(file),{recursive:true,force:true});
 const directory=path.join(home,'pty-hosts');fs.mkdirSync(directory,{mode:0o700,recursive:true});
 fs.writeFileSync(path.join(directory,`${peer.pid}.json`),JSON.stringify({pid:peer.pid,pgid:peer.pid,startTime:hostRegistry.readProcInfo(peer.pid).startTime}),{mode:0o600});
 const status=refusedHostStatus(peer);assert.equal(status.authentication.targetVerified,true);assert.equal(status.authentication.inventoryKnown,false);assert.equal(status.owner,undefined);
 fs.rmSync(directory,{recursive:true,force:true});
});
test('retained owner records refuse symlinks, oversized files and broad permissions without reading an unsafe payload',()=>{
 for(const kind of ['symlink','oversize','permissions']){
  record();
  if(kind==='symlink'){fs.renameSync(file,file+'.real');fs.symlinkSync(file+'.real',file);}
  if(kind==='oversize')fs.truncateSync(file,65537);
  if(kind==='permissions')fs.chmodSync(file,0o644);
  assert.throws(()=>registry.readOwnerRecord(),undefined,kind);
  const status=refusedHostStatus(peer);assert.equal(status.authentication.inventoryKnown,false,kind);assert.equal(status.owner,undefined,kind);
 }
});
test('a FIFO record is promptly refused instead of blocking a question indefinitely',()=>{
 record();fs.unlinkSync(file);childProcess.execFileSync('/usr/bin/mkfifo',[file]);fs.chmodSync(file,0o600);
 const script=`const {readOwnerRecord}=require('./dist-electron/pty-owner-registry.js');try{readOwnerRecord();process.exit(2)}catch(e){if(!String(e).includes('not private'))throw e;}`;
 const result=childProcess.spawnSync(process.execPath,['-e',script],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},timeout:1500,encoding:'utf8'});
 assert.equal(result.error,undefined,String(result.error));assert.equal(result.status,0,result.stderr);assert.equal(fs.lstatSync(file).isFIFO(),true);
});
