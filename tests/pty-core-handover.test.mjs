import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {cleanupNativeOwner} from './helpers/pty-host.mjs';
for(const variant of ['osc','vt','utf8','abort','exit-gap','prepare-abort','prepare-success','mount-now','mount-late','mount-trim','mount-empty','mount-legacy-modes','exit-late','dropped-view'])test(`real PTY core handover preserves ${variant} and gates every producer`,{timeout:20000},async()=>{
 fs.mkdirSync('test-results',{recursive:true});const home=fs.mkdtempSync(path.resolve('test-results/core-handover-')),key=randomBytes(32),children=[];
 async function reader(mode){
  const child=spawn(process.execPath,['tests/helpers/pty-core-handover.cjs',mode,variant==='abort'?'vt':variant],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',AYA_HOME:home,HOME:home,AYA_PTY_OWNER_FD:'3'},stdio:['ignore','ignore','pipe','pipe','ipc']});children.push(child);
  child.stdio[3].on('error',()=>{});child.stdio[3].end(key);
  let error='',message;child.stderr.on('data',b=>{error+=b;});child.on('message',m=>{message=m;});
  return new Promise((resolve,reject)=>{let exit,gone=false;const settle=()=>{if(!exit||!gone)return;const[code,signal]=exit;code===0&&message?resolve(message):reject(Error(`${mode} failed ${code}/${signal}: ${error}`));};child.on('exit',(code,signal)=>{exit=[code,signal];settle();});/* 'exit' can beat the last IPC message: settle once the channel has closed too */child.on('disconnect',()=>{gone=true;settle();});});
 }
 try{
  const old=await reader(variant==='abort'?'abort':'old');
  if(variant.startsWith('prepare-')){assert.equal(old.preparation,true);return;}
  if(variant==='abort'){assert.equal(old.aborted,true);return;}
  if(variant==='exit-gap'){
   fs.writeFileSync(path.join(home,'release'),'go');const deadline=Date.now()+5000;
   for(;;){let alive=true;try{process.kill(old.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;else throw e;}if(!alive)break;if(Date.now()>deadline)throw Error('child did not exit during core handover gap');await new Promise(r=>setTimeout(r,2));}
  }
  // Awaiting exit is the essential lease boundary: no successor while old JS lives.
  const next=await reader('new');assert.equal(next.pid,old.pid);assert.equal(next.ownerPid,old.ownerPid);assert.equal(next.exits,1);
 }finally{for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await cleanupNativeOwner(home);fs.rmSync(home,{recursive:true,force:true});}
});
